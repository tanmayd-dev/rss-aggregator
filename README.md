# rss-aggregator

Self-hosted feed aggregator that merges **RSS, scraped websites, Reddit, YouTube, and 4chan** into unified feeds — each with its own public RSS URL and a built-in reader UI.

## Features

- **Multi-source feeds** — combine any number of sources into one feed:
  - `rss` — any standard RSS/Atom feed
  - `html` — scrape any webpage with CSS selectors (title, link, description, date)
  - `reddit` — any subreddit (`r/selfhosted` or full URL)
  - `youtube` — channels, handles, or existing feed URLs, with optional **Shorts filtering** (HEAD-request detection + DB-cached channel resolution)
  - `4chan` — catalog search with wildcard queries, ranked by reply count
- **Cron-driven refresh** — a 15-minute crontab entry refreshes feeds whose TTL has elapsed; the API server stays idle and only does staleness-checked work on explicit requests
- **Smart refresh** — per-feed TTL caching (`0` = on-demand only), staleness-gated refreshes, and duplicate-source fetch deduplication
- **Reader UI** — paginated reader with unread badges/counts, unread-only filter, single/bulk mark-as-read, live source tester, dark mode
- **Public RSS output** — every feed gets a shareable `GET /feeds/:id` RSS 2.0 endpoint (latest 50 items, newest first)
- **Resilient scraping** — retries with backoff, desktop user-agents, relative-URL resolution
- **One-binary deploy** — Express serves the built React frontend + API; ships with a systemd user unit

## Tech Stack

- **Backend:** TypeScript, Express 5, Prisma 7 + SQLite (libSQL), `rss-parser`, `axios` + `cheerio`, `feed` (RSS emit)
- **Frontend:** React 18, Vite 5, TypeScript, Tailwind CSS, lucide-react
- **Infra:** systemd user service, Playwright + tsx integration scripts

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
# 1. Backend
npm install
echo 'DATABASE_URL="file:./prisma/dev.db"' > .env
npx prisma generate
npx prisma migrate deploy

# 2. Frontend (separate project)
cd frontend && npm install && npm run build && cd ..
```

### Run

```bash
# Development (backend :3000, frontend dev server :5173 proxies /api and /feeds)
npm run dev
cd frontend && npm run dev

# Production (serves API + built frontend on :3000, bound to 127.0.0.1)
npm run build
npm start

# Refresh due sources manually (in production the cron tick does this every 5 minutes)
curl -X POST http://127.0.0.1:3000/api/refresh/tick
```

Open `http://localhost:3000` (prod) or `http://localhost:5173` (dev).

The API server does not self-schedule. In production the crontab entry below POSTs to
`/api/refresh/tick`; the dashboard's "Refresh activity" panel graphs those ticks.

### Deploy (systemd + cron)

```bash
./systemd/install.sh                  # API user service + 5-minute crontab entry
# ./systemd/install.sh --no-cron      # API service only

systemctl enable --now --user rss-server
crontab -l                            # verify the rss-aggregator-refresh entry
tail -f refresh.log                   # cron tick output
```

The systemd unit runs **only** the loopback HTTP API — it never schedules or performs
periodic scrapes. Feed updates are driven by the crontab entry:

```cron
*/5 * * * * curl -fsS --max-time 300 -X POST http://127.0.0.1:3000/api/refresh/tick >> /path/to/repo/refresh.log 2>&1
```

Consequences:

- Each feed's sources are spread evenly across its TTL window, aligned to the UTC clock:
  a 1h feed with 4 sources refreshes one source every 15 minutes (`xx:00`, `xx:15`, …).
  The 5-minute cron tick is the granularity, so TTLs below 5 are effectively 5.
- Each tick's budget adapts to the previous tick (`max(4, previous × 1.5)`, capped at
  `REFRESH_MAX_PER_TICK`, default 64), so a backlog drains over a few ticks.
- `ttl = 0` feeds are skipped by the tick (except never-fetched sources are seeded) and
  refresh only via `POST /api/feeds/:id/refresh`, a per-source refresh, or
  `GET /feeds/:id?ttl=0`.
- A tick that outlives the next request is skipped, not overlapped (in-process guard
  returns `409`); failed sources retry with exponential backoff (5, 10, 20 … capped at
  `min(TTL, 60)` minutes).
- Plain `GET /feeds/:id` is cache-only, so readers never trigger scraping.
- The server binds `127.0.0.1` by default; set `HOST=0.0.0.0` only if you want LAN
  access (the tick endpoint additionally rejects non-loopback requests).

## API Reference

| Method | Endpoint | Description |
| ------ | -------- | ----------- |
| `POST` | `/api/feeds` | Create feed `{name, sources[{url, type, config?}], ttl?}` |
| `GET` | `/api/feeds` | List feeds with unread counts |
| `GET` | `/api/feeds/:id` | Feed + sources + items |
| `PUT` | `/api/feeds/:id` | Update feed (transactional source sync) |
| `DELETE` | `/api/feeds/:id` | Delete feed (cascades) |
| `GET` | `/api/items?feedId=&unreadOnly=&limit=&offset=&since=` | Query items (max 200/page) |
| `PATCH` | `/api/items/:id` | Set `{read: boolean}` |
| `POST` | `/api/items/read` | Mark `{ids?}` / `{feedId?}` / all as read |
| `POST` | `/api/feeds/test` | Dry-run a source, preview parsed items |
| `POST` | `/api/feeds/:id/refresh` | Refresh if stale (`?force=1` bypasses the check) |
| `POST` | `/api/sources/:id/refresh` | Force-refresh one source and re-anchor its slot |
| `POST` | `/api/refresh/tick` | Cron entrypoint (loopback only): fetch due sources, `409` if already running |
| `GET` | `/api/refresh/runs?hours=` | Recent tick history + current budget for the activity graph |
| `GET` | `/feeds/:id?ttl=` | Public RSS 2.0 XML (cache-only; `?ttl=` requests a staleness-checked refresh, `?ttl=0` forces) |
| `GET` | `/health` | Health check |

Source `type` is one of `rss | html | reddit | youtube | fourchan`. HTML sources take `{itemSelector, titleSelector, linkSelector, descriptionSelector?, pubDateSelector?}`; YouTube takes `{includeShorts?}`; 4chan takes `{board, query, topN?}`.

## Project Structure

```
src/
├── index.ts            # Express app (loopback bind), static frontend serving, SPA fallback
├── routes.ts           # REST API (feeds, items, refresh tick, tick history)
├── types.ts            # Shared feed/source types
└── services/
    ├── db.ts           # Prisma + SQLite singleton
    ├── scheduler.ts    # TTL window slots, rebalancing, backoff, adaptive budget
    ├── feedManager.ts  # Per-source fetching, dedup, tick orchestration
    ├── scraper.ts      # RSS/HTML/Reddit/YouTube/4chan fetchers
    └── feedGenerator.ts# RSS 2.0 XML generation
prisma/                 # Schema + migrations (Feed, FeedSource, FeedItem, RefreshRun)
frontend/src/           # React reader UI (feed table, reader modal, editor, activity chart)
scripts/                # Endpoint, browser, and DB test scripts
systemd/                # API service unit + installer (also installs the cron job)
```
