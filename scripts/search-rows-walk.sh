#!/bin/bash
# Acceptance walk for search over collection rows (issue #84): run the built server against a
# COPY of an instance and prove that
#   - rows are searchable immediately after boot (a known real value finds its row),
#   - pages and rows merge into the one ranked list,
#   - creating, editing and deleting a row over REST propagates into the index without a restart,
#   - #tag/in: queries stay page-only.
# Read-only against the source: space and database are copied into a temp dir first, and every
# write afterwards hits the copy's REST API. The scratch row the walk creates is deleted again by
# the walk itself. Needs node, sqlite3, curl, jq and ss. Build first (npm run build) so the walk
# runs the current source.
#
#   scripts/search-rows-walk.sh                                    # source defaults to the live instance on this host
#   LIVE_SPACE=/path/space LIVE_DB=/path/db.sqlite scripts/search-rows-walk.sh
#   WALK_COLLECTION=Rolodex scripts/search-rows-walk.sh            # walk a named collection (default: first with rows)
#   WALK_QUERY=0176-12345678 scripts/search-rows-walk.sh           # known value for the boot-seeding query
#   KEEP=1 scripts/search-rows-walk.sh                             # keep the temp dir for inspection
set -uo pipefail

REPO=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "walk: run inside the repo"; exit 1; }
LIVE_SPACE=${LIVE_SPACE:-/var/lib/stichpunkt/space}
LIVE_DB=${LIVE_DB:-/var/lib/stichpunkt/collections.sqlite}
NODE=${NODE:-$(command -v node)}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/stichpunkt-search-walk.XXXXXX")
TOKEN="search-walk-token-0123456789-0123456789-abcdef"   # auth.ts rejects tokens below 32 chars
TS=$(date +%s)
FAIL=0

note() { echo; echo "--- $1 ---"; }
fail() { echo "walk: FAIL $1"; FAIL=1; }

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
  MDWIKI_API_TOKEN="$TOKEN" "$NODE" "$REPO/build/index.js" >"$WORK/server.log" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null' EXIT

ready=1
for _ in $(seq 1 30); do
  sleep 1
  grep -q 'EADDRINUSE' "$WORK/server.log" && { ready=2; break; }
  # the healthz JSON proves the answer comes from our instance, not from whatever else listens
  curl -s --max-time 3 "http://127.0.0.1:$PORT/healthz" | grep -q '"checks"' && { ready=0; break; }
done
[ $ready -eq 0 ] || { echo "walk: FAIL server not ready on port $PORT"; tail -5 "$WORK/server.log"; exit 1; }
echo "walk: server ready on 127.0.0.1:$PORT (pid $PID); rows seeded at boot because the db exists"

H="authorization: Bearer $TOKEN"
search() { curl -s -G -H "$H" "http://127.0.0.1:$PORT/api/v1/search" --data-urlencode "q=$1" --data-urlencode "limit=${2:-10}"; }
kinds() { jq -c '{rows, total, hits: [.results[] | if .row then {kind: "row", title, collection: .row.collectionName, property: .row.property, href: .row.href} else {kind: "page", title, path} end]}'; }
hasRow() { jq -e --arg id "$1" '[.results[] | select(.row != null and .row.rowId == $id)] | length == 1' >/dev/null; }

DBS=$(curl -s -H "$H" "http://127.0.0.1:$PORT/api/v1/databases")
if [ -n "${WALK_COLLECTION:-}" ]; then
  CID=$(echo "$DBS" | jq -r --arg n "$WALK_COLLECTION" '[.databases[] | select(.name == $n)][0].id // empty')
else
  CID=$(echo "$DBS" | jq -r '[.databases[] | select(.row_count > 0)][0].id // empty')
