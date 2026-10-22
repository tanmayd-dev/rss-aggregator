import { FeedSource } from '@prisma/client';

/**
 * Per-source refresh scheduling.
 *
 * Every feed has a TTL `T` (minutes). Its sources are spread evenly across that TTL
 * window: source `i` of `N` owns the slot `floor(i * S / N)` where `S` is the number of
 * 5-minute slots in a window. Windows tile from the Unix epoch, so TTLs that divide
 * 24h (5/15/30/60/720) land on clean UTC clock boundaries — a 1h feed refreshes its
 * sources at xx:00, xx:05, ... xx:55.
 *
 * The cron tick runs every 5 minutes, so 5 minutes is both the slot granularity and the
 * minimum gap between two refreshes of the same source. TTLs below 5 are effectively 5.
 */

export const TICK_INTERVAL_MINUTES = 5;
export const MIN_PER_TICK = 4;
export const DEFAULT_MAX_PER_TICK = 64;
/**
 * How fast the adaptive budget grows after a backlog. A gentler multiplier keeps a
 * post-downtime catch-up from hammering many sources at once.
 */
export const DEFAULT_BUDGET_GROWTH = 1.25;
export const BACKOFF_BASE_MINUTES = 5;
export const BACKOFF_MAX_MINUTES = 60;
export const RUN_RETENTION_DAYS = 7;

export function maxPerTick(): number {
  const parsed = parseInt(process.env.REFRESH_MAX_PER_TICK ?? '', 10);
  if (Number.isNaN(parsed) || parsed < MIN_PER_TICK) return DEFAULT_MAX_PER_TICK;
  return parsed;
}

/** Multiplier applied to the previous tick's attempted count. */
export function budgetGrowth(): number {
  const parsed = parseFloat(process.env.REFRESH_BUDGET_GROWTH ?? '');
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_BUDGET_GROWTH;
}

/** Shortest TTL the scheduler can honor given the 5-minute tick. */
export function effectiveTtl(ttlMinutes: number): number {
  return Math.max(TICK_INTERVAL_MINUTES, ttlMinutes);
}

/** Number of 5-minute slots in one TTL window. */
export function slotsPerWindow(ttlMinutes: number): number {
  return Math.max(1, Math.floor(effectiveTtl(ttlMinutes) / TICK_INTERVAL_MINUTES));
}

/** Evenly spread slot index for source `index` of `count` sources. */
export function slotIndex(index: number, count: number, ttlMinutes: number): number {
  const slots = slotsPerWindow(ttlMinutes);
  const n = Math.max(1, count);
  return Math.min(slots - 1, Math.floor((index * slots) / n));
}

/** Earliest slot timestamp >= `afterMs` for a given source position. */
export function nextSlotAtOrAfter(
  afterMs: number,
  index: number,
  count: number,
  ttlMinutes: number
): number {
  const ttl = effectiveTtl(ttlMinutes);
  const slot = slotIndex(index, count, ttl);
  const MS_PER_MINUTE = 60_000;
  const windowMs = ttl * MS_PER_MINUTE;
  const windowStart = Math.floor(afterMs / windowMs) * windowMs;
  let candidate = windowStart + slot * TICK_INTERVAL_MINUTES * MS_PER_MINUTE;
  if (candidate < afterMs) candidate += windowMs;
  return candidate;
}

/** Minimum spacing between refreshes of one source: its fair share of the TTL. */
export function minSourceIntervalMinutes(ttlMinutes: number, count: number): number {
  return Math.max(TICK_INTERVAL_MINUTES, effectiveTtl(ttlMinutes) / Math.max(1, count));
}

export interface RebalanceSource {
  id: string;
  createdAt: Date;
  lastFetched: Date | null;
}

/**
 * Assign every source of a feed its next refresh time.
 *
 * Sources still comfortably inside their TTL keep their canonical slot, so they stay
 * evenly spread and clock-aligned. Sources whose own slot would land past their TTL
 * deadline are caught up on the earliest free 5-minute ticks instead of all being
 * clamped onto the same deadline — which would create a burst every time a feed is
 * edited or the server comes back from downtime. After the catch-up fetch, a source
 * re-anchors to its canonical phase via nextRefreshAfterFetch().
 */
