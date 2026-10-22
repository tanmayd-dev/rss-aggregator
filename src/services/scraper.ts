import axios, { AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import Parser from 'rss-parser';
import { HtmlConfig, ScrapedFeedItem, YoutubeConfig } from '../types.js';
import { isBotFlagError } from './botGuard.js';

const parser = new Parser();

// Configure axios with a default desktop-like user agent to avoid basic scraping blocks
const client = axios.create({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  },
  timeout: 10000,
});

/**
 * GET with retry on transient failures.
 *
 * YouTube intermittently answers valid channel pages and `feeds/videos.xml` URLs
 * with generic Google "Error 404 (Not Found)!!1" / "Error 500 (Server Error)!!1"
 * pages (bot mitigation) even though the channel exists and a retry seconds later
 * succeeds. Without retries a single flaky answer fails the whole refresh.
 * Retries cover transient statuses (403/404/408/425/429/5xx) and network errors;
 * 400/401/402/406... are treated as permanent and fail fast.
 */
async function getWithRetry(
  url: string,
  opts: { attempts?: number; baseDelayMs?: number } = {}
): Promise<AxiosResponse> {
  const attempts = opts.attempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await client.get(url);
    } catch (err: any) {
      lastError = err;
      // Google/YouTube bot mitigation answers the same URL with the same fake error
      // page within seconds, so immediate retries just burn requests and keep the
      // flag hot. Tag the error and fail fast; botGuard handles the host-wide pause.
      if (isBotFlagError(err)) {
        err.botFlagged = true;
        break;
      }
      const status = err?.response?.status;
      const retriable =
        !err?.response || // network-level failure (no HTTP response received)
        status === 403 ||
        status === 404 ||
        status === 408 ||
        status === 425 ||
        status === 429 ||
        (status >= 500 && status <= 599);
      if (!retriable || attempt === attempts) {
        break;
      }
      const jitter = Math.round(Math.random() * 200);
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt + jitter));
    }
  }

  throw lastError;
}

// Helper to resolve relative URLs
function resolveUrl(baseUrl: string, relativeUrl: string): string {
  try {
    return new URL(relativeUrl, baseUrl).toString();
  } catch {
    return relativeUrl;
  }
}

/**
 * Scrapes a static HTML website using CSS selectors
 */
export async function scrapeHtml(url: string, config: HtmlConfig): Promise<ScrapedFeedItem[]> {
  const response = await client.get(url);
  const $ = cheerio.load(response.data);
  const items: ScrapedFeedItem[] = [];

  $(config.itemSelector).each((_, element) => {
    const el = $(element);
    
    // Extract title
    const title = el.find(config.titleSelector).first().text().trim();
    
    // Extract link
    let link = el.find(config.linkSelector).first().attr('href') || '';
    if (link) {
      link = resolveUrl(url, link);
    }
    
    if (!title || !link) {
      return; // Skip if missing essential RSS fields
    }

    // Extract description (optional)
    let description: string | null = null;
    if (config.descriptionSelector) {
      description = el.find(config.descriptionSelector).first().text().trim() || null;
    }

    // Extract pubDate (optional)
    let pubDate: Date | null = null;
    if (config.pubDateSelector) {
      const dateEl = el.find(config.pubDateSelector).first();
      // Try fetching datetime attribute first
      const datetimeAttr = dateEl.attr('datetime') || dateEl.attr('title');
      const rawDateStr = datetimeAttr || dateEl.text().trim();
      if (rawDateStr) {
        const parsed = Date.parse(rawDateStr);
        if (!isNaN(parsed)) {
          pubDate = new Date(parsed);
        }
      }
    }

    items.push({
      title,
      link,
      description,
      pubDate,
      guid: link, // Link serves as a solid default GUID
    });
  });

  return items;
}

import { prisma } from './db.js';

const youtubeResolutionCache = new Map<string, { resolvedUrl: string; name: string }>();

