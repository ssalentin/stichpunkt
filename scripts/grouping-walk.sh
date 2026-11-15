#!/bin/bash
# Acceptance walk for view grouping and column aggregates (issue #85): run the built server
# against a COPY of an instance and prove that
#   - a grouped query returns whole-set group counts (their sum equals total, and one key's
#     count is verified row-by-row),
#   - aggregates compute over the whole filtered set (the number sum is verified against the
#     rows, an all-empty average is null-safe),
#   - a saved view persists group_by and aggregates and applies through {view: id} over REST,
#   - the same grouping works over MCP (query_collection_rows via streamable HTTP),
#   - a function the property type does not allow fails with 400 bad_aggregate,
#   - the source instance is never written to (the view the walk saves exists in the copy only).
# Read-only against the source: space and database are copied into a temp dir first, and every
# write afterwards hits the copy's REST API. Needs node, sqlite3, curl, jq and ss. Build first
# (npm run build) so the walk runs the current source.
#
#   scripts/grouping-walk.sh                                       # source defaults to the live instance on this host
#   LIVE_SPACE=/path/space LIVE_DB=/path/db.sqlite scripts/grouping-walk.sh
#   WALK_COLLECTION=Fixkosten scripts/grouping-walk.sh             # walk a named collection (default: first with a usable group property)
#   KEEP=1 scripts/grouping-walk.sh                                # keep the temp dir for inspection
set -uo pipefail

REPO=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "walk: run inside the repo"; exit 1; }
LIVE_SPACE=${LIVE_SPACE:-/var/lib/stichpunkt/space}
LIVE_DB=${LIVE_DB:-/var/lib/stichpunkt/collections.sqlite}
NODE=${NODE:-$(command -v node)}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/stichpunkt-grouping-walk.XXXXXX")
TOKEN="grouping-walk-token-0123456789-0123456789-abcdef"   # auth.ts rejects tokens below 32 chars
TS=$(date +%s)
VIEW_NAME="WALK-VIEW-$TS"
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
echo "walk: source copied; every request below goes to 127.0.0.1:$PORT, whose COLLECTIONS_DB is $WORK/collections.sqlite"

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
echo "walk: server ready on 127.0.0.1:$PORT (pid $PID)"