fi
[ -n "$CID" ] || { echo "walk: FAIL no collection to walk"; exit 1; }
CNAME=$(echo "$DBS" | jq -r --arg id "$CID" '.databases[] | select(.id == $id) | .name')
PROP=$(curl -s -H "$H" "http://127.0.0.1:$PORT/api/v1/databases/$CID" | jq -r '[.properties[] | select(.type == "title")][0].name // empty')
[ -n "$PROP" ] || { echo "walk: FAIL collection '$CNAME' has no title property"; exit 1; }
echo "walk: collection '$CNAME', title property '$PROP'"

KNOWN="${WALK_QUERY:-$(curl -s -H "$H" "http://127.0.0.1:$PORT/api/v1/databases/$CID/rows?limit=1" | jq -r --arg p "$PROP" '.rows[0].values[$p] // empty')}"
[ -n "$KNOWN" ] || { echo "walk: FAIL no known value to search (collection empty? set WALK_QUERY)"; exit 1; }

note "search q='$KNOWN' (a real value, indexed at boot; pages and rows in one ranked list)"
R=$(search "$KNOWN" 25)
echo "$R" | kinds
echo "$R" | jq -e '.rows >= 1' >/dev/null || fail "known value returned no row hits"

A="VELUX-$TS"; B="QORNIK-$TS$RANDOM"
note "create a scratch row over REST (value '$A'): searchable through the store subscription, no restart"
ROW=$(curl -s -X POST -H "$H" -H 'content-type: application/json' \
  -d "{\"values\":{\"$PROP\":\"$A\"},\"actor\":\"search-walk\"}" \
  "http://127.0.0.1:$PORT/api/v1/databases/$CID/rows")
ROWID=$(echo "$ROW" | jq -r '.id // empty'); BASE=$(echo "$ROW" | jq -r '.updated_at // empty')
[ -n "$ROWID" ] || fail "could not create the scratch row: $ROW"
sleep 1
R=$(search "$A"); echo "$R" | kinds
echo "$R" | hasRow "$ROWID" || fail "the new row is not searchable"

note "edit the cell (value '$B'): the new value is searchable, the old one is gone"
curl -s -X PATCH -H "$H" -H 'content-type: application/json' \
  -d "{\"values\":{\"$PROP\":\"$B\"},\"base_updated_at\":\"$BASE\",\"actor\":\"search-walk\"}" \
  "http://127.0.0.1:$PORT/api/v1/databases/$CID/rows/$ROWID" | jq -c '{id, updated_at}'
sleep 1
R=$(search "$B"); echo "$R" | kinds
echo "$R" | hasRow "$ROWID" || fail "the edited value is not searchable"
R=$(search "$A"); echo "$R" | jq -c '{old_value_rows: .rows}'
echo "$R" | jq -e '.rows == 0' >/dev/null || fail "the old value is still indexed"

# the content-type header matters: SvelteKit's CSRF guard rejects DELETE without it
note "delete the row: its hit disappears from the index"
curl -s -X DELETE -H "$H" -H 'content-type: application/json' \
  "http://127.0.0.1:$PORT/api/v1/databases/$CID/rows/$ROWID" | jq -c .
sleep 1
R=$(search "$B"); echo "$R" | jq -c '{rows, total}'
echo "$R" | jq -e '.rows == 0' >/dev/null || fail "the deleted row is still indexed"

note "filter query q='$KNOWN #zzz' stays page-only (rows skipped by design)"
R=$(search "$KNOWN #zzz")
echo "$R" | jq -c '{rows, total, filters}'
echo "$R" | jq -e '.rows == 0' >/dev/null || fail "a #tag query returned row hits"

note "server pid unchanged across the whole walk (no restart)"
ALIVE=$(ps -o pid= -p "$PID" | tr -d ' ')
echo "$ALIVE"
[ "$ALIVE" = "$PID" ] || fail "the server process changed during the walk"

kill "$PID" 2>/dev/null
trap - EXIT
if [ "${KEEP:-0}" = "1" ]; then echo "walk: keeping $WORK for inspection"; else rm -rf "$WORK"; fi
[ $FAIL -eq 0 ] || { echo "walk: FAILED"; exit 1; }
echo "WALK COMPLETE"
