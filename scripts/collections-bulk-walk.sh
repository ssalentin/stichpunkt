#!/bin/bash
# Acceptance walk for bulk edit and undo of collection rows (issue #86): run the built server
# against a COPY of an instance and prove that
#   - a dry run reports would_update and writes nothing,
#   - a bulk change over REST updates every named row as one batch with one revision per row,
#   - undo reverses the batch: the rows' cells are byte-identical to the pre-batch snapshot,
#   - a batch can only be undone once, and a stale base_updated_at aborts with a 409 that
#     names the row,
#   - none of this touches rows the walk did not create.
# The walk writes only its own marker rows and deletes them again. Read-only against the
# source: space and database are copied into a temp dir first. Needs node, sqlite3, curl, jq
# and ss. Build first (npm run build) so the walk runs the current source.
#
#   SOURCE_SPACE=/path/space SOURCE_DB=/path/db.sqlite scripts/collections-bulk-walk.sh
#   WALK_COLLECTION=Rolodex ... scripts/collections-bulk-walk.sh   # named collection (default: first with rows)
#   KEEP=1 ...                                                    # keep the temp dir for inspection
set -uo pipefail

REPO=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "walk: run inside the repo"; exit 1; }
[ -n "${SOURCE_SPACE:-}" ] && [ -n "${SOURCE_DB:-}" ] || { echo "walk: SOURCE_SPACE and SOURCE_DB are required (the instance to copy)"; exit 1; }
[ -d "$SOURCE_SPACE" ] && [ -f "$SOURCE_DB" ] || { echo "walk: SOURCE_SPACE/SOURCE_DB not readable"; exit 1; }
NODE=${NODE:-$(command -v node)}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/stichpunkt-bulk-walk.XXXXXX")
TOKEN="bulk-walk-token-0123456789-0123456789-abcdef"   # auth.ts rejects tokens below 32 chars
TS=$(date +%s)
FAIL=0

note() { echo; echo "--- $1 ---"; }
fail() { echo "walk: FAIL $1"; FAIL=1; }

for p in $(seq 18197 18297); do
  ss -lnt 2>/dev/null | awk -v p=":$p" '$4 ~ p"$" {found=1} END {exit found}' && { PORT=$p; break; }
done
[ -n "${PORT:-}" ] || { echo "walk: FAIL no free port in 18197-18297"; exit 1; }

echo "walk: work dir $WORK"
echo "walk: source space $SOURCE_SPACE, source db $SOURCE_DB"
cp -aL "$SOURCE_SPACE" "$WORK/space" || { echo "walk: FAIL copying space"; exit 1; }
sqlite3 "$SOURCE_DB" ".backup '$WORK/collections.sqlite'" || { echo "walk: FAIL copying db"; exit 1; }
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
echo "walk: server ready on 127.0.0.1:$PORT (pid $PID)"

H="authorization: Bearer $TOKEN"
J='content-type: application/json'
API="http://127.0.0.1:$PORT/api/v1/databases"
q() { sqlite3 "$WORK/collections.sqlite" "$1"; }

DBS=$(curl -s -H "$H" "$API")
if [ -n "${WALK_COLLECTION:-}" ]; then
  CID=$(echo "$DBS" | jq -r --arg n "$WALK_COLLECTION" '[.databases[] | select(.name == $n)][0].id // empty')
else
  CID=$(echo "$DBS" | jq -r '[.databases[] | select(.row_count > 0)][0].id // empty')