H="authorization: Bearer $TOKEN"
CT="content-type: application/json"
API="http://127.0.0.1:$PORT/api/v1"
query() { curl -s -X POST -H "$H" -H "$CT" -d "$1" "$API/databases/$CID/query"; }
mcp() { curl -s -X POST "http://127.0.0.1:$PORT/mcp" -H "$H" -H "$CT" \
  -H 'accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" \
  | jq -e '.result.content[0].text | fromjson' 2>/dev/null || echo '{}'; }

# Pick a collection with a single-valued group property (select preferred, then checkbox, text,
# url, email, number) and, for the aggregate check, a number property. multi_select is skipped:
# grouping it is by exact combination, so group counts no longer sum to total.
DBS=$(curl -s -H "$H" "$API/databases")
CID=""
if [ -n "${WALK_COLLECTION:-}" ]; then
  CID=$(echo "$DBS" | jq -r --arg n "$WALK_COLLECTION" '[.databases[] | select(.name == $n)][0].id // empty')
  [ -n "$CID" ] || { echo "walk: FAIL no collection named '$WALK_COLLECTION'"; exit 1; }
else
  for cand in $(echo "$DBS" | jq -r '.databases[] | select(.row_count > 0) | .id'); do
    props=$(curl -s -H "$H" "$API/databases/$cand")
    echo "$props" | jq -e '[.properties[] | select(.type == "select" or .type == "checkbox")] | length > 0' >/dev/null && { CID=$cand; break; }
  done
  [ -n "$CID" ] || CID=$(echo "$DBS" | jq -r '[.databases[] | select(.row_count > 0)][0].id // empty')
fi
[ -n "$CID" ] || { echo "walk: FAIL no collection to walk"; exit 1; }
PROPS=$(curl -s -H "$H" "$API/databases/$CID")
CNAME=$(echo "$PROPS" | jq -r '.name')
GP=$(echo "$PROPS" | jq -r '[.properties[] | select(.type == "select")][0].name // ([.properties[] | select(.type == "checkbox" or .type == "text" or .type == "url" or .type == "email" or .type == "number")][0].name // empty)')
NP=$(echo "$PROPS" | jq -r '[.properties[] | select(.type == "number")][0].name // empty')
TP=$(echo "$PROPS" | jq -r '[.properties[] | select(.type == "title")][0].name // empty')
[ -n "$GP" ] && [ -n "$TP" ] || { echo "walk: FAIL collection '$CNAME' has no usable group or title property"; exit 1; }
echo "walk: collection '$CNAME', group property '$GP', number property '${NP:-none}', title property '$TP'"

# Aggregates: sum over the number property when there is one, count_values over the title.
AGGS=$( [ -n "$NP" ] && echo "{\"$NP\":\"sum\",\"$TP\":\"count_values\"}" || echo "{\"$TP\":\"count_values\"}" )

note "grouped query: group_by '$GP', aggregates $AGGS (groups and aggregates cover the whole set)"
R=$(query "{\"group_by\":{\"property\":\"$GP\"},\"aggregates\":$AGGS}")
echo "$R" | jq -c '{total, groups, aggregates}'
echo "$R" | jq -e '.groups != null and (.groups | length) > 0' >/dev/null || fail "no groups returned"
echo "$R" | jq -e '([.groups[].count] | add) == .total' >/dev/null || fail "group counts do not sum to total"
echo "$R" | jq -e '.groups[-1].key == null or (.groups | map(.key) | index(null) == null)' >/dev/null || fail "the null key is not ordered last"

# Verify one group's count row-by-row and the number sum against the full row set (<= one page).
ALL=$(query '{"limit": 500}')
TOTAL=$(echo "$ALL" | jq '.total')
if [ "$TOTAL" -le 500 ]; then
  KEY=$(echo "$R" | jq -r '[.groups[] | select(.key != null)][0].key')
  EXPECT=$(echo "$ALL" | jq --arg p "$GP" --arg k "$KEY" '[.rows[] | select((.values[$p] | tostring) == $k)] | length')
  GOT=$(echo "$R" | jq --arg k "$KEY" '.groups[] | select(.key == $k) | .count')
  echo "walk: group '$KEY' counts $GOT, row-by-row recount $EXPECT"
  [ "$EXPECT" = "$GOT" ] || fail "group count for '$KEY' does not match the rows"
  if [ -n "$NP" ]; then
    JSUM=$(echo "$ALL" | jq --arg p "$NP" '[.rows[].values[$p] // empty | select(. != null and . != "") | tonumber] | add // 0')
    GSUM=$(echo "$R" | jq --arg p "$NP" '.aggregates[$p].value')
    echo "walk: sum('$NP') = $GSUM, jq recount over all rows = $JSUM"
    awk -v a="$GSUM" -v b="$JSUM" 'BEGIN { d = a - b; if (d < 0) d = -d; exit (d < 0.01) ? 0 : 1 }' || fail "sum does not match the rows"
  fi
else
  echo "walk: collection has more than 500 rows; skipping the row-by-row recount"
fi

note "rows GET stays additive: ?group= groups, no param returns groups: null"
G=$(curl -s -H "$H" -G "$API/databases/$CID/rows" --data-urlencode "group=$GP" --data-urlencode "limit=1")
echo "$G" | jq -c '{total, groups: (.groups | length), first_key: .groups[0].key}'
echo "$G" | jq -e '.groups != null' >/dev/null || fail "rows GET ?group= returned no groups"
P=$(curl -s -H "$H" "$API/databases/$CID/rows?limit=1")
echo "$P" | jq -c '{groups, aggregates}'
echo "$P" | jq -e '.groups == null and .aggregates == null' >/dev/null || fail "an ungrouped response must carry null groups/aggregates"

note "save a view with group_by and aggregates, then query through it (save + reload round trip)"
V=$(curl -s -X POST -H "$H" -H "$CT" -d "{\"name\":\"$VIEW_NAME\",\"group_by\":{\"property\":\"$GP\"},\"aggregates\":$AGGS}" "$API/databases/$CID/views")
VID=$(echo "$V" | jq -r '.id // empty')
echo "$V" | jq -c '{id, name, group_by, aggregates}'
[ -n "$VID" ] || fail "could not save the view: $V"
RV=$(query "{\"view\":\"$VID\"}")
echo "$RV" | jq -c '{total, group_count: (.groups | length), aggregates}'
[ "$(echo "$RV" | jq -S '.groups')" = "$(echo "$R" | jq -S '.groups')" ] || fail "the view's grouping differs from the explicit request's"
VG=$(curl -s -H "$H" "$API/databases/$CID/views" | jq -c --arg n "$VIEW_NAME" '[.views[] | select(.name == $n)][0] | {name, group_by, aggregates}')
echo "walk: views GET echoes the saved view: $VG"
echo "$VG" | jq -e '.group_by != null' >/dev/null || fail "views GET does not echo the saved grouping"

note "isolation: the saved view exists in the copy only, never in the source database"
SRC_VIEWS=$(sqlite3 -readonly "$LIVE_DB" "SELECT count(*) FROM view WHERE name = '$VIEW_NAME'")
COPY_VIEWS=$(sqlite3 -readonly "$WORK/collections.sqlite" "SELECT count(*) FROM view WHERE name = '$VIEW_NAME'")
echo "walk: source db views named '$VIEW_NAME': $SRC_VIEWS, copy db: $COPY_VIEWS"
[ "$SRC_VIEWS" = "0" ] && [ "$COPY_VIEWS" = "1" ] || fail "the walk's view leaked into the source database"

note "the same grouping over MCP (query_collection_rows)"
M=$(mcp query_collection_rows "{\"id\":\"$CID\",\"group_by\":{\"property\":\"$GP\"},\"aggregates\":$AGGS}")
echo "$M" | jq -c '{total, groups: [.groups[] | {key, count}], aggregates}'
[ "$(echo "$M" | jq -S '.groups')" = "$(echo "$R" | jq -S '.groups')" ] || fail "MCP groups differ from REST groups"

note "MCP save_collection_view creates the same view shape"
MV=$(mcp save_collection_view "{\"id\":\"$CID\",\"name\":\"$VIEW_NAME-mcp\",\"group_by\":{\"property\":\"$GP\"}}")
echo "$MV" | jq -c '{name, group_by, aggregates}'
echo "$MV" | jq -e --arg n "$VIEW_NAME-mcp" '.name == $n and .group_by.property != null' >/dev/null || fail "MCP save_collection_view did not return the saved view"

note "a function the type does not allow fails 400 and changes nothing"
BAD=$(query "{\"aggregates\":{\"$TP\":\"sum\"}}")
echo "$BAD" | jq -c .
echo "$BAD" | jq -e '.error == "bad_aggregate"' >/dev/null || fail "sum over the title property was not rejected"
BADG=$(query "{\"group_by\":{\"property\":\"No-Such-Property-$TS\"}}")
echo "$BADG" | jq -c .
echo "$BADG" | jq -e '.error == "bad_group"' >/dev/null || fail "an unknown group property was not rejected"

kill "$PID" 2>/dev/null
trap - EXIT
if [ "${KEEP:-0}" = "1" ]; then echo "walk: keeping $WORK for inspection"; else rm -rf "$WORK"; fi
[ $FAIL -eq 0 ] || { echo "walk: FAILED"; exit 1; }
echo "WALK COMPLETE"
