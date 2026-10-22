import { Feed, FeedItem, FeedSource } from '@prisma/client';
import { prisma } from './db.js';
import * as scraper from './scraper.js';
import { HtmlConfig, FourChanConfig, ScrapedFeedItem } from '../types.js';
import {
  backoffMinutes,
  nextBudget,
  nextRefreshAfterFetch,
  orderSources,
  planRebalance,
  sourceHost,
  effectiveTtl,
  RUN_RETENTION_DAYS,
} from './scheduler.js';
import {
  botCooldownMinutes,
  coolingMinutesLeft,
  isCooling,
  isBotFlagError,
  recordBotFlag,
} from './botGuard.js';

export interface UpdateFeedOptions {
  /** Always re-fetch every source, ignoring TTL (explicit force refresh). */
  force?: boolean;
  /** TTL auto-refresh disabled: only fetch sources that have never been fetched. */
  disabled?: boolean;
}

export interface RefreshOutcome {
  feed: Feed & { sources: FeedSource[]; items: (FeedItem & { source: FeedSource | null })[] };
  /** True when at least one source was actually fetched in this run. */
  refreshed: boolean;
  fetchedSources: number;
  failedSources: number;
}

export interface SourceFetchOutcome {
  sourceId: string;
  feedId: string;
  fetched: boolean;
  failed: boolean;
  itemCount: number;
  error?: string;
  /** Set when the fetch was skipped because the host is in a botGuard cooldown. */
  deferred?: true;
}

export interface TickSourceResult extends SourceFetchOutcome {
  feedName: string;
  type: string;
}

export interface RefreshTickResult {
  runId?: string;
  budget: number;
  due: number;
  attempted: number;
  succeeded: number;
  failed: number;
  /** Sources skipped because their host is in a botGuard cooldown. */
  deferred: number;
  durationMs: number;
  dryRun: boolean;
  results: TickSourceResult[];
}

function ageInMinutes(from: Date, now: Date): number {
  return (now.getTime() - from.getTime()) / (1000 * 60);
}

/**
 * Whether a source is due for an automatic refresh. Sources are scheduled by
 * `nextRefreshAt`; the fallback (legacy rows / TTL-0 feeds) keeps the old
 * `lastFetched + ttl` semantics.
 */
export function isSourceStale(
  source: Pick<FeedSource, 'lastFetched'> & { nextRefreshAt?: Date | null },
  ttlMinutes: number,
  now: Date = new Date(),
  disabled = false
): boolean {
  if (disabled) {
    return !source.lastFetched;
  }
  // A TTL of 0 outside disabled mode means "always fetch" (explicit on-demand refresh).
  if (ttlMinutes <= 0) {
    return true;
  }
  if (source.nextRefreshAt) {
    return source.nextRefreshAt.getTime() <= now.getTime();
  }
  if (!source.lastFetched) {
    return true;
  }
  return ageInMinutes(source.lastFetched, now) >= effectiveTtl(ttlMinutes);
}

/**
 * Whether a feed has anything worth refreshing. Used by the API to report staleness
 * via headers; the cron tick works per source, not per feed.
 */
export function isFeedStale(
  feed: Pick<Feed, 'ttl' | 'lastFetched'> & {
    sources: (Pick<FeedSource, 'lastFetched'> & { nextRefreshAt?: Date | null })[];
  },
  now: Date = new Date()
): boolean {
  // TTL 0: no automatic refresh, but report never-fetched sources as stale.
  if (feed.ttl === 0) {
    return feed.sources.some((source) => !source.lastFetched);
  }

  if (feed.sources.length === 0) {
    if (!feed.lastFetched) return true;
    return ageInMinutes(feed.lastFetched, now) >= feed.ttl;
  }

  return feed.sources.some((source) => isSourceStale(source, feed.ttl, now));
}

/**
 * Stable dedup key for a source. Two sources are considered the same when they share
 * type, normalized URL and config, so duplicate rows in one feed are fetched only once.
 */
function buildSourceDedupKey(source: FeedSource): string {
  const url = (source.url || '').trim().replace(/\/+$/, '');
  let configStr = '';
  if (source.config) {
    try {
      const parsed = JSON.parse(source.config);
      const sorted: Record<string, any> = {};
      for (const key of Object.keys(parsed).sort()) {
        sorted[key] = parsed[key];
      }
      configStr = JSON.stringify(sorted);
    } catch {
      configStr = source.config;
    }
  }
  return `${source.type}|${url}|${configStr}`;
}

