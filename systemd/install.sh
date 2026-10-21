#!/usr/bin/env bash
# Install the RSS Aggregator as a systemd *user* service (API only) plus a
# crontab entry that ticks the refresh API every 5 minutes.
#
# Usage: systemd/install.sh [--no-cron]
#
# Then:  systemctl enable --now --user rss-server
set -euo pipefail

INSTALL_CRON=1
for arg in "$@"; do
  case "$arg" in
    --no-cron) INSTALL_CRON=0 ;;
    *)
      echo "usage: $0 [--no-cron]" >&2
      exit 1
      ;;
  esac
done

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$REPO_DIR/systemd/rss-server.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/rss-server.service"
CRON_TAG="# rss-aggregator-refresh"
CRON_LOG="$REPO_DIR/refresh.log"

if [ ! -f "$TEMPLATE" ]; then
  echo "error: template not found at $TEMPLATE" >&2
  exit 1
fi

# The server must be built and the DB migrated before the service can run.
if [ ! -f "$REPO_DIR/dist/index.js" ]; then
  echo "error: backend not built — run 'npm install && npm run build' in $REPO_DIR first" >&2
  exit 1
fi
if [ ! -f "$REPO_DIR/frontend/dist/index.html" ]; then
  echo "error: frontend not built — run 'npm install && npm run build' in $REPO_DIR/frontend first" >&2
  exit 1
fi
if [ ! -f "$REPO_DIR/.env" ]; then
  echo "warning: no .env in $REPO_DIR — creating one with the default DATABASE_URL"
  printf 'DATABASE_URL="file:./prisma/dev.db"\n' > "$REPO_DIR/.env"
fi

mkdir -p "$UNIT_DIR"
sed "s|@REPO_DIR@|$REPO_DIR|g" "$TEMPLATE" > "$UNIT_FILE"
echo "installed $UNIT_FILE"

systemctl daemon-reload --user

if [ "$INSTALL_CRON" -eq 1 ]; then
  if ! command -v curl >/dev/null 2>&1; then
    echo "error: curl not found in PATH — cannot install the refresh cron job" >&2
    exit 1
  fi
  if ! command -v crontab >/dev/null 2>&1; then
    echo "warning: crontab not found — install cron and add this entry manually:" >&2
    echo "  */5 * * * * curl -fsS --max-time 300 -X POST http://127.0.0.1:3000/api/refresh/tick >> \"$CRON_LOG\" 2>&1 $CRON_TAG" >&2
  else
    CRON_LINE="*/5 * * * * curl -fsS --max-time 300 -X POST http://127.0.0.1:3000/api/refresh/tick >> \"$CRON_LOG\" 2>&1 $CRON_TAG"
    CURRENT_CRON="$(crontab -l 2>/dev/null || true)"
    FILTERED_CRON="$(printf '%s\n' "$CURRENT_CRON" | grep -vF "$CRON_TAG" || true)"

    {
      if [ -n "$FILTERED_CRON" ]; then
        printf '%s\n' "$FILTERED_CRON"
      fi
      printf '%s\n' "$CRON_LINE"
    } | crontab -

    echo "installed cron job (every 5 minutes), log: $CRON_LOG"
  fi
fi

echo "done. Start the API with: systemctl enable --now --user rss-server"