/**
 * Resolves a YouTube channel URL (handles @handle or channel ID format) to its native RSS feed URL
 */
export async function resolveYoutubeChannel(channelUrl: string): Promise<{ resolvedUrl: string; name: string }> {
  // If the user already provided the native RSS feed URL, return it
  if (channelUrl.includes('youtube.com/feeds/videos.xml')) {
    return { resolvedUrl: channelUrl, name: 'YouTube Channel Feed' };
  }

  // Check memory cache
  if (youtubeResolutionCache.has(channelUrl)) {
    return youtubeResolutionCache.get(channelUrl)!;
  }

  // Check database cache fallback
  try {
    const cachedSource = await prisma.feedSource.findFirst({
      where: {
        url: channelUrl,
        resolvedUrl: { not: null },
      },
    });
    if (cachedSource && cachedSource.resolvedUrl) {
      const resolved = {
        resolvedUrl: cachedSource.resolvedUrl,
        name: 'YouTube Channel',
      };
      youtubeResolutionCache.set(channelUrl, resolved);
      return resolved;
    }
  } catch (dbErr) {
    console.error('Error looking up channel URL in DB cache:', dbErr);
  }

  // If they provided just a channel ID, construct it
  const channelIdMatch = channelUrl.match(/^(UC[a-zA-Z0-9_-]{22})$/);
  if (channelIdMatch) {
    const cid = channelIdMatch[1];
    const resolved = {
      resolvedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${cid}`,
      name: `YouTube Channel ${cid}`,
    };
    youtubeResolutionCache.set(channelUrl, resolved);
    return resolved;
  }

  // Fetch the page HTML to find the RSS alternate link
  const response = await getWithRetry(channelUrl);
  const $ = cheerio.load(response.data);

  let resolved: { resolvedUrl: string; name: string } | null = null;

  // Find <link rel="alternate" type="application/rss+xml" href="...">
  const rssLink = $('link[type="application/rss+xml"]').attr('href');
  if (rssLink) {
    // Extract title/name
    const channelName = $('meta[property="og:title"]').attr('content') || $('title').text().replace(' - YouTube', '').trim() || 'YouTube Channel';
    resolved = {
      resolvedUrl: rssLink,
      name: channelName,
    };
  }

  // Fallback regex approach on the HTML
  if (!resolved) {
    const rssRegex = /type="application\/rss\+xml"\s+title="RSS"\s+href="([^"]+)"/i;
    const match = response.data.match(rssRegex);
    if (match) {
      const channelName = $('meta[property="og:title"]').attr('content') || 'YouTube Channel';
      resolved = {
        resolvedUrl: match[1],
        name: channelName,
      };
    }
  }

  // Fallback regex for channelId in page source
  if (!resolved) {
    const cidRegex = /"channelId":"(UC[a-zA-Z0-9_-]{22})"/;
    const cidMatch = response.data.match(cidRegex);
    if (cidMatch) {
      const cid = cidMatch[1];
      const channelName = $('meta[property="og:title"]').attr('content') || 'YouTube Channel';
      resolved = {
        resolvedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${cid}`,
        name: channelName,
      };
    }
  }

  if (resolved) {
    youtubeResolutionCache.set(channelUrl, resolved);
    return resolved;
  }

  throw new Error('Failed to resolve YouTube channel RSS link. Verify the channel URL.');
}

/**
 * Decides a YouTube item's Shorts flag offline, purely from the feed link: entries for
 * Shorts point at youtube.com/shorts/<id>, regular videos at /watch?v=<id> (or
 * youtu.be/<id>). Returns true/false when decidable, null when ambiguous.
 */
export function isShortLink(link?: string | null): boolean | null {
  if (!link) return null;
  if (/youtube\.com\/shorts\/[^/?&]{5,}/i.test(link)) return true;
  if (/youtube\.com\/watch\?v=[^&/?]{5,}/i.test(link)) return false;
  if (/youtu\.be\/[^/?&]{5,}/i.test(link)) return false;
  return null;
}