/** Network/scrape work for one source. Throws on failure. */
async function fetchSourceItems(
  source: FeedSource,
  feedId: string
): Promise<{ items: ScrapedFeedItem[]; resolvedUrl: string | null }> {
  let resolvedUrl = source.resolvedUrl;
  let items: ScrapedFeedItem[] = [];

  switch (source.type) {
    case 'rss': {
      resolvedUrl = source.url;
      const rssParser = new (await import('rss-parser')).default();
      const rssFeed = await rssParser.parseURL(source.url);
      items = rssFeed.items.map((item) => ({
        title: item.title || 'Untitled Post',
        link: item.link || '',
        description: item.content || item.contentSnippet || '',
        pubDate: item.pubDate ? new Date(item.pubDate) : new Date(),
        guid: item.guid || item.link || '',
      }));
      break;
    }

    case 'html': {
      resolvedUrl = source.url;
      if (!source.config) throw new Error('HTML feed configuration missing');
      const htmlConfig: HtmlConfig = JSON.parse(source.config);
      items = await scraper.scrapeHtml(source.url, htmlConfig);
      break;
    }

    case 'reddit': {
      if (!resolvedUrl) {
        let sub = source.url.trim();
        const rMatch = sub.match(/reddit\.com\/r\/([a-zA-Z0-9_]+)/i);
        if (rMatch) {
          sub = `r/${rMatch[1]}`;
        } else if (!sub.startsWith('r/')) {
          sub = `r/${sub}`;
        }
        resolvedUrl = `https://www.reddit.com/${sub}/.rss`;
      }
      items = await scraper.fetchRedditRss(resolvedUrl);
      break;
    }

    case 'youtube': {
      if (!resolvedUrl) {
        const resolved = await scraper.resolveYoutubeChannel(source.url);
        resolvedUrl = resolved.resolvedUrl;
      }

      const rawYtItems = await scraper.fetchYoutubeRss(resolvedUrl);
      // The feed link decides the Shorts flag offline: Shorts point at /shorts/<id>,
      // regular videos at /watch?v=<id>. Only ambiguous legacy links fall back to the
      // network probe (capped concurrency), which is skipped entirely while the host is
      // cooling down so a bot-flagged host is never probed and never caches a wrong
      // value (undetermined items just omit the flag until a later refresh).
      const allowShortChecks = !isCooling(sourceHost(source));
      items = await scraper.mapLimit(rawYtItems, 3, async (rawItem) => {
        const videoId = rawItem.extraMetadata?.videoId;
        if (!videoId) {
          return rawItem;
        }
        const isShort = await scraper.determineYoutubeShortFlag(
          { videoId, link: rawItem.link },
          { allowNetwork: allowShortChecks }
        );
        if (isShort === undefined) {
          return rawItem; // leave extraMetadata untouched (no isShort guess)
        }
        return {
          ...rawItem,
          extraMetadata: {
            ...rawItem.extraMetadata,
            isShort,
          },
        };
      });
      break;
    }

    case 'fourchan': {
      if (!source.config) throw new Error('4chan feed configuration missing');
      const chanConfig: FourChanConfig = JSON.parse(source.config);
      const board = chanConfig.board;
      const query = chanConfig.query;
      const topN = chanConfig.topN || 10;
      resolvedUrl = `https://a.4cdn.org/${board}/catalog.json`;
      items = await scraper.fetchFourChanFeed(board, query, topN);
      break;
    }

    default:
      throw new Error(`Unsupported source type: ${source.type}`);
  }

  return { items, resolvedUrl };
}

/** Persist scraped items and mark the source as successfully refreshed. */
async function saveSuccess(
  source: FeedSource,
  feedId: string,
  ttlMinutes: number,
  index: number,
  count: number,
  now: Date,
  items: ScrapedFeedItem[],
  resolvedUrl: string | null
): Promise<void> {
  for (const item of items) {
    await prisma.feedItem.upsert({
      where: {
        feedId_link: {
          feedId,
          link: item.link,
        },
      },
      create: {
        feedId,
        sourceId: source.id,
        title: item.title,
        link: item.link,
        description: item.description,
        pubDate: item.pubDate,
        guid: item.guid,
        extraMetadata: item.extraMetadata ? JSON.stringify(item.extraMetadata) : null,
      },
      update: {
        sourceId: source.id,
        title: item.title,
        description: item.description,
        pubDate: item.pubDate,
        guid: item.guid,
        extraMetadata: item.extraMetadata ? JSON.stringify(item.extraMetadata) : null,
      },
    });
  }

  const nextRefreshAt =
    ttlMinutes > 0 ? nextRefreshAfterFetch(index, count, ttlMinutes, now) : null;

  await prisma.feedSource.update({
    where: { id: source.id },
    data: {
      lastFetched: now,
      lastAttemptAt: now,
      consecutiveFailures: 0,
      lastError: null,
      nextRefreshAt,
      resolvedUrl,
    },
  });

  await prisma.feed.update({
    where: { id: feedId },
    data: { lastFetched: now },
  });
}