export function planRebalance(
  sources: RebalanceSource[],
  ttlMinutes: number,
  now: Date = new Date()
): Map<string, Date | null> {
  const plan = new Map<string, Date | null>();

  if (ttlMinutes <= 0) {
    for (const source of sources) plan.set(source.id, null);
    return plan;
  }

  const ordered = orderSources(sources);
  const count = ordered.length;
  const ttl = effectiveTtl(ttlMinutes);
  const ttlMs = ttl * 60_000;
  const tickMs = TICK_INTERVAL_MINUTES * 60_000;
  const nowMs = now.getTime();

  const taken = new Set<number>();
  const overdue: {
    source: RebalanceSource;
    earliest: number;
    deadline: number;
    createdAt: number;
  }[] = [];

  ordered.forEach((source, index) => {
    // A never-fetched source is due immediately so seeding cannot wait a whole TTL.
    if (!source.lastFetched) {
      plan.set(source.id, now);
      return;
    }

    const lastFetchedMs = source.lastFetched.getTime();
    const deadline = lastFetchedMs + ttlMs;
    const minIntervalMs = minSourceIntervalMinutes(ttlMinutes, count) * 60_000;
    // Allow snapping one tick early so slots stay on the 5-minute grid.
    const earliest = Math.max(nowMs, lastFetchedMs + minIntervalMs - tickMs);
    const preferred = nextSlotAtOrAfter(nowMs, index, count, ttlMinutes);

    if (preferred >= earliest && preferred <= deadline) {
      let slot = preferred;
      // Feeds with more sources than slots share a slot; push duplicates to the next
      // window instead of dropping them.
      while (taken.has(slot)) slot += ttlMs;
      taken.add(slot);
      plan.set(source.id, new Date(slot));
      return;
    }

    overdue.push({ source, earliest, deadline, createdAt: source.createdAt.getTime() });
  });

  overdue
    .sort(
      (a, b) =>
        a.deadline - b.deadline ||
        a.createdAt - b.createdAt ||
        a.source.id.localeCompare(b.source.id)
    )
    .forEach(({ source, earliest }) => {
      let slot = Math.ceil(Math.max(nowMs, earliest) / tickMs) * tickMs;
      while (taken.has(slot)) slot += tickMs;
      taken.add(slot);
      plan.set(source.id, new Date(slot));
    });

  return plan;
}

/** Slot for a source that was just fetched successfully (strictly after `now`). */
export function nextRefreshAfterFetch(
  index: number,
  count: number,
  ttlMinutes: number,
  now: Date = new Date()
): Date {
  return new Date(nextSlotAtOrAfter(now.getTime() + 1, index, count, ttlMinutes));
}

/** Exponential backoff for a failing source, capped at min(TTL, 60 minutes). */
export function backoffMinutes(consecutiveFailures: number, ttlMinutes: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const exponential = BACKOFF_BASE_MINUTES * 2 ** exponent;
  const cap =
    ttlMinutes > 0
      ? Math.min(effectiveTtl(ttlMinutes), BACKOFF_MAX_MINUTES)
      : BACKOFF_MAX_MINUTES;
  return Math.max(TICK_INTERVAL_MINUTES, Math.min(exponential, cap));
}

/**
 * Adaptive tick budget: the previous tick's actual work grows by
 * `REFRESH_BUDGET_GROWTH` (default 1.25x) so a backlog drains gradually, while
 * normal ticks stay small. Never drops below MIN_PER_TICK or exceeds the ceiling.
 */
export function nextBudget(previousAttempted: number | null | undefined): number {
  if (previousAttempted === null || previousAttempted === undefined) return MIN_PER_TICK;
  return Math.min(
    maxPerTick(),
    Math.max(MIN_PER_TICK, Math.ceil(previousAttempted * budgetGrowth()))
  );
}

/** Stable scheduling order for a feed's sources. */
export function orderSources<T extends { createdAt: Date; id: string }>(sources: T[]): T[] {
  return [...sources].sort((a, b) => {
    const delta = a.createdAt.getTime() - b.createdAt.getTime();
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });
}

/** Host key used to serialize same-host fetches inside one tick. */
export function sourceHost(source: Pick<FeedSource, 'type' | 'url' | 'resolvedUrl'>): string {
  const candidate = source.resolvedUrl || source.url || '';
  try {
    return new URL(candidate).host.toLowerCase();
  } catch {
    // Reddit handles ("r/programming") and raw channel names have no host.
    return `${source.type}:${candidate.toLowerCase()}`;
  }
}