fi
[ -n "$CID" ] || { echo "walk: FAIL no collection to walk"; exit 1; }
CNAME=$(echo "$DBS" | jq -r --arg id "$CID" '.databases[] | select(.id == $id) | .name')
COLL=$(curl -s -H "$H" "$API/$CID")
PROP=$(echo "$COLL" | jq -r '[.properties[] | select(.type == "title")][0].name // empty')
BP=$(echo "$COLL" | jq -c '([.properties[] | select(.type == "text")][0]) // ([.properties[] | select(.type == "select" and ((.options // []) | length) > 0)][0]) // ([.properties[] | select(.type == "number")][0]) // ([.properties[] | select(.type == "checkbox")][0]) // null')
[ -n "$PROP" ] || { echo "walk: FAIL collection '$CNAME' has no title property"; exit 1; }
[ "$BP" != "null" ] || { echo "walk: FAIL collection '$CNAME' has no property to bulk-change"; exit 1; }
BPROP=$(echo "$BP" | jq -r '.name'); BTYPE=$(echo "$BP" | jq -r '.type')
# BVAL is the batch value, BVAL2 only ever appears in the aborted batch — both must differ.
case "$BTYPE" in
  text)     BVAL="bulk-$TS";   BVAL2="never-$TS";;
  select)   BVAL=$(echo "$BP" | jq -r '.options[0]')
            BVAL2=$(echo "$BP" | jq -r --arg a "$BVAL" '(.options - [$a])[0] // empty')
            [ -n "$BVAL2" ] || { echo "walk: FAIL select '$BPROP' needs two options to walk"; exit 1; };;
  number)   BVAL=$((TS % 100000)); BVAL2=$((TS % 100000 + 7));;
  checkbox) BVAL=true; BVAL2=false;;
esac
case "$BTYPE" in
  text|select) VJSON="{\"$BPROP\":\"$BVAL\"}";  VJSON2="{\"$BPROP\":\"$BVAL2\"}";  JV="\"$BVAL\"";  JV2="\"$BVAL2\"" ;;
  *)           VJSON="{\"$BPROP\":$BVAL}";      VJSON2="{\"$BPROP\":$BVAL2}";      JV="$BVAL";     JV2="$BVAL2" ;;
esac
echo "walk: collection '$CNAME', title '$PROP', bulk property '$BPROP' ($BTYPE): $BVAL / $BVAL2"

note "create three marker rows (the walk only ever writes these)"
IDS=(); BASES=()
for i in 1 2 3; do
  ROW=$(curl -s -X POST -H "$H" -H "$J" \
    -d "{\"values\":{\"$PROP\":\"BULKWALK-$TS-$i\"},\"actor\":\"bulk-walk\"}" "$API/$CID/rows")
  id=$(echo "$ROW" | jq -r '.id // empty')
  [ -n "$id" ] || { echo "walk: FAIL creating marker row: $ROW"; exit 1; }
  IDS+=("$id"); BASES+=("$(echo "$ROW" | jq -r '.updated_at')")
done
IN_LIST="'${IDS[0]}','${IDS[1]}','${IDS[2]}'"
cells() { q "SELECT row_id||'='||property_id||':'||value FROM cell WHERE row_id IN ($IN_LIST) ORDER BY row_id, property_id"; }
BEFORE_CELLS=$(cells)
BEFORE_REVS=$(q "SELECT count(*) FROM revision WHERE row_id IN ($IN_LIST)")

note "dry run: would_update=3 and nothing is written"
DRY=$(curl -s -X POST -H "$H" -H "$J" \
  -d "{\"rows\":[{\"id\":\"${IDS[0]}\",\"base_updated_at\":\"${BASES[0]}\"},{\"id\":\"${IDS[1]}\",\"base_updated_at\":\"${BASES[1]}\"},{\"id\":\"${IDS[2]}\",\"base_updated_at\":\"${BASES[2]}\"}],\"values\":$VJSON,\"dry_run\":true,\"actor\":\"bulk-walk\"}" \
  "$API/$CID/rows/bulk")
echo "$DRY" | jq -c .
echo "$DRY" | jq -e '.would_update == 3 and (.updated | not)' >/dev/null || fail "dry run answer is not {would_update: 3}"
[ "$(cells)" = "$BEFORE_CELLS" ] || fail "the dry run wrote cells"
[ "$(q "SELECT count(*) FROM revision WHERE row_id IN ($IN_LIST)")" = "$BEFORE_REVS" ] || fail "the dry run wrote revisions"

note "bulk edit all three rows as one batch"
BULK=$(curl -s -X POST -H "$H" -H "$J" \
  -d "{\"rows\":[{\"id\":\"${IDS[0]}\"},{\"id\":\"${IDS[1]}\"},{\"id\":\"${IDS[2]}\"}],\"values\":$VJSON,\"actor\":\"bulk-walk\"}" \
  "$API/$CID/rows/bulk")
