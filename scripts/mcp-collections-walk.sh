#!/bin/bash
# Acceptance walk for the collection MCP tools (issue #83): run the built server against a
# COPY of an instance and drive all seven tools over Streamable HTTP MCP with
# scripts/mcp-walk.mjs. Read-only against the source: space and database are copied into a
# temp dir first, and every write afterwards stays below that dir. The scratch row the walk
# creates is deleted again by the walk itself. Needs node, sqlite3, curl and ss.
#
#   scripts/mcp-collections-walk.sh                                   # source defaults to the live instance on this host
#   LIVE_SPACE=/path/space LIVE_DB=/path/db.sqlite scripts/mcp-collections-walk.sh
#   WALK_COLLECTION=Rolodex scripts/mcp-collections-walk.sh           # walk a named collection
#   KEEP=1 scripts/mcp-collections-walk.sh                            # keep the temp dir for inspection
set -uo pipefail

REPO=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "walk: run inside the repo"; exit 1; }
LIVE_SPACE=${LIVE_SPACE:-/var/lib/stichpunkt/space}
LIVE_DB=${LIVE_DB:-/var/lib/stichpunkt/collections.sqlite}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/stichpunkt-mcp-walk.XXXXXX")
TOKEN="mcp-walk-token-0123456789-0123456789-abcdef"   # auth.ts rejects tokens below 32 chars

for p in $(seq 18096 18196); do
  ss -lnt 2>/dev/null | awk -v p=":$p" '$4 ~ p"$" {found=1} END {exit found}' && { PORT=$p; break; }
done
[ -n "${PORT:-}" ] || { echo "walk: FAIL no free port in 18096-18196"; exit 1; }

echo "walk: work dir $WORK"
echo "walk: source space $LIVE_SPACE, source db $LIVE_DB"
cp -aL "$LIVE_SPACE" "$WORK/space" || { echo "walk: FAIL copying space"; exit 1; }
sqlite3 "$LIVE_DB" ".backup '$WORK/collections.sqlite'" || { echo "walk: FAIL copying db"; exit 1; }
echo "walk: source copied; the live instance is never written to"

[ -f "$REPO/build/index.js" ] || ( cd "$REPO" && npm run build >/dev/null 2>&1 )
env -i PATH=/usr/bin:/bin HOME="$WORK" NODE_ENV=production PORT="$PORT" HOST=127.0.0.1 \
  COLLECTIONS_DB="$WORK/collections.sqlite" SPACE_DIR="$WORK/space" \
  MDWIKI_API_TOKEN="$TOKEN" /usr/bin/node "$REPO/build/index.js" >"$WORK/server.log" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null' EXIT

ready=1
for _ in $(seq 1 30); do
  sleep 1
  grep -q 'EADDRINUSE' "$WORK/server.log" && { ready=2; break; }
  # the healthz JSON proves the answer comes from our instance, not from whatever else listens
  curl -s --max-time 3 "http://127.0.0.1:$PORT/healthz" | grep -q '"checks"' && { ready=0; break; }
done
if [ $ready -ne 0 ]; then
  echo "walk: FAIL server not ready on port $PORT"
  tail -5 "$WORK/server.log"
  exit 1
fi
echo "walk: server ready on 127.0.0.1:$PORT"

( cd "$REPO" && WALK_COLLECTION="${WALK_COLLECTION:-}" node scripts/mcp-walk.mjs "http://127.0.0.1:$PORT" "$TOKEN" )
RC=$?

kill "$PID" 2>/dev/null
trap - EXIT
if [ "${KEEP:-0}" = "1" ]; then echo "walk: keeping $WORK for inspection"; else rm -rf "$WORK"; fi
exit $RC
