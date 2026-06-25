#!/bin/bash
set -euo pipefail

# 247 Web - Build + serve the Next.js standalone output (self-host / LAN).
#
# Why this script exists:
#   `next build` with output:'standalone' regenerates .next/standalone but does
#   NOT copy .next/static or public/ into it (a known Next.js gotcha). Serving
#   without that copy yields HTML 200 but every JS chunk 500/404 -> the browser
#   throws "Application error: a client-side exception has occurred". Worse, a
#   rebuild deletes the dir a still-running server holds open (cwd "(deleted)"),
#   so an old server keeps serving dead chunk hashes. This script does the copy
#   AND restarts the server cleanly so neither trap can bite.
#
# Usage:
#   scripts/start-web.sh              # build, copy assets, (re)start on :3001
#   scripts/start-web.sh --no-build   # skip build; just re-copy assets + restart
#   PORT=3001 WEB_DB_PATH=~/.247/data/web.db scripts/start-web.sh
#
# Env (all have sensible defaults):
#   PORT          listen port            (default 3001)
#   HOSTNAME      bind address           (default 0.0.0.0 — reachable over LAN)
#   WEB_DB_PATH   web sqlite db path     (default ~/.247/data/web.db)
#   NODE_ENV      node env               (default production)
#   LOG_FILE      server log destination (default /tmp/web-<PORT>.log)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WEB_DIR="$PROJECT_ROOT/apps/web"
STANDALONE_DIR="$WEB_DIR/.next/standalone/apps/web"

PORT="${PORT:-3001}"
# Use a dedicated var, NOT $HOSTNAME: most shells already export HOSTNAME to the
# machine name (e.g. "testai"), which would defeat ${HOSTNAME:-0.0.0.0} and make
# node bind to the hostname instead of all interfaces — breaking LAN access.
BIND_ADDR="${BIND_ADDR:-0.0.0.0}"
WEB_DB_PATH="${WEB_DB_PATH:-$HOME/.247/data/web.db}"
NODE_ENV="${NODE_ENV:-production}"
LOG_FILE="${LOG_FILE:-/tmp/web-$PORT.log}"

DO_BUILD=1
[ "${1:-}" = "--no-build" ] && DO_BUILD=0

cd "$PROJECT_ROOT"

if [ "$DO_BUILD" -eq 1 ]; then
  echo "==> Building 247-web (next build, standalone output)..."
  pnpm --filter 247-web build
fi

if [ ! -f "$STANDALONE_DIR/server.js" ]; then
  echo "Error: $STANDALONE_DIR/server.js not found."
  echo "Run a build first (omit --no-build), or check output:'standalone' in next.config."
  exit 1
fi

echo "==> Copying static + public into standalone (the Next.js gotcha)..."
# Remove stale copies first so deleted chunks don't linger across rebuilds.
rm -rf "$STANDALONE_DIR/.next/static" "$STANDALONE_DIR/public"
cp -r "$WEB_DIR/.next/static" "$STANDALONE_DIR/.next/static"
[ -d "$WEB_DIR/public" ] && cp -r "$WEB_DIR/public" "$STANDALONE_DIR/public"
echo "    static chunks: $(ls "$STANDALONE_DIR/.next/static/chunks/"*.js 2>/dev/null | wc -l)"

echo "==> Freeing port $PORT (kill any stale server)..."
# Kill by PORT, not by process name: next-server renames its process title to
# "next-server (v..)" so its argv no longer contains server.js — a name match
# misses it, the old server survives, and the new one dies on EADDRINUSE.
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" 2>/dev/null || true
elif command -v lsof >/dev/null 2>&1; then
  STALE_PIDS="$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)"
  # shellcheck disable=SC2086
  [ -n "$STALE_PIDS" ] && kill $STALE_PIDS 2>/dev/null || true
fi
sleep 1

echo "==> Starting server on $BIND_ADDR:$PORT (db=$WEB_DB_PATH)..."
cd "$STANDALONE_DIR"
# next-server reads HOSTNAME for its bind address; pass BIND_ADDR through as HOSTNAME.
WEB_DB_PATH="$WEB_DB_PATH" PORT="$PORT" HOSTNAME="$BIND_ADDR" NODE_ENV="$NODE_ENV" \
  nohup node server.js > "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "    pid $NEW_PID, log -> $LOG_FILE"

# Wait for readiness, then smoke-test that a real chunk serves (not just HTML).
sleep 3
ROOT_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || echo 000)"
CHUNK="$(curl -s "http://127.0.0.1:$PORT/connect" | grep -oE '/_next/static/[^"]+\.js' | head -1 || true)"
CHUNK_CODE="000"
[ -n "$CHUNK" ] && CHUNK_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$CHUNK" || echo 000)"

echo ""
echo "    GET /            -> HTTP $ROOT_CODE"
echo "    GET $CHUNK -> HTTP $CHUNK_CODE"
if [ "$ROOT_CODE" = "200" ] && [ "$CHUNK_CODE" = "200" ]; then
  echo "==> OK. Reachable at http://$BIND_ADDR:$PORT (LAN: http://<this-host-ip>:$PORT)"
else
  echo "==> WARNING: smoke test failed. Tail the log: tail -f $LOG_FILE"
  exit 1
fi