/**
 * Flag a video as a Short from the redirect it serves: a regular video 303-redirects
 * /shorts/<id> to /watch?v=<id>, while a Short resolves inside /shorts.
 *
 * Returns true/false only for a confirmed answer; network failures return undefined
 * (undetermined) instead of a default false, so a wrong value is never cached.
 */
export async function checkIsYoutubeShort(videoId: string): Promise<boolean | undefined> {
  try {
    const response = await client.head(`https://www.youtube.com/shorts/${videoId}`, {
      maxRedirects: 0,
      validateStatus: () => true,
      timeout: 1500, // strict timeout to prevent thread blocking
    });

    // Status 303 See Other redirects standard videos to /watch?v=videoId
    const location = response.headers.location || '';
    if ((response.status === 303 || response.status === 302) && location.includes('/watch')) {
      return false;
    }
    return true; // Resolves locally or stays in /shorts
  } catch (err) {
    console.error(`Error checking Shorts status for video ${videoId}:`, err);
    return undefined; // Undetermined: callers must not persist a value from this
  }
}

/**
 * Resolves a YouTube item's isShort flag with as little traffic as possible:
 * 1. the feed link itself (offline, always enough for fresh channel-feed data),
 * 2. the flag cached on any FeedItem row that already holds this link,
 * 3. the network redirect probe (only for ambiguous legacy links).
 *
 * Backs off entirely while `allowNetwork` is false (e.g. a botGuard cooldown on the
 * host) so a flagged host is never probed. Returns undefined when undetermined.
 */
export async function determineYoutubeShortFlag(
  item: { videoId?: string; link?: string | null },
  opts: { allowNetwork?: boolean } = {}
): Promise<boolean | undefined> {
  const offline = isShortLink(item.link);
  if (offline !== null) return offline;

  // Ambiguous link: any FeedItem row that already stored this link may know.
  if (item.link) {
    try {
      const cachedItem = await prisma.feedItem.findFirst({ where: { link: item.link } });
      if (cachedItem && cachedItem.extraMetadata) {
        const meta = JSON.parse(cachedItem.extraMetadata);
        if (meta.isShort !== undefined) {
          return meta.isShort as boolean;
        }
      }
    } catch (cacheErr) {
      console.error('Error reading cached Shorts flag for link:', cacheErr);
    }
  }

  if (!item.videoId || opts.allowNetwork === false) return undefined;
  return checkIsYoutubeShort(item.videoId);
}

/** Run `fn` over `items` with at most `limit` concurrent calls, preserving order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) return results;

  let next = 0;
  const concurrency = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    })
  );
  return results;
}

/**
 * Fetches and parses a YouTube RSS feed
 */
export async function fetchYoutubeRss(
  rssUrl: string,
  opts: { attempts?: number; baseDelayMs?: number } = {}
): Promise<ScrapedFeedItem[]> {
  const response = await getWithRetry(rssUrl, opts);
  const feed = await parser.parseString(response.data);
  
  const items: ScrapedFeedItem[] = feed.items.map((item) => {
    // Extract video ID from link or XML structure if available
    const videoId = (item as any).id?.replace('yt:video:', '') || item.link?.match(/v=([^&]+)/)?.[1] || '';
    
    return {
      title: item.title || 'Untitled Video',
      link: item.link || '',
      description: item.content || item.contentSnippet || '',
      pubDate: item.pubDate ? new Date(item.pubDate) : new Date(),
      guid: item.guid || item.link || '',
      extraMetadata: {
        videoId,
        thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      },
    };
  });

  return items;
}

/**
 * Resolves and fetches Reddit subreddit RSS
 */
