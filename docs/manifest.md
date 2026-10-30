# Agent manifest

An optional page named `MANIFEST` in the space root. The YAML frontmatter is machine-readable; the body is prose for humans and agents. Without a manifest the app behaves exactly as before.

```yaml
---
manifest: 1
summary: "One paragraph every connecting agent sees"
pages:
  required_frontmatter: [updated]
  allowed_tags: [project, runbook]
  forbidden_prefixes: ["Sources:"]
  stand_field: updated
  stand_max_age_days: 90
  require_agent: false
folders:
  Projects: { owner: "Project leads", description: "One page per project" }
actors:
  alice: { name: "Alice A." }
checks: [secrets, links, frontmatter, owner, stand_age]
layers:
  pages:
    MANIFEST: config
    CONFIG: config
  working:
    label: Working
    pages:
      require_agent: true
    checks: [links]
viewLabels:
  all: All
---
Prose rules for humans and agents.
```

All levels are strict: an unknown key makes the manifest invalid and the previous valid version stays active. `get_manifest` / `GET /api/v1/manifest` returns `{exists, path, hash, rules, prose}`.

## Fields

| Field | Meaning |
| --- | --- |
| `manifest` | required, must be `1` |
| `summary` | required, 1–2000 characters, sent to agents as MCP `instructions` |
| `pages.required_frontmatter` | keys every page must carry |
| `pages.allowed_tags` | frontmatter tags a page may carry (active with the `frontmatter` check) |
| `pages.forbidden_prefixes` | lines starting like this (trimmed, outside code fences) are flagged |
| `pages.stand_field` | frontmatter key holding the page date, default `updated` |
| `pages.stand_max_age_days` | maximum age in days, default `90` |
| `pages.require_agent` | when `true`, a write without an actor warns `missing_actor`; default `false` |
| `folders` | top-level folder → `{owner, template, description, layer}`; `layer` is `reading` (default), `working` or `config` and is inherited by all pages below the folder |
| `layers` | per layer: `label`, `pages` (same keys as the global block, set keys replace global keys) and `checks` (replaces the global list when set). The reserved `layers.pages` maps exact page paths to a layer. A layer without a block inherits the global rules |
| `viewLabels.all` | label of the third sidebar view; default `All` |
| `actors` | actor slug → `{name}`; display names for history and activity. Records store only the slug |
| `checks` | warnings to run: `secrets`, `links`, `frontmatter`, `owner`, `stand_age` |

## Warnings

Warnings never block a write. `write_page`, `write_pages`, `append_to_page` and `validate_page` return `warnings: [{rule, message, line?}]` for the resulting content.

| Rule | Check | Meaning |
| --- | --- | --- |
| `missing_frontmatter` | always when `required_frontmatter` is set | a required key is missing or the YAML does not parse |
| `forbidden_prefix` | always when `forbidden_prefixes` is set | a line starts with a forbidden prefix |
| `unknown_folder` | always when `folders` is set | the top-level folder is not declared |
| `possible_secret` | `secrets` | a line matches a known credential shape (rule and line only, never the value) |
| `dead_link` | `links` | a wikilink in the resulting content does not resolve |
| `tag_not_allowed` | `frontmatter` | a tag is not in `pages.allowed_tags` |
| `owner_mismatch` | `owner` | the acting agent differs from the folder owner |
| `stand_missing` | `stand_age` | the stand field is absent |
| `stand_unparseable` | `stand_age` | the stand field is not a date the check understands |
| `stand_stale` | `stand_age` | the stand date is older than `pages.stand_max_age_days` |
| `missing_actor` | `pages.require_agent` | the manifest requires an actor but the write did not name one |

### Write responses

`write_page`, `write_pages` and `append_to_page` return `actor`, `owner` and `owner_ok` next to `warnings`:

```jsonc
{ "path": "Projects/Atlas", "hash": "…", "created": false, "warnings": [],
  "actor": "alice", "owner": "Project leads", "owner_ok": true }
```

`owner` is the `folders.<top>.owner` of the page (`null` for root pages and folders without an owner), `actor` is the name the caller supplied (`null` when absent) and `owner_ok` is `false` only when both exist and differ. Owner and actor compare after trimming and case-insensitively. In `write_pages` every entry of `written` carries the three fields, also in `dry_run`.

### Acting agent

The `owner` check needs to know who writes. Pass it as the optional `agent` argument of `write_page`, `write_pages`, `append_to_page` or `validate_page`, or as the `X-Agent` header on the matching REST calls. Without an actor the check stays silent. Root pages have no folder owner.

### Stand dates

`stand_age` accepts ISO 8601 (`2026-10-28`, `2026-10-28T14:55:00Z`, with an offset) and `DD.MM.YYYY`, optionally with a time and an IANA timezone:

```yaml
updated: 2026-10-28
updated: 2026-10-28T14:55:00+01:00
updated: 28.10.2026 14:55 Europe/Berlin
```

A leading label such as `updated:` inside the value is tolerated. Values that do not parse produce `stand_unparseable`, not silence.

## check_manifest

`check_manifest` (`GET /api/v1/manifest/check`) validates the manifest on disk against the current schema and the space, without writing:

```jsonc
{ "ok": false, "issues": [
  { "path": "folders.Ghost", "message": "Folder \"Ghost\" has no page" },
  { "path": "pages.allowed_tags", "message": "Tag \"nowhere\" has no tag.define in CONFIG" }
] }
```

It reports strict-schema errors (unknown keys, invalid enum values, wrong types), `allowed_tags` without a matching `tag.define` name from `CONFIG`, folders without any page below them, and folder keys that collide after path normalisation (case, surrounding or repeated slashes). It does not run page warnings. Without a manifest the answer is `{ok: true, issues: []}`.

## Layers

`folders.Notes.layer: working` puts every page below `Notes/` into the working layer; a folder without `layer` is `reading`. Root pages are `reading` unless mapped or tagged explicitly.

A page's layer resolves in this order: `layers.pages.<exact path>` (no leading slash, no `.md`) → frontmatter `layer` (`reading`, `working` or `config`) → folder layer → `reading`. `layers.pages` is exact, not a prefix; it is the documented way to put `MANIFEST` and `CONFIG` into `config`, because root pages do not fall under a folder rule. An invalid frontmatter `layer` is ignored at runtime and reported by `check_manifest`, never as a write warning. The page's layer selects the effective rules: a key set under `layers.<layer>.pages` replaces the global key, unset keys inherit; `layers.<layer>.checks` replaces the global check list (an empty list disables checks for that layer). `layers.<layer>.label` is the display name (defaults: `Notes`, `Working`, `Config`).

`check_manifest` reports unknown layer keys, layer blocks without any folder, folder collisions and `allowed_tags` without a `tag.define` (global and per layer).

## Backward compatibility

Without `checks`, only the rules that were always active (`required_frontmatter`, `forbidden_prefixes`, `folders`) apply. Without `pages.allowed_tags`, `pages.stand_field` or `pages.stand_max_age_days`, nothing changes; the defaults (`updated`, 90 days) are used only when `stand_age` is enabled. `agent` and `X-Agent` are optional.

## Tools

```jsonc
// MCP: write_page / validate_page
{ "path": "Projects/Atlas", "content": "---\nupdated: 2026-10-28\n---\n…", "base_hash": "…", "agent": "alice" }

// REST
PUT /api/v1/pages/Projects/Atlas
X-Agent: alice
{ "content": "…", "base_hash": "…" }
```
