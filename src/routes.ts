import { Router, Request, Response } from 'express';
import { prisma } from './services/db.js';
import * as feedManager from './services/feedManager.js';
import * as feedGenerator from './services/feedGenerator.js';
import * as scraper from './services/scraper.js';
import { nextBudget, TICK_INTERVAL_MINUTES } from './services/scheduler.js';
import { isCooling } from './services/botGuard.js';

export const router = Router();

/**
 * The refresh tick is meant for the local cron entrypoint only. The server binds to
 * loopback by default; this guards against a misconfigured HOST exposing the endpoint.
 */
function isLoopback(req: Request): boolean {
  const address = req.socket.remoteAddress || '';
  return (
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address === '127.0.0.1' ||
    address.startsWith('127.')
  );
}

/**
 * Health check endpoint
 */
router.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

/**
 * Register a new feed with multiple sources
 */
router.post('/api/feeds', async (req: Request, res: Response) => {
  const { name, sources, ttl } = req.body;

  if (!name || !sources || !Array.isArray(sources) || sources.length === 0) {
    res.status(400).json({ error: 'Missing required fields: name, sources (array)' });
    return;
  }

  const validTypes = ['rss', 'html', 'reddit', 'youtube', 'fourchan'];
  for (const source of sources) {
    if (!source.url || !source.type) {
      res.status(400).json({ error: 'Each source must have a url and a type' });
      return;
    }
    if (!validTypes.includes(source.type)) {
      res.status(400).json({ error: `Invalid source type: ${source.type}. Must be one of: ${validTypes.join(', ')}` });
      return;
    }
  }

  // Parse TTL. 0 means auto-refresh is disabled (the feed is only refreshed on demand).
  let ttlMinutes = 15;
  if (ttl !== undefined && ttl !== null && ttl !== '') {
    ttlMinutes = parseInt(ttl as string, 10);
    if (Number.isNaN(ttlMinutes) || ttlMinutes < 0) {
      res.status(400).json({ error: 'Invalid ttl: must be a non-negative number of minutes' });
      return;
    }
  }

  try {
    const feed = await prisma.feed.create({
      data: {
        name,
        ttl: ttlMinutes,
        sources: {
          create: sources.map((source) => ({
            url: source.url,
            type: source.type,
            config: source.config ? JSON.stringify(source.config) : null,
          })),
        },
      },
      include: {
        sources: true,
      },
    });

    try {
      // Seed the cache once on creation. Later refreshes are cron-driven (or explicit).
      await feedManager.refreshFeed(feed.id, feed.ttl);
    } catch (scrapeErr) {
      console.error(`Initial scrape failed for feed ${feed.id}:`, scrapeErr);
    }

    res.status(201).json(feed);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * List all feeds (includes their sources)
 */
router.get('/api/feeds', async (req: Request, res: Response) => {
  try {
    const feeds = await prisma.feed.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        sources: true,
        _count: { select: { items: { where: { read: false } } } },
      },
    });
    res.json(
      feeds.map(({ _count, ...feed }) => ({ ...feed, unreadCount: _count.items }))
    );
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get details of a single feed (includes sources and items)
 */
router.get('/api/feeds/:id', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const feed = await prisma.feed.findUnique({
      where: { id },
      include: {
        sources: true,
        items: { include: { source: true } },
        _count: { select: { items: { where: { read: false } } } },
      },
    });
    if (!feed) {
      res.status(404).json({ error: 'Feed not found' });
      return;
    }
    const { _count, ...feedBody } = feed;
    res.json({ ...feedBody, unreadCount: _count.items });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Update a feed's metadata and sync its sources
 */
router.put('/api/feeds/:id', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { name, ttl, sources } = req.body;

  if (!name || !sources || !Array.isArray(sources) || sources.length === 0) {
    res.status(400).json({ error: 'Missing required fields: name, sources' });
    return;
  }

  const validTypes = ['rss', 'html', 'reddit', 'youtube', 'fourchan'];
  for (const source of sources) {
    if (!source.url || !source.type) {
      res.status(400).json({ error: 'Each source must have a url and a type' });
      return;
    }
    if (!validTypes.includes(source.type)) {
      res.status(400).json({ error: `Invalid source type: ${source.type}` });
      return;
    }
  }

  // Parse TTL. 0 means auto-refresh is disabled (the feed is only refreshed on demand).
  let ttlMinutes = 15;
  if (ttl !== undefined && ttl !== null && ttl !== '') {
    ttlMinutes = parseInt(ttl as string, 10);
    if (Number.isNaN(ttlMinutes) || ttlMinutes < 0) {
      res.status(400).json({ error: 'Invalid ttl: must be a non-negative number of minutes' });
      return;
    }
  }

  try {
    // Get current sources to identify ones to delete
    const currentFeed = await prisma.feed.findUnique({
      where: { id },
      include: { sources: true },
    });

    if (!currentFeed) {
      res.status(404).json({ error: 'Feed not found' });
      return;
    }

    const incomingIds = sources.map((s: any) => s.id).filter(Boolean);
    const sourcesToDelete = currentFeed.sources.filter((s) => !incomingIds.includes(s.id));

    // Transaction to update metadata and sync sources
    const result = await prisma.$transaction(async (tx) => {
      // Delete removed sources (cascades to delete their feed items)
      if (sourcesToDelete.length > 0) {
        await tx.feedSource.deleteMany({
          where: {
            id: { in: sourcesToDelete.map((s) => s.id) },
          },
        });
      }

      // Update feed-level fields
      await tx.feed.update({
        where: { id },
        data: {
          name,
          ttl: ttlMinutes,
        },
      });

      // Create/Update sources
      for (const source of sources) {
        const configString = source.config ? JSON.stringify(source.config) : null;
        if (source.id) {
          // Update existing source
          const existingSource = currentFeed.sources.find((s) => s.id === source.id);
          const urlChanged = source.url !== existingSource?.url;
          const typeChanged = source.type !== existingSource?.type;
          const configChanged = configString !== (existingSource?.config ?? null);
          const changed = urlChanged || typeChanged || configChanged;
          await tx.feedSource.update({
            where: { id: source.id },
            data: {
              url: source.url,
              type: source.type,
              config: configString,
              // A changed definition needs a fresh fetch; unchanged fresh sources stay cached.
              lastFetched: changed ? null : undefined,
              // If the URL changed, reset resolvedUrl so it re-resolves
              resolvedUrl: urlChanged || typeChanged ? null : undefined,
            },
          });
        } else {
          // Create new source
          await tx.feedSource.create({
            data: {
              feedId: id,
              url: source.url,
              type: source.type,
              config: configString,
            },
          });
        }
      }

      return tx.feed.findUnique({
        where: { id },
        include: { sources: true },
      });
    });

    if (result) {
      // New/removed/changed sources shift everyone's slot: rebalance before fetching so
      // the feed's sources stay evenly spread across its TTL.
      await feedManager.rebalanceFeed(result.id);
      try {
        // Staleness check: only new/changed/stale sources are fetched, not everything.
        await feedManager.refreshFeed(
          result.id,
          result.ttl,
          result.ttl === 0 ? { disabled: true } : {}
        );
      } catch (scrapeErr) {
        console.error(`Scrape on update failed for feed ${result.id}:`, scrapeErr);
      }
    }

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete a feed (automatically cascades to delete feed items and sources)
 */
router.delete('/api/feeds/:id', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    await prisma.feed.delete({
      where: { id },
    });
    res.json({ message: 'Feed deleted successfully' });
  } catch (error: any) {
    if (error.code === 'P2025') {
      res.status(404).json({ error: 'Feed not found' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * List aggregated items (the reader).
 * Query params: feedId, unreadOnly=true, limit (default 50, max 200), offset, since (ISO date)
 */
router.get('/api/items', async (req: Request, res: Response) => {
  try {
    const feedId = req.query.feedId as string | undefined;
    const unreadOnly = req.query.unreadOnly === 'true';
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const since = req.query.since as string | undefined;

    const where: any = {};
    if (feedId) where.feedId = feedId;
    if (unreadOnly) where.read = false;
    if (since) {
      const sinceDate = new Date(since);
      if (!Number.isNaN(sinceDate.getTime())) {
        where.createdAt = { gte: sinceDate };
      }
    }

    const [items, total, unreadTotal] = await Promise.all([
      prisma.feedItem.findMany({
        where,
        orderBy: [{ pubDate: 'desc' }, { createdAt: 'desc' }],
        skip: offset,
        take: limit,
        include: {
          feed: { select: { id: true, name: true } },
          source: { select: { id: true, type: true } },
        },
      }),
      prisma.feedItem.count({ where }),
      prisma.feedItem.count({ where: { ...where, read: false } }),
    ]);

    res.json({ items, total, unreadTotal, limit, offset });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Mark a single item read/unread.
 */
router.patch('/api/items/:id', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { read } = req.body;
  if (typeof read !== 'boolean') {
    res.status(400).json({ error: 'Missing required field: read (boolean)' });
    return;
  }
  try {
    const item = await prisma.feedItem.update({ where: { id }, data: { read } });
    res.json(item);
  } catch (error: any) {
    if (error.code === 'P2025') {
      res.status(404).json({ error: 'Item not found' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * Mark items read in bulk: { ids?: string[], feedId?: string }.
 * ids → those items; feedId → every item in that feed; neither → every item.
 */
router.post('/api/items/read', async (req: Request, res: Response) => {
  try {
    const { ids, feedId } = req.body ?? {};
    const where: any = { read: false };
    if (Array.isArray(ids) && ids.length > 0) {
      where.id = { in: ids };
    } else if (feedId) {
      where.feedId = feedId;
    }
    const result = await prisma.feedItem.updateMany({ where, data: { read: true } });
    res.json({ count: result.count });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Test feed selectors or queries in real-time
 */
router.post('/api/feeds/test', async (req: Request, res: Response) => {
  const { type, url, config } = req.body;

  if (!type) {
    res.status(400).json({ error: 'Missing type parameter' });
    return;
  }

  try {
    let items: any[] = [];

    switch (type) {
      case 'html':
        if (!url || !config) {
          res.status(400).json({ error: 'Missing url or config (selectors) for HTML scraper' });
          return;
        }
        items = await scraper.scrapeHtml(url, config);
        break;

      case 'reddit':
        if (!url) {
          res.status(400).json({ error: 'Missing subreddit url or handle' });
          return;
        }
        items = await scraper.fetchRedditRss(url);
        break;

      case 'youtube':
        if (!url) {
          res.status(400).json({ error: 'Missing YouTube channel URL' });
          return;
        }
        const { resolvedUrl } = await scraper.resolveYoutubeChannel(url);
        const rawYtItems = await scraper.fetchYoutubeRss(resolvedUrl);
        const includeShorts = config?.includeShorts !== false;

        // Shorts flags: link-derived when possible, cached DB value or (rarely) a
        // network probe only for ambiguous legacy links — skipped while the host is
        // in a botGuard cooldown.
        const allowShortChecks = !isCooling('www.youtube.com');
        const checkedItems = await scraper.mapLimit(rawYtItems, 3, async (item) => {
          const videoId = item.extraMetadata?.videoId;
          let isShort = await scraper.determineYoutubeShortFlag(
            { videoId, link: item.link },
            { allowNetwork: allowShortChecks }
          );
          if (isShort === undefined) {
            // Preview-only: conservative guess keeps the include/exclude filter working.
            isShort = false;
          }
          return {
            ...item,
            extraMetadata: { ...item.extraMetadata, isShort },
          };
        });

        if (!includeShorts) {
          items = checkedItems.filter((item) => item.extraMetadata.isShort !== true);
        } else {
          items = checkedItems;
        }
        break;

      case 'fourchan':
        if (!config || !config.board || !config.query) {
          res.status(400).json({ error: 'Missing board or query parameter inside config' });
          return;
        }
        items = await scraper.fetchFourChanFeed(config.board, config.query, config.topN || 10);
        break;

      default:
        res.status(400).json({ error: `Unsupported test feed type: ${type}` });
        return;
    }

    res.json({ count: items.length, items });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Refresh a feed cache on demand. Staleness-checked: fresh feeds return cached data
 * without any network work. Pass ?force=1 (or ?force=true) to fetch regardless of TTL.
 */
router.post('/api/feeds/:id/refresh', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const feed = await prisma.feed.findUnique({ where: { id }, include: { sources: true } });
    if (!feed) {
      res.status(404).json({ error: 'Feed not found' });
      return;
    }

    // TTL 0 feeds are never picked up by cron, so an on-demand request always fetches them.
    const force = req.query.force === '1' || req.query.force === 'true';
    const outcome = await feedManager.refreshFeed(id, feed.ttl, { force });

    res.setHeader('X-Feed-Refreshed', String(outcome.refreshed));
    res.setHeader('X-Feed-Stale', String(feedManager.isFeedStale(outcome.feed)));
    res.json(outcome.feed);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Cron entrypoint. Invoked by a local 5-minute crontab entry via curl:
 *   curl -fsS -X POST http://127.0.0.1:3000/api/refresh/tick
 *
 * Fetches only sources whose scheduled slot has arrived (plus new/never-fetched ones),
 * bounded by an adaptive per-tick budget. Returns 409 when a tick is still running.
 */
router.post('/api/refresh/tick', async (req: Request, res: Response) => {
  if (!isLoopback(req)) {
    res.status(403).json({ error: 'Refresh ticks are only accepted from loopback' });
    return;
  }

  try {
    const result = await feedManager.runRefreshTick();
    res.json(result);
  } catch (error: any) {
    if (error?.code === 'TICK_RUNNING') {
      res.status(409).json({ error: error.message, skipped: true });
      return;
    }
    console.error('Refresh tick failed:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Recent tick history for the activity graph. `hours` defaults to 24 (max 168 = 7 days).
 */
router.get('/api/refresh/runs', async (req: Request, res: Response) => {
  try {
    const requested = parseInt(req.query.hours as string, 10);
    const hours = Number.isNaN(requested) ? 24 : Math.min(Math.max(requested, 1), 168);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const now = new Date();

    const [runs, lastRun, dueNow] = await Promise.all([
      prisma.refreshRun.findMany({
        where: { startedAt: { gte: since } },
        orderBy: { startedAt: 'asc' },
        take: 5000,
      }),
      prisma.refreshRun.findFirst({ orderBy: { startedAt: 'desc' } }),
      prisma.feedSource.count({
        where: {
          feed: { ttl: { gt: 0 } },
          OR: [{ nextRefreshAt: null }, { nextRefreshAt: { lte: now } }],
        },
      }),
    ]);

    res.json({
      runs,
      lastRun,
      dueNow,
      currentBudget: nextBudget(lastRun?.attempted),
      tickIntervalMinutes: TICK_INTERVAL_MINUTES,
      running: feedManager.isTickRunning(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Force-refresh a single source (per-source refresh button in the UI).
 */
router.post('/api/sources/:id/refresh', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const { source, outcome } = await feedManager.refreshSource(id);
    res.setHeader('X-Source-Refreshed', String(outcome.fetched));
    res.json({
      source,
      fetched: outcome.fetched,
      failed: outcome.failed,
      itemCount: outcome.itemCount,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  } catch (error: any) {
    if (String(error?.message || '').startsWith('Source not found')) {
      res.status(404).json({ error: 'Source not found' });
      return;
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * Fetch and return the generated RSS XML feed.
 *
 * Plain requests are read-only: they serve the cached items and never scrape. Refresh
 * is handled by the 5-minute cron tick (POST /api/refresh/tick). Passing ?ttl=<minutes>
 * explicitly requests a staleness-checked refresh (?ttl=0 forces one) for clients that
 * want on-demand updates.
 */
router.get('/feeds/:id', async (req: Request, res: Response) => {
  const id = req.params.id as string;

  try {
    let feed = await prisma.feed.findUnique({
      where: { id },
      include: { sources: true, items: { include: { source: true } } },
    });
    if (!feed) {
      res.status(404).send('Feed not found');
      return;
    }

    const queryTtlRaw = req.query.ttl;
    if (queryTtlRaw !== undefined) {
      const parsedTtl = parseInt(queryTtlRaw as string, 10);
      if (Number.isNaN(parsedTtl) || parsedTtl < 0) {
        res.status(400).send('Invalid ttl parameter');
        return;
      }
      // Explicit refresh request: ?ttl=0 forces, any other value refreshes only if stale.
      const outcome = await feedManager.refreshFeed(id, parsedTtl, { force: parsedTtl === 0 });
      feed = outcome.feed;
    }

    const stale = feedManager.isFeedStale(feed);
    res.setHeader('X-Feed-Stale', String(stale));
    if (feed.lastFetched) {
      res.setHeader('X-Feed-Last-Fetched', feed.lastFetched.toISOString());
    }
    if (stale) {
      res.setHeader('Warning', '110 - "Response is Stale"');
    }

    // Generate XML feed
    const xml = feedGenerator.generateRssXml(feed);

    // Serve RSS XML
    res.header('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  } catch (error: any) {
    console.error('Error generating RSS feed XML:', error);
    res.status(500).send(`Internal Server Error: ${error.message}`);
  }
});