export async function fetchRedditRss(subredditInput: string): Promise<ScrapedFeedItem[]> {
  let sub = subredditInput.trim();
  
  // Resolve URL formats like https://www.reddit.com/r/javascript/ to r/javascript
  const rMatch = sub.match(/reddit\.com\/r\/([a-zA-Z0-9_]+)/i);
  if (rMatch) {
    sub = `r/${rMatch[1]}`;
  } else if (!sub.startsWith('r/')) {
    sub = `r/${sub}`;
  }

  const rssUrl = `https://www.reddit.com/${sub}/.rss`;
  
  // Reddit strictly blocks generic client user agents
  const redditClient = axios.create({
    headers: {
      'User-Agent': 'RSS-Aggregator/1.0.0 (by /u/deshp; contact support if needed)',
    },
    timeout: 10000,
  });

  const response = await redditClient.get(rssUrl);
  const feed = await parser.parseString(response.data);

  return feed.items.map((item) => {
    // Reddit descriptions contain HTML formatting with post contents and images
    let description = item.content || item.contentSnippet || null;
    
    return {
      title: item.title || 'Untitled Reddit Post',
      link: item.link || '',
      description,
      pubDate: item.pubDate ? new Date(item.pubDate) : new Date(),
      guid: item.guid || item.link || '',
    };
  });
}

/**
 * Fetches 4chan catalog, filters by search query, and returns top N threads by popularity (replies)
 */
export async function fetchFourChanFeed(board: string, query: string, topN: number = 10): Promise<ScrapedFeedItem[]> {
  const cleanBoard = board.replace(/\//g, '').trim();
  const url = `https://a.4cdn.org/${cleanBoard}/catalog.json`;
  
  const response = await client.get(url);
  const pages: any[] = response.data;
  
  const matchedThreads: any[] = [];
  
  let queryRegex: RegExp | null = null;
  if (query.trim()) {
    const escaped = query.replace(/[-\/\\^$*+?.()|[\]{}]/g, (match) => {
      if (match === '*') return '*';
      return '\\' + match;
    });
    const pattern = escaped.replace(/\*/g, '.*');
    try {
      queryRegex = new RegExp(pattern, 'i');
    } catch {
      queryRegex = new RegExp(query.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');
    }
  }

  for (const page of pages) {
    if (!page.threads) continue;
    for (const thread of page.threads) {
      const subject = thread.sub || '';
      const comment = thread.com || '';
      
      if (!queryRegex || queryRegex.test(subject) || queryRegex.test(comment)) {
        matchedThreads.push(thread);
      }
    }
  }

  // Sort by replies count descending
  matchedThreads.sort((a, b) => (b.replies || 0) - (a.replies || 0));

  // Limit to topN
  const topThreads = matchedThreads.slice(0, topN);

  return topThreads.map((thread) => {
    const threadNo = thread.no;
    const threadLink = `https://boards.4channel.org/${cleanBoard}/thread/${threadNo}`;
    
    // Strip HTML tags for clean snippet, or format it
    let description = thread.com || '';
    
    // Add image attachment markup if available
    if (thread.tim && thread.ext) {
      const imageUrl = `https://i.4cdn.org/${cleanBoard}/${thread.tim}${thread.ext}`;
      const thumbnailUrl = `https://i.4cdn.org/${cleanBoard}/${thread.tim}s.jpg`;
      description = `<p><a href="${imageUrl}"><img src="${thumbnailUrl}" alt="Attachment" /></a></p>${description}`;
    }

    // Extract title: Subject, or snippet of comment, or default thread #
    let title = thread.sub || '';
    if (!title && thread.com) {
      // Basic HTML tag stripper
      const plainTextCom = thread.com.replace(/<[^>]*>/g, '').trim();
      title = plainTextCom.length > 50 ? plainTextCom.slice(0, 50) + '...' : plainTextCom;
    }
    if (!title) {
      title = `Thread #${threadNo}`;
    }

    return {
      title,
      link: threadLink,
      description,
      pubDate: thread.time ? new Date(thread.time * 1000) : new Date(),
      guid: `4chan-${cleanBoard}-${threadNo}`,
      extraMetadata: {
        replies: thread.replies || 0,
        images: thread.images || 0,
        tim: thread.tim,
        ext: thread.ext,
      },
    };
  });
}
