#!/bin/bash
# Restore drill for the instance export (docs/export.md): export a copy of an instance,
# restore that export into a fresh instance and compare page set, page bytes and row
# values. Read-only against the source: the drill copies space and database into a temp
# dir first and writes only below that dir afterwards. Isolation is proven by a marker
# page that must never appear in the source space and by an unchanged source collection
# list. Needs node, jq, sqlite3, curl and python3.
set -uo pipefail

REPO=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "drill: run inside the repo"; exit 1; }
LIVE_SPACE=${LIVE_SPACE:-$(systemctl show stichpunkt -p Environment --value 2>/dev/null | tr ' ' '\n' | sed -n 's/^SPACE_DIR=//p')}
LIVE_SPACE=${LIVE_SPACE:-/var/lib/stichpunkt/space}
LIVE_DB=${LIVE_DB:-/var/lib/stichpunkt/collections.sqlite}
PORT=${PORT:-}
if [ -z "$PORT" ]; then
  for p in $(seq 18096 18196); do
    if ss -lnt 2>/dev/null | awk -v p=":$p" '$4 ~ p"$" {found=1} END {exit found}'; then PORT=$p; break; fi
  done
  [ -n "$PORT" ] || { echo "drill: FAIL no free port in 18096-18196"; exit 1; }
fi
TOKEN="drill-token-$$-012345678901234567890123456789"   # auth.ts rejects tokens below 32 chars
TS=$(date -u +%Y%m%dT%H%M%SZ)
MARKER="Drill-Marker-$TS.md"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/stichpunkt-drill.XXXXXX")
LOG="$WORK/drill.log"
exec > >(tee -a "$LOG") 2>&1

fail=0
check() {
  if [ "$2" -eq 0 ]; then echo "check: $1 = ok"; else echo "check: $1 = FAIL ($3)"; fail=1; fi
}

echo "drill: work dir $WORK"
echo "drill: source space $LIVE_SPACE, source db $LIVE_DB"

# 1 copy the source instance; every write after this stays below $WORK
cp -aL "$LIVE_SPACE" "$WORK/src-space" || { echo "drill: FAIL copying space"; exit 1; }
sqlite3 "$LIVE_DB" ".backup '$WORK/src-db.sqlite'" || { echo "drill: FAIL copying db"; exit 1; }
printf '# Drill marker\n\nWritten by scripts/restore-drill.sh at %s so the drill proves fresh writes travel through export and restore.\n' "$TS" > "$WORK/src-space/$MARKER"
LIVE_COLLECTIONS_BEFORE=$(sqlite3 -readonly "$LIVE_DB" "SELECT name FROM collection ORDER BY name;")

# 2 export the copy with the CLI under test
( cd "$REPO" && COLLECTIONS_DB="$WORK/src-db.sqlite" SPACE_DIR="$WORK/src-space" npm run export -- "$WORK/tree" ) || { echo "drill: FAIL export"; exit 1; }
echo "drill: export.json header"
cat "$WORK/tree/export.json"

# 3 fresh instance: pages from the export tree, empty database created on first start
mkdir -p "$WORK/restored-space"
cp -a "$WORK/tree/pages/." "$WORK/restored-space/"
[ -f "$REPO/build/index.js" ] || ( cd "$REPO" && npm run build >/dev/null 2>&1 )
env -i PATH=/usr/bin:/bin HOME="$WORK" NODE_ENV=production PORT="$PORT" HOST=127.0.0.1 \
  COLLECTIONS_DB="$WORK/restored-db.sqlite" SPACE_DIR="$WORK/restored-space" \
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
check "fresh instance starts on port $PORT" $([ $ready -eq 0 ] && echo 0 || echo 1) "server.log: $(tail -2 "$WORK/server.log" | tr '\n' ' ')"
[ $ready -ne 0 ] && { echo "DRILL FAIL"; exit 1; }

