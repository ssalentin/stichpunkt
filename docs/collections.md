# Collections (SQLite databases)

A collection is a typed, relational table next to the notes. It is not a Markdown table and not a
view over page frontmatter: rows, properties, cells and saved views live in SQLite. The app renders
them at `/databases`, and agents use the REST API under `/api/v1/databases`.

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

The schema has a version, currently **1**, stored in `PRAGMA user_version`. The ordered migration list
lives in `src/lib/server/migrations.ts`; step 1 is the baseline that also adopts databases created
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
| `view` | name, filters, sorts, visible columns, position |
| `revision` | every row create/update/delete with actor and before/after values |

Property types: `title`, `text`, `number`, `select`, `multi_select`, `date`, `checkbox`, `url`, `email`.
A cell is a row in `cell`, not a serialized blob — filtering and sorting happen in SQL.

## Filtering and sorting

Filters are `{property, op, value}`. Operators: `eq`, `neq`, `contains`, `not_contains`,
`starts_with`, `ends_with`, `gt`, `gte`, `lt`, `lte`, `is_empty`, `is_not_empty`, `any_of`, `none_of`.
Sorts are `{property, direction}` and stack. Every value is bound as a parameter; no user input is
concatenated into SQL.

A saved view stores filters, sorts and visible columns. Explicit request filters override the view's
filters; the view's columns still apply.

## API

```
GET    /api/v1/databases                         list with row/view counts
POST   /api/v1/databases                         create {name, icon?, properties:[{name,type,options?}]}
GET    /api/v1/databases/:id                     collection, properties, views
PATCH  /api/v1/databases/:id                     rename {name?, icon?}
DELETE /api/v1/databases/:id

GET    /api/v1/databases/:id/rows?view=&limit=&offset=&filter=prop:op:value&sort=prop:asc
POST   /api/v1/databases/:id/rows                {values:{...}, actor?}
PATCH  /api/v1/databases/:id/rows/:rowId         {values:{...}, actor?, base_updated_at?}
DELETE /api/v1/databases/:id/rows/:rowId
POST   /api/v1/databases/:id/query               {filters, sorts, limit, offset, view}

GET    /api/v1/databases/:id/views
POST   /api/v1/databases/:id/views               {id?, name, filters?, sorts?, columns?}
DELETE /api/v1/databases/:id/views/:viewId

GET    /api/v1/databases/:id/export?format=csv   download all rows; format=csv (default) or json
POST   /api/v1/databases/import/preview          {path} — report the tables of one page
POST   /api/v1/databases/import                  {path, table, name?, columns?, dry_run?}
```

`base_updated_at` makes an update optimistic: a stale timestamp returns `409` instead of overwriting.
`export` returns a read-only snapshot: CSV uses the property names as header and quotes on comma,
quote or line break; JSON keeps property types, options and row ids. An export can paginate past the
500-row query limit because the service pages internally.


## Markdown migration

`import/preview` parses pipe tables and infers unambiguous types (title column, all-numeric → number,
all-ISO-date → date, true/false → checkbox). It writes nothing. `import` creates a new collection from
one table and leaves the page untouched; the page and the collection then diverge, so a migration has
to decide which one becomes canonical.

## Notion reference

The implemented subset follows Notion's database model: one row per record, typed properties,
table view, filters, multi-key sorts, saved views per database. Not implemented yet: inline cell
editing, board/calendar/timeline layouts, relations/rollups/formulas, grouping, per-view property
visibility beyond columns, and per-cell revision display. Live updates ride the existing SSE stream
(`/_ui/events`), so an open table reloads when a row changes.
