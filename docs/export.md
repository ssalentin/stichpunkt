# Export

One export covers the whole instance: every Markdown page and every collection. The header is
stable — it records the export format version, the timestamp and the app version that produced the
bundle — so a restore can be matched to a build and an old bundle stays interpretable. Both
export paths are read-only against the space and the collections database.

## GET /api/v1/export

Requires `Authorization: Bearer <token>` like every route under `/api`. The response is the JSON
bundle, `Content-Type: application/json`, sent as an attachment named
`stichpunkt-export-<YYYY-MM-DD>.json`, with `Cache-Control: no-store`.

```json
{
  "format": "stichpunkt-export",
  "version": 1,
  "exported_at": "2026-11-15T10:00:00.000Z",
  "app_version": "1.0.0",
  "pages": { "Server/Alpha.md": "# Alpha\n…", "index.md": "…" },
  "collections": [
    {
      "format": "stichpunkt-collection",
      "version": 1,
      "exported_at": "2026-11-15T10:00:00.000Z",
      "collection": { "id": "…", "name": "Bücher", "icon": "📚", "properties": [ { "name": "Titel", "type": "title", "options": null } ] },
      "rows": [ { "id": "…", "created_at": "…", "updated_at": "…", "values": { "Titel": "Die Welt, \"neu\"" } } ],
      "csv": "Titel,…\r\n"
    }
  ]
}
```

`pages` maps each page file path relative to the space root (no leading slash) to its full content.
Each `collections` entry is the per-collection JSON snapshot ([docs/collections.md](collections.md))
plus a `csv` field with the same rows, RFC 4180 quoted. A consumer must check `format` and `version`
before reading the rest.

## npm run export

```sh
npm run export                    # ./stichpunkt-export-<timestamp>/
npm run export -- /tmp/backup     # explicit directory
```

The CLI needs no running server. It resolves `SPACE_DIR` and `COLLECTIONS_DB` exactly like the
service (see [Configuration](../README.md#configuration)) and writes:

```
export.json                 header: format, version, exported_at, app_version, pages and collections as counts
pages/<relPath>             every Markdown page, byte-identical to the file in the space
collections/<name>.json     one full collection snapshot per collection (the bundle entry without the csv field)
collections/<name>.csv      the same rows as RFC 4180, for spreadsheets
```

Collection names are slugged to ASCII for the file names (`Bücher` → `Bucher.json`), the full name
stays inside the JSON.

## Restoring into a fresh instance

The JSON, not the CSV, is canonical for a restore; the CSV is the spreadsheet view of the same
rows. The procedure is what the restore drill checks.

1. Prepare a fresh instance: an empty directory for `SPACE_DIR` and a fresh `COLLECTIONS_DB` path.
   The app creates and migrates the database on first start. Never point the restore at a live
   directory — the drill proves isolation against a copy, as always in CONTRIBUTING.md.
2. Copy the pages:

   ```sh
   cp -a <export-dir>/pages/. <new-space>/
   ```

3. Import each `collections/*.json` through the existing collection API: create the collection with
   `POST /api/v1/databases` (`name`, `icon`, `properties` come straight from the export), then post
   every row's `values` to `POST /api/v1/databases/<id>/rows`. With `jq` and `curl`:

   ```sh
   BASE=https://instance.example ; TOKEN=… ; entry=<export-dir>/collections/Bucher.json
   id=$(jq -c '{name: .collection.name, icon: .collection.icon, properties: .collection.properties}' "$entry" |
     curl -fsS -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
       --data-binary @- "$BASE/api/v1/databases" | jq -r .id)
   jq -c '.rows[] | {values}' "$entry" | while read -r row; do
     printf '%s' "$row" | curl -fsS -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
       --data-binary @- "$BASE/api/v1/databases/$id/rows" >/dev/null
   done
   ```

   Row ids, `created_at` and `updated_at` are assigned by the new instance; the export's ids are
   for diffing, not stable keys. Property names, types and options are preserved. Legacy rows can
    carry `select` or `multi_select` values that are no longer in the property's options list; the
    write API refuses those values, so widen the options in the create payload with the values the
    exported rows actually carry before posting the rows. `scripts/restore-drill.sh` does exactly
    that.
4. Verify: the UI renders the pages, and a re-run of `GET /api/v1/export` on the fresh instance
   returns the same page set and the same row values. `/healthz` must stay green.

## Restore drill

`scripts/restore-drill.sh` runs the procedure above end to end against a copy: it copies space and
database into a temp dir, adds a marker page, exports the copy with `npm run export`, starts a fresh
instance on a free port (first free in 18096-18196, or `PORT`) with an empty database, restores pages
and collections as described, then re-exports the fresh instance and compares page set, page bytes
and row values. Select options are compared as a subset because the restore widens them with legacy
row values where needed. It parses every produced CSV with an RFC 4180 reader and checks the
`database` and `write` entries of `/healthz` on the fresh instance (its `backup` check has no record
yet by design, so the endpoint answers 503 there). The drill writes only below its temp dir; it
proves isolation by checking that the marker page never appears in the source space and that the
source collection list is unchanged. A passing run prints one `check: … = ok` line per step and ends
with `DRILL PASS`.

```sh
scripts/restore-drill.sh                                  # source defaults to the live instance on this host
LIVE_SPACE=/path/space LIVE_DB=/path/db.sqlite scripts/restore-drill.sh   # any copyable source
KEEP=1 scripts/restore-drill.sh                           # keep the temp dir for inspection
```

## Limitations

- Attachments and other binary files (images, PDFs under `_attachments/`) are **not** included;
  the bundle carries Markdown pages and collection data only. A full backup still needs the space
  itself and a `sqlite3 .backup` copy of the database.
- Saved views, revisions and page history (`.history/`) are not part of the export.
- The export is a point-in-time snapshot without cross-system locking: a write that happens while
  the export runs may or may not be included.
