# Collections (SQLite databases)

A collection is a typed, relational table next to the notes. It is not a Markdown table and not a
view over page frontmatter: rows, properties, cells and saved views live in SQLite. The app renders
them at `/databases`, and agents work with them over the REST API under `/api/v1/databases` and the
matching MCP tools (`list_collections`, `get_collection`, `query_collection_rows`,
`create_collection_row`, `update_collection_row`, `delete_collection_row`, `save_collection_view`,
`collection_history`).
Both paths call the same service layer, so validation and conflict behaviour are identical.

## Where the data lives

```
/var/lib/stichpunkt/collections.sqlite     # default, override with COLLECTIONS_DB
```

The database is app state, not content, and therefore lives on local disk — not inside the
rclone-mounted space. Measured on this host: 2000 inserts take 47 ms locally and 1359 ms on the
mount, and a mount that drops mid-transaction is the classic way to a corrupt file. The space stays
the single content root, so this is not a second mount; `/var/lib/stichpunkt` is the one writable
state directory of the service.

The file is created on first use. Backups must copy it through SQLite, never as a raw file (see
below), and the directory is covered by the 03:30 job as `state/stichpunkt/`.

Backups must copy the database through SQLite, not as a raw file: `sqlite3 collections.sqlite ".backup '/path/collections.sqlite'"` (or `VACUUM INTO`). Copying the main file while WAL is active can produce a torn snapshot. Back up after the 03:30 job or in the same window, and include the file in the restore drill.

## Schema migrations

The schema has a version, currently **2**, stored in `PRAGMA user_version`. The ordered migration
list lives in `src/lib/server/migrations.ts`; step 1 is the baseline that also adopts databases created
before migrations existed (its `CREATE TABLE IF NOT EXISTS` statements are what the app used to run
on every start).

- The runner executes on the first `CollectionStore.open`, i.e. on boot, before the store is used.
- All pending steps of one run are committed in a single transaction together with their
  `user_version` bump. A failing step rolls back the whole run and the previous schema and data stay
  intact; the process fails instead of serving against a half-migrated file.
- Runs are idempotent: a database already at the current version applies nothing.
- Applied steps are logged as `[collections] applied v1 baseline`.
- Before the first write of a run, the database is copied through the `sqlite3` CLI (`.backup`) to
  `collections.sqlite.pre-migration-v<from>-<timestamp>.bak` next to the database. A new file has
  nothing to protect and gets no backup. A missing `sqlite3` binary aborts the migration before any
  write; the container image installs it.
- A database newer than the running build is refused instead of downgraded.

Inspect or run migrations while the service is stopped:

```
npm run migrate -- --dry-run          # report pending steps, write nothing
npm run migrate                       # back up, then migrate
npm run migrate -- --db /path/to/collections.sqlite
```

Add a schema change by appending a step with the next version and a short name. Never edit a step
that has shipped: production databases have already recorded its version.


## Model

| Table | Holds |
|---|---|
| `collection` | id, name, icon, timestamps |
| `property` | name, type, options, position; exactly one `title` property |
| `row` | id, collection, timestamps, position |
| `cell` | `(row, property) → value`; the value is JSON, typed through the property |
| `view` | name, filters, sorts, visible columns, group_by, aggregates, position |
| `revision` | every row create/update/delete with actor and before/after values |

Property types: `title`, `text`, `number`, `select`, `multi_select`, `date`, `checkbox`, `url`, `email`.
A cell is a row in `cell`, not a serialized blob — filtering and sorting happen in SQL.

## Filtering and sorting

Filters are `{property, op, value}`. Operators: `eq`, `neq`, `contains`, `not_contains`,
`starts_with`, `ends_with`, `gt`, `gte`, `lt`, `lte`, `is_empty`, `is_not_empty`, `any_of`, `none_of`.
Sorts are `{property, direction}` and stack. Every value is bound as a parameter; no user input is
concatenated into SQL.

A saved view stores filters, sorts, visible columns, a grouping and per-column aggregates. Explicit
request filters override the view's filters; the view's columns still apply.

## Grouping and aggregates

`group_by: {property, direction?}` (direction defaults to `asc`) groups the result of a query. The
response then carries `groups: [{key, count}]` and the rows come grouped: the group key leads the
order, the requested sorts stack inside each group.

The key is the raw stored value, so each group holds the rows that store exactly that value:

- dates are truncated to the day (`2026-01-05`), times within a day share one group;
- checkboxes group as `'true'` and `'false'`;
- empty and missing cells share the `null` key, which is ordered last in both directions;
- `multi_select` groups by the exact stored combination (`["a","b"]` is a different group from
  `["a"]`). There is no per-option fan-out: a row with two options does not appear under each.
  This is a known v1 limitation.

Group counts cover the whole filtered set, not the returned page, so a group split across pages
keeps its true count. The UI renders one collapsible section per group; collapsed keys travel in the
`collapsed` URL parameter, percent-encoded and comma-joined, and their rows are hidden server-side.

