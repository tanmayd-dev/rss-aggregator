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
export const BACKOFF_BASE_MINUTES = 5;
export const BACKOFF_MAX_MINUTES = 60;
export const RUN_RETENTION_DAYS = 7;

export function maxPerTick(): number {
  const parsed = parseInt(process.env.REFRESH_MAX_PER_TICK ?? '', 10);
  if (Number.isNaN(parsed) || parsed < MIN_PER_TICK) return DEFAULT_MAX_PER_TICK;
  return parsed;
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

export interface SchedulableSource {
  lastFetched: Date | null;
  nextRefreshAt: Date | null;
}

/**
 * Slot for a source when the feed is (re)balanced: sources added, removed or a TTL
 * change shift everyone's phase. A source is never scheduled sooner than its fair
 * share after its last success, and never later than its TTL deadline.
 */
export function computeNextRefreshAt(
  source: Pick<SchedulableSource, 'lastFetched'>,
  index: number,
  count: number,
  ttlMinutes: number,
  now: Date = new Date()
): Date {
  if (ttlMinutes <= 0) {
    return new Date(now.getTime() + effectiveTtl(ttlMinutes) * 60_000);
  }

  // Never-fetched sources are due immediately so a failed seed gets retried.
  if (!source.lastFetched) {
    return now;
  }

  const nowMs = now.getTime();
  const lastFetchedMs = source.lastFetched.getTime();
  const minIntervalMs = minSourceIntervalMinutes(ttlMinutes, count) * 60_000;
  // Allow snapping to a slot up to one tick early so sources stay on the 5-minute
  // grid instead of drifting to arbitrary "last fetch + ttl" timestamps.
  const earliest = Math.max(
    nowMs,
    lastFetchedMs + minIntervalMs - TICK_INTERVAL_MINUTES * 60_000
  );

  let candidate = nextSlotAtOrAfter(earliest, index, count, ttlMinutes);
  const deadline = lastFetchedMs + effectiveTtl(ttlMinutes) * 60_000;
  if (candidate > deadline) {
    // Never let a source exceed its TTL: fall back to the TTL deadline, rounded down
    // to the tick grid (fetching slightly early beats serving stale data).
    const tickMs = TICK_INTERVAL_MINUTES * 60_000;
    candidate = Math.max(nowMs, Math.floor(deadline / tickMs) * tickMs);
  }

  return new Date(candidate);
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
 * Adaptive tick budget: the previous tick's actual work grows by 1.5x (so a backlog
 * drains) but never drops below MIN_PER_TICK or exceeds the hard ceiling.
 */
export function nextBudget(previousAttempted: number | null | undefined): number {
  if (previousAttempted === null || previousAttempted === undefined) return MIN_PER_TICK;
  return Math.min(
    maxPerTick(),
    Math.max(MIN_PER_TICK, Math.ceil(previousAttempted * 1.5))
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
