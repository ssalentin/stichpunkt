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
folders:
  Projects: { owner: "Project leads", description: "One page per project" }
checks: [secrets, links, frontmatter, owner, stand_age]
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
| `folders` | top-level folder → `{owner, template, description}`; `owner` is used by the `owner` check |
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