`aggregates: {property: fn}` computes one footer value per column over the whole filtered set; the
response carries `aggregates: {property: {fn, value}}`. Functions and the types they accept:

| fn | allowed for | notes |
|---|---|---|
| `count` | all types | the row count |
| `count_values` | all types | filled cells only; empty strings and `[]` do not count |
| `sum`, `average` | `number` | `average` divides by the filled count and is `null` when nothing is filled |
| `min`, `max` | `number`, `date`, `text`, `title`, `url`, `email` | compares the raw stored values |

Requests with an unknown group/aggregate property or a function the type does not allow fail with
`400` (`bad_group` / `bad_aggregate`) and change nothing. A saved view whose group or aggregate
property was later deleted (or whose type no longer allows the function) is the one exception: the
dangling entry is silently ignored at query time instead of breaking the view for everyone.

## Search

Row values are searchable from the normal wiki search. Rows live in the same index as the pages but as
their own document set, scored with the page corpus statistics — page ranking is unaffected. Hits from
rows share the one result list and carry a `row` object (collection, row, matched property and an `href`
that opens the row directly). Quoted phrases match within a single cell line; `#tag` and `in:folder`
queries stay page-scoped and skip rows. The index follows writes without a restart: it is seeded at boot
when the collections file already exists, attaches at the first open otherwise, and coalesces bursts of
row changes into one re-index a quarter second after the last write.

`scripts/search-rows-walk.sh` reruns the acceptance against a copy of an instance: it copies space and
database into a temp dir, starts the built server on a free port, searches a real value, then creates,
edits and deletes a scratch row over REST and asserts that every change reaches the index without a
restart and that a `#tag` query stays page-only. Every write stays below the temp dir, so the source
instance is never touched. A passing run ends with `WALK COMPLETE`; the capture in
`docs/assets/search-rows-evidence.png` shows one against a copy of the live instance.

## API

```
GET    /api/v1/databases                         list with row/view counts
POST   /api/v1/databases                         create {name, icon?, properties:[{name,type,options?}]}
GET    /api/v1/databases/:id                     collection, properties, views
PATCH  /api/v1/databases/:id                     rename {name?, icon?}
DELETE /api/v1/databases/:id

GET    /api/v1/databases/:id/rows?view=&limit=&offset=&group=prop&filter=prop:op:value&sort=prop:asc
POST   /api/v1/databases/:id/rows                {values:{...}, actor?}
PATCH  /api/v1/databases/:id/rows/:rowId         {values:{...}, actor?, base_updated_at?}
DELETE /api/v1/databases/:id/rows/:rowId
POST   /api/v1/databases/:id/query               {filters, sorts, limit, offset, view, group_by, aggregates}

GET    /api/v1/databases/:id/views
POST   /api/v1/databases/:id/views               {id?, name, filters?, sorts?, columns?, group_by?, aggregates?}
DELETE /api/v1/databases/:id/views/:viewId

GET    /api/v1/databases/:id/export?format=csv   download all rows; format=csv (default) or json
POST   /api/v1/databases/import/preview          {path} — report the tables of one page
POST   /api/v1/databases/import                  {path, table, name?, columns?, dry_run?}
```

`base_updated_at` makes an update optimistic: a stale timestamp returns `409` instead of overwriting.
`export` returns a read-only snapshot: CSV uses the property names as header and quotes on comma,
quote or line break; JSON keeps property types, options and row ids. An export can paginate past the
500-row query limit because the service pages internally. For the whole instance (all pages plus all
collections with a versioned header) see [docs/export.md](export.md).


## Markdown migration

`import/preview` parses pipe tables and infers unambiguous types (title column, all-numeric → number,
all-ISO-date → date, true/false → checkbox). It writes nothing. `import` creates a new collection from
one table and leaves the page untouched; the page and the collection then diverge, so a migration has
to decide which one becomes canonical.

## Notion reference

The implemented subset follows Notion's database model: one row per record, typed properties,
table view, filters, multi-key sorts, saved views per database, collapsible grouping with per-group
counts and footer aggregates. Not implemented yet: inline cell
editing, board/calendar/timeline layouts, relations/rollups/formulas, per-group aggregates, per-view property
visibility beyond columns, and per-cell revision display. Live updates ride the existing SSE stream
(`/_ui/events`), so an open table reloads when a row changes.

## Verification

`scripts/mcp-collections-walk.sh` runs the acceptance walk of the seven row-facing collection tools
(`save_collection_view` is not yet in the walk) against a
copy of an instance: it copies space and database into a temp dir, starts the built server on a
free port and drives every tool over Streamable HTTP MCP (`scripts/mcp-walk.ts`), including a
filtered query, the `409` conflict on a stale `base_updated_at`, a validation refusal and the
revision history of the scratch row it deletes again. Every write stays below the temp dir, so the
source instance is never touched. A passing run ends with `WALK COMPLETE`; the capture in
`docs/assets/mcp-collections-evidence.png` shows one against a copy of the live instance.
