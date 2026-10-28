# Page operations, history and diff

Agent-facing MCP tools and the matching REST routes. Page paths never carry `.md` or a leading slash. All routes require `Authorization: Bearer <token>`.

| MCP tool | REST | Purpose |
| --- | --- | --- |
| `move_page` | `POST /api/v1/pages/move` | move or rename a page, rewrite links |
| `write_pages` | `POST /api/v1/pages/batch` | write several pages atomically |
| `check_links` | `GET /api/v1/links` | read-only link audit |
| `check_manifest` | `GET /api/v1/manifest/check` | read-only manifest validation |
| `activity` | `GET /api/v1/activity` | revision activity across pages |
| `history` | `GET /api/v1/history/<path>` | revision list |
| `diff` | `GET /api/v1/diff/<path>` | unified diff against a revision |

Writes (`write_page`, `write_pages`, `append_to_page`, `delete_page`, `move_page`) keep the previous content under `.history/<path>/<timestamp>-<hash>.md`. Direct file edits are **not** versioned: only the MCP and REST write paths call the revision store.

## move_page

```
move_page(from, to, dry_run?, agent?, overwrite?, note?)
POST /api/v1/pages/move   { "from": "Notes/Contact", "to": "Archive/Contact", "dry_run": false }
```

```jsonc
{
  "from": "Notes/Contact", "to": "Archive/Contact", "dry_run": false, "moved": true,
  "hash": "…",
  "rewritten": [{ "path": "Notes/Overview", "links": 2 }],
  "unresolved": [],
  "warnings": []
}
```

- A link is rewritten only when it resolved to the old page before the move and would not resolve to the new page afterwards. Unique-basename links (`[[Contact]]`) keep working and stay untouched.
- `#Heading`, `|alias` and `![[…]]` survive; nothing inside fenced or inline code is touched.
- `unresolved` lists links that could refer to the page but cannot be rewritten safely (`ambiguous_basename`, `unresolvable`).
- Existing destination → `409 target_exists`; same path → `400`; missing source → `404`; `dry_run` returns the plan without writing.
- The response always carries `hash` (content hash of the new destination page). `overwrite: true` replaces an existing destination instead of failing: the response adds `overwrite` and `previous_hash` (content hash of the replaced page), and the overwritten page is kept in `.history` (marker `overwritten by move from <from>`). `_attachments` folders are never moved or deleted.
- The page's history moves with it: the moved page keeps its version numbers instead of restarting at version 1, and the move itself is recorded with `tool: "move_page"` and the marker `moved from <from>`.

## write_pages

```
write_pages(pages, dry_run?, agent?, note?)
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
- `dry_run` returns `written` with the new `hash` and the `warnings` per page and writes nothing. Every entry (also in dry-run) carries `actor`, `owner` and `owner_ok`.

## check_links

```
check_links(path?, include_hidden?)
GET /api/v1/links?path=Notes&include_hidden=true
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

Read-only. `path` limits the audit to one page or folder; links from outside still count as incoming. `include_hidden` also checks pages hidden from navigation. `orphans` keeps root pages and marks them with `root: true`.

## check_manifest

```
check_manifest()
GET /api/v1/manifest/check
```

```jsonc
{ "ok": false, "issues": [{ "path": "folders.Ghost", "message": "Folder \"Ghost\" has no page" }] }
```

Read-only. Checks the strict manifest schema, `allowed_tags` against the `tag.define` names in `CONFIG`, folders without any page, and folder keys that collide after normalisation. Full rules: [`manifest.md`](manifest.md).

## history

```
history(path, limit?)
GET /api/v1/history/<path>?limit=50
```

```jsonc
{
  "path": "Notes/Contact",
  "total": 2,
  "revisions": [
    {
      "id": "20261028T210012345Z-8e3dbe829eed", "hash": "8e3dbe829eed", "version": 2,
      "at": "2026-10-28T21:00:12.345Z", "size": 812,
      "actor": "alice", "actor_source": "field", "actor_name": "Alice A.",
      "tool": "write_page", "bytes_added": 42, "bytes_removed": 7,
      "warnings": ["missing_frontmatter"], "note": "updated the address"
    },
    {
      "id": "20261028T204412102Z-1f0c9c2aa7b1", "hash": "1f0c9c2aa7b1", "version": 1,
      "at": "2026-10-28T20:44:12.102Z", "size": 790,
      "actor": "unknown", "actor_source": "unknown", "actor_name": "unknown",
      "tool": "delete_page", "bytes_added": 0, "bytes_removed": 790,
      "warnings": [], "marker": "deleted"
    }
  ]
}
```

- Newest first, `version` counts the records of this page from 1 (not reset by a move).
- `actor` is a stable slug, never empty (`unknown` when the call named no actor). `actor_source` is `field` (agent argument / `X-Agent`), `human`, `token` (later) or `unknown`; this version produces `field` and `unknown`, a future web-UI write path passes `human`. Display names come from `actors` in the manifest (`actor_name`), never from the record.
- `tool` is `write_page`, `append_to_page`, `move_page` or `delete_page`. `bytes_added` / `bytes_removed` describe the change that replaced this revision.
- `warnings` lists the manifest rule names the write produced; `note` is the optional call note (trimmed to 500 characters).
- Deletions keep a tombstone with the last version and the deleting actor; moves move the history with the page and add a `moved from <path>` record.
- Revision files live in `.history/`, which no read tool, listing, attachment route or `/f/` route exposes.
- Retention per page: `HISTORY_KEEP` (default 50, `0` keeps everything).

## activity

```
activity(since?, actor?, folder?, page?, limit?)
GET /api/v1/activity?since=&actor=&folder=&page=&limit=50
```

```jsonc
{
  "total": 12,
  "records": [
    { "path": "Notes/Contact", "version": 2, "actor": "alice", "actor_source": "field", "actor_name": "Alice A.", "tool": "write_page", "at": "…", "bytes_added": 42, "bytes_removed": 7, "warnings": [], "note": "…" }
  ]
}
```

Read-only, across every page, newest first. `since` takes an ISO/date value, `actor` a slug, `folder` a path prefix, `page` an exact path; `limit` defaults to 50 (max 500) and `total` counts before the limit.

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

## Write responses

`write_page`, `write_pages` and `append_to_page` return `actor`, `owner` and `owner_ok` next to `warnings`; in `write_pages` each `written` entry carries them. The values follow the configured folder owner and the optional actor (`agent` argument or `X-Agent` header).

Every write also accepts an optional `note` (body field, or `X-Note` header on requests without a body), which is stored on the revision together with the actor, `actor_source`, the tool name and the warning rules.

## Revision storage

```
<space>/.history/Notes/Contact/20261028T210012345Z-8e3dbe829eed.md
<space>/.history/Notes/Contact/20261028T210012345Z-8e3dbe829eed.json
```

The `.md` file is the previous content verbatim; the sidecar holds `version`, `at`, `actor`, `actor_source`, `tool`, `bytes_added`, `bytes_removed`, `warnings`, `note` and `marker`. Both live below a dot directory, which the space scanner and every path validator ignore.
