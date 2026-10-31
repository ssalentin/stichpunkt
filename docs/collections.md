# Collections (SQLite databases)

A collection is a typed, relational table next to the notes. It is not a Markdown table and not a
view over page frontmatter: rows, properties, cells and saved views live in SQLite. The app renders
them at `/databases`, and agents use the REST API under `/api/v1/databases`.

## Where the data lives

```
<SPACE_DIR>/.stichpunkt/collections.sqlite
```

One directory for content and data — no second mount. The space directory **must be on local disk**.
SQLite on a network or FUSE mount (rclone, NFS, SMB) risks `database is locked` and corruption, so a
space that still lives on the Storage Box has to be moved local before collections are enabled;
the Storage Box then receives backups.

The file is created on first use. `.stichpunkt/` is a dot directory, so the page scanner ignores it.

Backups must copy the database through SQLite, not as a raw file: `sqlite3 collections.sqlite ".backup '/path/collections.sqlite'"` (or `VACUUM INTO`). Copying the main file while WAL is active can produce a torn snapshot. Back up after the 03:30 job or in the same window, and include the file in the restore drill.

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

POST   /api/v1/databases/import/preview          {path} — report the tables of one page
POST   /api/v1/databases/import                  {path, table, name?, columns?, dry_run?}
```

`base_updated_at` makes an update optimistic: a stale timestamp returns `409` instead of overwriting.

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