/** Record a failed attempt and schedule an exponential-backoff retry. */
async function saveFailure(
  source: FeedSource,
  ttlMinutes: number,
  now: Date,
  error: unknown
): Promise<void> {
  const failures = source.consecutiveFailures + 1;
  const message =
    error instanceof Error ? error.message : error ? String(error) : 'Unknown error';
  const host = sourceHost(source);
  const botFlagged = isBotFlagError(error);
  if (botFlagged) {
    // Google/YouTube bot-mitigation page: pause the whole host so the flag can cool
    // down instead of re-confirming it every 5 minutes.
    recordBotFlag(host, now.getTime());
  }

  let nextRefreshAt: Date | null = null;
  if (ttlMinutes > 0) {
    let waitMs = backoffMinutes(failures, ttlMinutes) * 60_000;
    if (botFlagged) {
      waitMs = Math.max(waitMs, botCooldownMinutes() * 60_000);
    }
    nextRefreshAt = new Date(now.getTime() + waitMs);
  }

  await prisma.feedSource.update({
    where: { id: source.id },
    data: {
      lastAttemptAt: now,
      consecutiveFailures: failures,
      lastError: `${message}${botFlagged ? ' [Google bot-flag page]' : ''}`.slice(0, 500),
      nextRefreshAt,
    },
  });
}

/**
 * Fetch one source and update it + its feed. Never throws: failures are recorded on
 * the source so a failing host is retried with backoff instead of every tick.
 */
async function refreshOneSource(
  source: FeedSource,
  feedId: string,
  ttlMinutes: number,
  index: number,
  count: number,
  now: Date,
  dedupCache?: Map<string, { items: ScrapedFeedItem[]; resolvedUrl: string | null }>
): Promise<SourceFetchOutcome> {
  const host = sourceHost(source);
  // While a host is cooling down after a bot-flag response, skip its sources quietly:
  // they stay due (and visible on the dashboard) but no request is sent to the host,
  // which lets the flag expire instead of re-confirming it every few minutes.
  if (isCooling(host, now.getTime())) {
    return {
      sourceId: source.id,
      feedId,
      fetched: false,
      failed: false,
      deferred: true,
      itemCount: 0,
      error: `${host} cooling down (bot-flag) for ~${coolingMinutesLeft(
        host,
        now.getTime()
      )} more min`,
    };
  }

  const dedupKey = buildSourceDedupKey(source);
  const cached = dedupKey ? dedupCache?.get(dedupKey) : undefined;

  try {
    let items: ScrapedFeedItem[];
    let resolvedUrl: string | null;

    if (cached) {
      console.log(
        `Source ${source.id} (${source.type}) is a duplicate of an already-fetched source; reusing items.`
      );
      items = cached.items;
      resolvedUrl = cached.resolvedUrl ?? source.resolvedUrl;
    } else {
      console.log(`Source ${source.id} (${source.type}) is due. Fetching...`);
      const fetched = await fetchSourceItems(source, feedId);
      items = fetched.items;
      resolvedUrl = fetched.resolvedUrl;
      if (dedupKey) dedupCache?.set(dedupKey, { items, resolvedUrl });
    }

    await saveSuccess(source, feedId, ttlMinutes, index, count, now, items, resolvedUrl);
    return {
      sourceId: source.id,
      feedId,
      fetched: true,
      failed: false,
      itemCount: items.length,
    };
  } catch (error: any) {
    console.error(`Failed to update source ${source.id} (${source.url}):`, error);
    await saveFailure(source, ttlMinutes, now, error).catch((persistError) => {
      console.error(`Failed to record failure for source ${source.id}:`, persistError);
    });
    return {
      sourceId: source.id,
      feedId,
      fetched: false,
      failed: true,
      itemCount: 0,
      error: error?.message ?? String(error),
    };
  }
}

/**
 * Reassign every source of a feed to its evenly-spread slot. Called when a feed is
 * created/edited, its TTL changes, its sources change, or after migration when a
 * source has no schedule yet.
 */
