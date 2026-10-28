# Page operations, history and diff

Agent-facing MCP tools and the matching REST routes. Page paths never carry `.md` or a leading slash. All routes require `Authorization: Bearer <token>`.

| MCP tool | REST | Purpose |
| --- | --- | --- |
| `move_page` | `POST /api/v1/pages/move` | move or rename a page, rewrite links |
| `write_pages` | `POST /api/v1/pages/batch` | write several pages atomically |
| `check_links` | `GET /api/v1/links` | read-only link audit |
| `history` | `GET /api/v1/history/<path>` | revision list |
| `diff` | `GET /api/v1/diff/<path>` | unified diff against a revision |

Writes (`write_page`, `write_pages`, `append_to_page`, `delete_page`, `move_page`) keep the previous content under `.history/<path>/<timestamp>-<hash>.md`. Direct file edits are **not** versioned: only the MCP and REST write paths call the revision store.

## move_page

```
move_page(from, to, dry_run?)
POST /api/v1/pages/move   { "from": "Notes/Contact", "to": "Archive/Contact", "dry_run": false }
```

```jsonc
{
  "from": "Notes/Contact", "to": "Archive/Contact", "dry_run": false, "moved": true,
  "rewritten": [{ "path": "Notes/Overview", "links": 2 }],
  "unresolved": [],
  "warnings": []
}
```

- A link is rewritten only when it resolved to the old page before the move and would not resolve to the new page afterwards. Unique-basename links (`[[Contact]]`) keep working and stay untouched.
- `#Heading`, `|alias` and `![[…]]` survive; nothing inside fenced or inline code is touched.
- `unresolved` lists links that could refer to the page but cannot be rewritten safely (`ambiguous_basename`, `unresolvable`).
- Existing destination → `409 target_exists`; same path → `400`; missing source → `404`. `dry_run` returns the plan without writing.

## write_pages

```
write_pages(pages, dry_run?, agent?)
POST /api/v1/pages/batch   { "pages": [{ "path": "Notes/One", "content": "…", "base_hash": "…" }] }
```

```jsonc
{ "dry_run": false, "written": [{ "path": "Notes/One", "hash": "…", "warnings": [] }] }
```

- Locks taken in sorted path order, every `base_hash` checked before the first write (`""` = must not exist).
- One stale hash → `409` with `conflicts: [{path, expected, actual}]`; nothing is written.
- Duplicate paths (including `X` and `X.md`) → `400`.
- `MANIFEST` in the batch is only written when it validates.
- Unexpected disk error → already written files are restored, newly created ones removed; `{ "error": "write_failed", "rolled_back": true, "path": "…" }`.
- The index is rebuilt once.

## check_links

```
check_links(path?, include_working?)
GET /api/v1/links?path=Notes&include_working=true
```

```jsonc
{
  "dead": [{ "path": "Notes/Page", "line": 2, "target": "Missing" }],
  "ambiguous": [{ "path": "Notes/Page", "target": "Dup", "candidates": ["A/Dup", "B/Dup"] }],
  "orphans": [{ "path": "Notes/Unlinked", "root": false }],
  "anchors": [{ "path": "Notes/Page", "target": "Target", "heading": "No Such Section" }],
  "counts": { "pages": 42, "links": 168, "dead": 1, "ambiguous": 1, "orphans": 4, "anchors": 1 }
}
```

Read-only. `path` limits the audit to one page or folder; links from outside still count as incoming. `include_working` also checks pages hidden from navigation. `orphans` keeps root pages and marks them with `root: true`.

## history

```
history(path, limit?)
GET /api/v1/history/<path>?limit=50
```

```jsonc
{
  "path": "Notes/Contact",
  "total": 3,
  "revisions": [
    { "id": "20261028T210012345Z-8e3dbe829eed", "hash": "8e3dbe829eed", "at": "2026-10-28T21:00:12.345Z", "size": 812, "agent": "alice" },
    { "id": "20261028T204412102Z-1f0c9c2aa7b1", "hash": "1f0c9c2aa7b1", "at": "2026-10-28T20:44:12.102Z", "size": 790, "marker": "moved to Archive/Contact" }
  ]
}
```

- Newest first. The first write of a page has no revision (nothing was overwritten).
- Deletions keep a revision with `marker: "deleted"`; moves one with `marker: "moved to <path>"`.
- Revision files live in `.history/`, which no read tool, listing, attachment route or `/f/` route exposes.
- Retention per page: `HISTORY_KEEP` (default 50, `0` keeps everything).

## diff

```
diff(path, since?)
GET /api/v1/diff/<path>?since=<id|hash|ISO time>
```

```jsonc
{
  "path": "Notes/Contact",
  "since": { "id": "…", "hash": "8e3dbe829eed", "at": "…" },
  "current": { "exists": true, "hash": "…" },
  "diff": "--- Notes/Contact @ 20261028T210012345Z-8e3dbe829eed\n+++ Notes/Contact (current)\n@@ -1,2 +1,2 @@\n-old\n+new\n keeps\n",
  "added": 1,
  "removed": 1,
  "truncated": false
}
```

`since` takes a revision id, a hash (prefix) or a date value (newest revision at or before it); without it the last revision is used. Deleted pages diff against empty content (`current.exists: false`). Very large pages skip the real line diff and return every old line as removed and every new line as added (`truncated: true`).

## Revision storage

```
<space>/.history/Notes/Contact/20261028T210012345Z-8e3dbe829eed.md
<space>/.history/Notes/Contact/20261028T210012345Z-8e3dbe829eed.json
```

The `.md` file is the previous content verbatim; the sidecar holds `at`, `marker` and `agent`. Both live below a dot directory, which the space scanner and every path validator ignore.
