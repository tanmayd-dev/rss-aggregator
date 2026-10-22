# AGENTS.md

## What this is

RSS aggregator: Express 5 + Prisma 7 (SQLite via libsql) backend, React 18 + Vite
frontend. The backend serves the built frontend as static files. Formerly a Windows
+ Zen-browser project; all Zen/installer code was deliberately removed — do not
reintroduce it (no `src/zen/`, no `zen/`, no Windows service code, no `keep_alive.cjs`).

Two separate npm projects (not a workspace): repo root = backend, `frontend/` = UI.
Each needs its own `npm install`.

## Build & run

```bash
# Backend (tsc -> dist/, typecheck = the build, no separate lint/typecheck script)
npm install && npm run build

# Frontend (tsc && vite build -> frontend/dist/)
cd frontend && npm install && npm run build

# Migrations (needs DATABASE_URL from .env; prisma.config.ts reads it)
npx prisma migrate deploy        # apply existing
npx prisma migrate dev           # create a new migration after editing schema.prisma
npx prisma generate              # re-run after any schema change

npm run dev                      # backend with tsx watch (port 3000, loopback)
cd frontend && npm run dev       # vite dev server on :5173, proxies /api and /feeds to :3000

# Trigger one refresh tick by hand (cron does this every 5 min in production)
curl -X POST http://127.0.0.1:3000/api/refresh/tick
```

Order matters on a fresh checkout: `npm install` -> `prisma generate` -> `migrate deploy`
-> `build` -> start. The UI is served from `process.cwd()/frontend/dist` (SPA fallback
500s without it), so always build the frontend and start node from the repo root.

## Environment & database gotchas

- `.env` is gitignored; create it with `DATABASE_URL="file:./prisma/dev.db"`.
  Both the Prisma CLI and runtime resolve this relative to the repo root.
  Do not use `file:./dev.db`: the CLI would create it at the repo root while
  `src/services/db.ts` remaps that exact string to `prisma/dev.db` — they diverge.
- DB file is `prisma/dev.db` (gitignored via `*.db`). Delete it and re-run
  `migrate deploy` to reset.
- `npm install` (npm 12) blocks postinstall scripts; `package.json` `allowScripts`
  already approves prisma/@prisma/engines/esbuild. Approve new ones with
  `npm install-scripts approve <pkg>` or installs will silently lack binaries.
- ESM + NodeNext: every relative import in `src/` and `scripts/` must end in `.js`
  even though the source is `.ts`. Express 5 wildcard routes use `/*splat`, not `*`.

## API semantics worth knowing

- `ttl` on a feed: minutes per full refresh cycle, shared by all its sources. The
  **cron tick** (`POST /api/refresh/tick`, every 5 min over loopback) refreshes one
  source per slot, spread evenly across the TTL and aligned to UTC clock boundaries
  (1h/4 sources -> xx:00, xx:15, xx:30, xx:45). The 5-minute tick is the granularity,
  so TTLs below 5 are effectively 5. `ttl = 0` disables auto-refresh — the tick only
  seeds never-fetched sources; refresh explicitly via `?ttl=0` on `GET /feeds/:id`,
  `POST /api/feeds/:id/refresh`, or `POST /api/sources/:id/refresh`.
- Each source stores its schedule in `FeedSource.nextRefreshAt` (plus `lastFetched`,
  `lastAttemptAt`, `consecutiveFailures`, `lastError`). Adding/removing sources or
  changing the TTL rebalances every source in that feed (`rebalanceFeed`). Failed
  sources retry with exponential backoff (5, 10, 20 … capped at `min(TTL, 60)` min).
- The tick budget adapts to the previous tick:
  `max(4, ceil(previousAttempted * REFRESH_BUDGET_GROWTH))` (default 1.25x), capped by
  `REFRESH_MAX_PER_TICK` (default 64). That drains a post-downtime backlog gradually
  while keeping normal ticks small. Each tick is recorded in `RefreshRun` (pruned after
  7 days) and graphed by the dashboard's "Refresh activity" panel.
- Plain `GET /feeds/:id` is cache-only and never scrapes. Passing `?ttl=` explicitly
  requests a staleness-checked refresh (`?ttl=0` forces). `POST /api/feeds/:id/refresh`
  is also staleness-checked; `?force=1` bypasses it.
- `PUT /api/feeds/:id` rebalances the feed, then fetches new/changed sources plus any
  source already due; unchanged fresh sources are not re-scraped.
- `POST /api/items/read` with no `ids`/`feedId` marks **every** unread item read.

## Tests

- `npm run test-endpoints` — spins its own server on port 3001 (plus 3002/3003 for
  fixture feed servers). Hits the live internet (YouTube, Reddit, 4chan) and mutates
  `prisma/dev.db` (creates/deletes named test feeds, bulk-marks items read). Flaky by
  nature; not offline-safe.
- `npm run test-browser` — Playwright on port 3002; requires `npx playwright install chromium`.
- `frontend` `lint` script exists but there is no ESLint config — it will fail. Ignore it.
- There is no CI.

## Deployment

API runs as a systemd **user** service; periodic refreshes run from **crontab**.
Unit template: `systemd/rss-server.service`. Cron log: `refresh.log` at the repo root.
The unit sets `HOST=127.0.0.1`; the tick endpoint rejects non-loopback requests.

```bash
./systemd/install.sh                    # renders unit + installs the 5-min crontab entry
# ./systemd/install.sh --no-cron        # API unit only
systemctl enable --now --user rss-server
systemctl --user restart rss-server     # after rebuilds (npm run build in both dirs first)
crontab -l                              # look for the rss-aggregator-refresh line
```

`install.sh` bakes absolute repo paths into both the unit and the cron line — if the
repo moves, re-run it. `loginctl enable-linger $USER` is needed for boot start before
login. The cron line just curls the tick endpoint, so a tick cannot overlap itself: the
server returns `409` while a tick is still running.