export async function rebalanceFeed(feedId: string, now: Date = new Date()): Promise<void> {
  const feed = await prisma.feed.findUnique({
    where: { id: feedId },
    include: { sources: true },
  });
  if (!feed) return;

  const ordered = orderSources(feed.sources);
  const plan = planRebalance(feed.sources, feed.ttl, now);
  const updates = ordered.map((source) =>
    prisma.feedSource.update({
      where: { id: source.id },
      data: { nextRefreshAt: plan.get(source.id) ?? null },
    })
  );

  if (updates.length > 0) {
    await prisma.$transaction(updates);
  }
}

/**
 * Updates the feed cache by fetching each due source. This is the on-demand workhorse
 * (create/update/API refresh); the cron tick calls refreshOneSource directly.
 */
export async function refreshFeed(
  feedId: string,
  ttlMinutes: number,
  opts: UpdateFeedOptions = {}
): Promise<RefreshOutcome> {
  const feed = await prisma.feed.findUnique({
    where: { id: feedId },
    include: { sources: true, items: { include: { source: true } } },
  });

  if (!feed) {
    throw new Error(`Feed not found with ID: ${feedId}`);
  }

  const now = new Date();
  const ordered = orderSources(feed.sources);
  let fetchedSources = 0;
  let failedSources = 0;
  const dedupCache = new Map<
    string,
    { items: ScrapedFeedItem[]; resolvedUrl: string | null }
  >();

  for (let index = 0; index < ordered.length; index++) {
    const source = ordered[index];
    const isExpired = opts.force || isSourceStale(source, ttlMinutes, now, opts.disabled);

    if (!isExpired) continue;

    const outcome = await refreshOneSource(
      source,
      feedId,
      ttlMinutes,
      index,
      ordered.length,
      now,
      dedupCache
    );

    if (outcome.failed) {
      failedSources++;
    } else {
      fetchedSources++;
    }
  }

  // Return the fresh feed state
  const updatedFeed = await prisma.feed.findUnique({
    where: { id: feedId },
    include: { sources: true, items: { include: { source: true } } },
  });

  return {
    feed: updatedFeed!,
    refreshed: fetchedSources > 0,
    fetchedSources,
    failedSources,
  };
}

/**
 * Backwards-compatible wrapper returning just the refreshed feed.
 */
export async function updateFeedIfNeeded(
  feedId: string,
  ttlMinutes: number,
  opts: UpdateFeedOptions = {}
): Promise<Feed & { sources: FeedSource[]; items: FeedItem[] }> {
  return (await refreshFeed(feedId, ttlMinutes, opts)).feed;
}

/** Force-refresh a single source (manual refresh button). */
export async function refreshSource(
  sourceId: string
): Promise<{ source: FeedSource; outcome: SourceFetchOutcome }> {
  const source = await prisma.feedSource.findUnique({
    where: { id: sourceId },
    include: { feed: { include: { sources: true } } },
  });
  if (!source) {
    throw new Error(`Source not found with ID: ${sourceId}`);
  }

  const ordered = orderSources(source.feed.sources);
  const index = ordered.findIndex((candidate) => candidate.id === source.id);
  const now = new Date();
  const outcome = await refreshOneSource(
    source,
    source.feedId,
    source.feed.ttl,
    index === -1 ? 0 : index,
    ordered.length,
    now
  );

  const updated = await prisma.feedSource.findUnique({ where: { id: sourceId } });
  return { source: updated!, outcome };
}

// ---------------------------------------------------------------------------
// Cron tick
// ---------------------------------------------------------------------------

let tickRunning = false;