echo "$BULK" | jq -c .
BATCH=$(echo "$BULK" | jq -r '.batch_id // empty')
[ -n "$BATCH" ] && [ "$(echo "$BULK" | jq -r '.updated')" = "3" ] || fail "bulk answer is not {batch_id, updated: 3}"
[ "$(q "SELECT count(*) FROM revision WHERE batch_id = '$BATCH'")" = "3" ] || fail "the batch did not write exactly three revisions"
[ "$(q "SELECT count(*) FROM revision WHERE batch_id = '$BATCH' AND undo_of IS NOT NULL")" = "0" ] || fail "batch revisions should carry undo_of = null"
[ "$(q "SELECT count(*) FROM cell WHERE row_id IN ($IN_LIST) AND value = '$JV'")" = "3" ] || fail "not every marker row holds the new value"

note "undo the batch: cells are byte-identical to the pre-batch snapshot"
UND=$(curl -s -X POST -H "$H" -H "$J" -d "{\"actor\":\"bulk-walk\"}" "$API/$CID/rows/bulk/$BATCH/undo")
echo "$UND" | jq -c .
UBATCH=$(echo "$UND" | jq -r '.batch_id // empty')
[ -n "$UBATCH" ] && [ "$UBATCH" != "$BATCH" ] && [ "$(echo "$UND" | jq -r '.undone')" = "3" ] || fail "undo answer is not a new batch with undone: 3"
[ "$(cells)" = "$BEFORE_CELLS" ] || fail "the undo did not restore the exact pre-batch cells"
[ "$(q "SELECT count(*) FROM revision WHERE batch_id = '$UBATCH' AND undo_of = '$BATCH'")" = "3" ] || fail "undo revisions should name the source batch"

note "a batch can only be undone once"
AGAIN=$(curl -s -X POST -H "$H" -H "$J" -d '{}' "$API/$CID/rows/bulk/$BATCH/undo")
echo "$AGAIN" | jq -c .
echo "$AGAIN" | jq -e '.error == "batch_undone"' >/dev/null || fail "second undo was not refused with batch_undone"

note "a stale base_updated_at aborts the whole batch and names the row"
STALE=$(curl -s -X POST -H "$H" -H "$J" \
  -d "{\"rows\":[{\"id\":\"${IDS[0]}\"},{\"id\":\"${IDS[1]}\",\"base_updated_at\":\"1970-01-01T00:00:00.000Z\"}],\"values\":$VJSON2,\"actor\":\"bulk-walk\"}" \
  "$API/$CID/rows/bulk")
echo "$STALE" | jq -c .
echo "$STALE" | jq -e --arg id "${IDS[1]}" --arg t "BULKWALK-$TS-2" \
  '.error == "conflict" and .row_id == $id and .title == $t and (.message | contains("changed since it was loaded")) and (.current | type == "string")' >/dev/null \
  || fail "stale bulk did not answer 409 naming the row with row_id/title/current"
[ "$(q "SELECT count(*) FROM cell WHERE row_id IN ($IN_LIST) AND value = '$JV2'")" = "0" ] || fail "the aborted batch wrote something"

note "the walk touched no other row"
[ "$(q "SELECT count(*) FROM revision WHERE batch_id IN ('$BATCH','$UBATCH') AND row_id NOT IN ($IN_LIST)")" = "0" ] || fail "a batch reached outside its marker rows"
[ "$(q "SELECT count(*) FROM revision WHERE row_id IN ($IN_LIST)")" -gt "$BEFORE_REVS" ] || fail "the marker rows gained no revisions"

note "delete the marker rows again"
for id in "${IDS[@]}"; do
  curl -s -X DELETE -H "$H" -H "$J" "$API/$CID/rows/$id" | jq -c .
done
[ "$(q "SELECT count(*) FROM \"row\" WHERE id IN ($IN_LIST)")" = "0" ] || fail "a marker row survived the walk"

kill "$PID" 2>/dev/null
trap - EXIT
if [ "${KEEP:-0}" = "1" ]; then echo "walk: keeping $WORK for inspection"; else rm -rf "$WORK"; fi
[ $FAIL -eq 0 ] || { echo "walk: FAILED"; exit 1; }
echo "WALK COMPLETE"