# 4 restore every collection through the public API, exactly as docs/export.md describes;
#   select options are widened with values the exported rows actually carry, so legacy rows
#   whose value fell out of the options list still restore with their values intact
for entry in "$WORK"/tree/collections/*.json; do
  id=$(jq -c '
    . as $e
    | { name: $e.collection.name,
        icon: $e.collection.icon,
        properties: [ $e.collection.properties[]
          | . as $p
          | if ($p.type == "select" or $p.type == "multi_select") then
              ( [ $e.rows[] | .values[$p.name] // empty | if type == "array" then .[] else . end ] ) as $vals
              | ($p.options // []) as $opts
              | .options = ( $opts + ( $vals | map(select(. as $v | $opts | index($v) | not)) | unique ) )
            else . end ] }
    ' "$entry" |
    curl -fsS -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      --data-binary @- "http://127.0.0.1:$PORT/api/v1/databases" | jq -r .id) || { check "create collection from $(basename "$entry")" 1 "POST /api/v1/databases failed"; continue; }
  rows=0; bad=0
  while read -r row; do
    printf '%s' "$row" | curl -fsS -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      --data-binary @- "http://127.0.0.1:$PORT/api/v1/databases/$id/rows" >/dev/null || bad=1
    rows=$((rows + 1))
  done < <(jq -c '.rows[] | {values}' "$entry")
  check "restore $(basename "$entry") with $rows row(s)" $bad "a row POST failed"
done

# 5 re-export the fresh instance and compare against the source export tree
curl -fsS -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/v1/export" -o "$WORK/restored-bundle.json"
check "re-export the fresh instance" $? "GET /api/v1/export failed"
python3 - "$WORK" <<'PY'
import json, os, pathlib, sys
work = pathlib.Path(sys.argv[1])
restored = json.loads((work / 'restored-bundle.json').read_text())
tree = work / 'tree'
problems = []
disk = {}
for p in (tree / 'pages').rglob('*'):
    if p.is_file():
        disk[str(p.relative_to(tree / 'pages')).replace(os.sep, '/')] = p.read_text(encoding='utf8')
only_src, only_dst = set(disk) - set(restored['pages']), set(restored['pages']) - set(disk)
if only_src or only_dst:
    problems.append(f"page set differs: only-source={sorted(only_src)} only-restored={sorted(only_dst)}")
for rel, content in disk.items():
    if rel in restored['pages'] and restored['pages'][rel] != content:
        problems.append(f"page bytes differ: {rel}")

def norm(entry):
    props = []
    for p in entry['collection']['properties']:
        opts = set(p['options']) if p['options'] else set()
        props.append({
            'name': p['name'],
            'type': p['type'],
            'opts': opts if p['type'] in ('select', 'multi_select') else None,
        })
    return {
        'name': entry['collection']['name'],
        'icon': entry['collection']['icon'],
        'props': props,
        'rows': [row['values'] for row in entry['rows']],
    }

src = {}
for p in sorted((tree / 'collections').glob('*.json')):
    e = json.loads(p.read_text())
    src[e['collection']['name']] = norm(e)
dst = {e['collection']['name']: norm(e) for e in restored['collections']}
if set(src) != set(dst):
    problems.append(f"collection set differs: {sorted(set(src) ^ set(dst))}")
for name in sorted(set(src) & set(dst)):
    a, b = src[name], dst[name]
    if a['icon'] != b['icon'] or a['rows'] != b['rows']:
        problems.append(f"collection differs: {name}")
        continue
    if [p['name'] for p in a['props']] != [p['name'] for p in b['props']] or [p['type'] for p in a['props']] != [p['type'] for p in b['props']]:
        problems.append(f"collection properties differ: {name}")
        continue
    for pa, pb in zip(a['props'], b['props']):
        # the restore widens select options with legacy row values, so the source options
        # must survive as a subset rather than match exactly
        if pa['opts'] is not None and not pa['opts'] <= pb['opts']:
            problems.append(f"collection {name}: options lost for {pa['name']}: {sorted(pa['opts'] - pb['opts'])}")
marker = sorted(rel for rel in restored['pages'] if rel.startswith('Drill-Marker-'))
print(f"compare: pages={len(disk)} collections={len(src)} marker_page={marker or 'MISSING'}")
if not marker:
    problems.append("marker page did not travel through export and restore")
if problems:
    print("compare: FAIL")
    for p in problems:
        print("  -", p)
    sys.exit(1)
print("compare: source export and restored instance match on page set, page bytes and row values")
PY
check "export/restore round-trip" $? "see compare output above"

# 6 every produced CSV parses with the property names as header
python3 - "$WORK/tree/collections" <<'PY'
import csv, pathlib, sys
files = sorted(pathlib.Path(sys.argv[1]).glob('*.csv'))
if not files:
    print("csv: none produced")
    sys.exit(1)
for f in files:
    with f.open(newline='', encoding='utf8') as fh:
        rows = list(csv.reader(fh))
    print(f"csv: {f.name} header={rows[0]} data_rows={len(rows) - 1}")
PY
check "csv parses with property headers" $? "csv parse failed"

# 7 database and write path of the fresh instance are healthy; backup has no record yet
#   by design on a fresh instance, so /healthz answers 503 and the named checks decide
health=$(curl -s --max-time 5 "http://127.0.0.1:$PORT/healthz")
echo "$health" | jq -c '{status: .status, database: .checks.database.ok, write: .checks.write.ok, backup: .checks.backup.error // .checks.backup.last_at}'
echo "$health" | jq -e '.checks.database.ok == true and .checks.write.ok == true' >/dev/null
check "fresh instance database and write checks" $? "healthz: $health"

# 8 isolation: the source instance is untouched
[ ! -e "$LIVE_SPACE/$MARKER" ]
check "marker page absent from source space" $? "source space contains the marker"
LIVE_COLLECTIONS_AFTER=$(sqlite3 -readonly "$LIVE_DB" "SELECT name FROM collection ORDER BY name;")
[ "$LIVE_COLLECTIONS_BEFORE" = "$LIVE_COLLECTIONS_AFTER" ]
check "source collection list unchanged" $? "collection names differ before/after"

kill "$PID" 2>/dev/null
trap - EXIT
echo "drill: full log at $LOG"
if [ $fail -eq 0 ]; then echo "DRILL PASS"; else echo "DRILL FAIL"; fi
if [ "${KEEP:-0}" = "1" ]; then echo "drill: keeping $WORK for inspection"; else rm -rf "$WORK"; fi
exit $fail