export function isTickRunning(): boolean {
  return tickRunning;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function concurrencyLimit(): number {
  const parsed = parseInt(process.env.REFRESH_CONCURRENCY ?? '', 10);
  return Number.isNaN(parsed) || parsed < 1 ? 4 : parsed;
}

/** Milliseconds to keep between two consecutive fetches of the same host. */
function hostGapMs(): number {
  const parsed = parseInt(process.env.REFRESH_HOST_GAP_MS ?? '', 10);
  return Number.isNaN(parsed) || parsed < 0 ? 400 : parsed;
}

interface TickTask {
  feed: Feed & { sources: FeedSource[] };
  source: FeedSource;
  index: number;
  count: number;
}

/**
 * One cron tick: rebalance unscheduled feeds, pick due sources (round-robin across
 * feeds), and fetch up to the adaptive budget with bounded concurrency.
 */
export async function runRefreshTick(
  opts: { now?: Date; dryRun?: boolean } = {}
): Promise<RefreshTickResult> {
  if (tickRunning) {
    const error = new Error('A refresh tick is already running');
    (error as any).code = 'TICK_RUNNING';
    throw error;
  }

  tickRunning = true;
  const startedMs = Date.now();

  try {
    const now = opts.now ?? new Date();

    // Rebalance feeds that have never been scheduled (fresh migration) and clear
    // schedules for on-demand (TTL 0) feeds.
    const initial = await prisma.feed.findMany({ include: { sources: true }, orderBy: { createdAt: 'asc' } });
    for (const feed of initial) {
      const unscheduled = feed.sources.some((source) => source.nextRefreshAt === null);
      // TTL 0 feeds intentionally have no schedule; only rebalance automatic feeds.
      if (feed.ttl > 0 && unscheduled) {
        await rebalanceFeed(feed.id, now);
      }
    }

    const feeds = await prisma.feed.findMany({
      include: { sources: true },
      orderBy: { createdAt: 'asc' },
    });

    const groups: TickTask[][] = [];
    for (const feed of feeds) {
      const ordered = orderSources(feed.sources);
      const due: TickTask[] = [];
      ordered.forEach((source, index) => {
        const dueBySchedule =
          feed.ttl > 0
            ? source.nextRefreshAt === null || source.nextRefreshAt.getTime() <= now.getTime()
            : !source.lastFetched; // TTL 0: only seed never-fetched sources

        if (dueBySchedule) {
          due.push({ feed, source, index, count: ordered.length });
        }
      });
      if (due.length > 0) groups.push(due);
    }

    const dueCount = groups.reduce((total, group) => total + group.length, 0);

    const previousRun = await prisma.refreshRun.findFirst({
      orderBy: { startedAt: 'desc' },
      select: { attempted: true },
    });
    const budget = opts.dryRun ? dueCount : nextBudget(previousRun?.attempted);

    // Round-robin across feeds so one large feed cannot consume the whole budget.
    const selection: TickTask[] = [];
    let cursor = 0;
    while (selection.length < budget) {
      let progressed = false;
      for (const group of groups) {
        if (selection.length >= budget) break;
        const task = group[cursor];
        if (task) {
          selection.push(task);
          progressed = true;
        }
      }
      if (!progressed) break;
      cursor++;
    }

    const results: TickSourceResult[] = [];
    let runId: string | undefined;

    if (!opts.dryRun) {
      const run = await prisma.refreshRun.create({
        data: { startedAt: now, budget, due: dueCount },
      });
      runId = run.id;

      const hostChains = new Map<string, Promise<void>>();
      const lastHostFetch = new Map<string, number>();

      const tasks = selection.map((task) => async () => {
        const host = sourceHost(task.source);
        const previous = hostChains.get(host) ?? Promise.resolve();

        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        hostChains.set(host, previous.then(() => gate));

        await previous;
        try {
          const gap = (lastHostFetch.get(host) ?? 0) + hostGapMs() - Date.now();
          if (gap > 0) await sleep(gap);

          const outcome = await refreshOneSource(
            task.source,
            task.feed.id,
            task.feed.ttl,
            task.index,
            task.count,
            now
          );
          results.push({
            ...outcome,
            feedName: task.feed.name,
            type: task.source.type,
          });
        } finally {
          lastHostFetch.set(host, Date.now());
          release();
        }
      });

      const limit = Math.min(concurrencyLimit(), tasks.length);
      let nextTask = 0;
      await Promise.all(
        Array.from({ length: limit }, async () => {
          while (nextTask < tasks.length) {
            const task = tasks[nextTask++];
            await task();
          }
        })
      );

      const attempted = results.filter((result) => !result.deferred).length;
      const deferred = results.length - attempted;
      const succeeded = results.filter((result) => !result.deferred && !result.failed).length;
      const failed = results.filter((result) => !result.deferred && result.failed).length;
      const durationMs = Date.now() - startedMs;

      await prisma.refreshRun.update({
        where: { id: run.id },
        data: {
          finishedAt: new Date(),
          attempted,
          succeeded,
          failed,
          durationMs,
        },
      });

      await prisma.refreshRun.deleteMany({
        where: {
          startedAt: { lt: new Date(now.getTime() - RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000) },
        },
      });

      console.log(
        `[tick] due=${dueCount} budget=${budget} attempted=${attempted} ` +
          `succeeded=${succeeded} failed=${failed} deferred=${deferred} ` +
          `(${(durationMs / 1000).toFixed(1)}s)`
      );

      return {
        runId,
        budget,
        due: dueCount,
        attempted,
        succeeded,
        failed,
        deferred,
        durationMs,
        dryRun: false,
        results,
      };
    }

    return {
      budget,
      due: dueCount,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      deferred: 0,
      durationMs: Date.now() - startedMs,
      dryRun: true,
      results: [],
    };
  } finally {
    tickRunning = false;
  }
}
