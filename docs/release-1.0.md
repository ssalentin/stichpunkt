# Release plan 1.0

Status: active. Owner: Engineering Lead. Tracking: GitHub milestone `1.0`.

Start state: `main` at `2b6a8b5`, version `0.5.1`, CI green. 1.0.0 is the first release we
declare stable: the notes and collections API stops moving, and every shipped feature has a
verifiable operational and agent-facing path.

## Goal

Make Stichpunkt safe to rely on as the canonical store: no silent data damage, no feature that only
one client can reach, and no dependency on undocumented environment flags.

Three questions decide scope:

1. Can we lose or corrupt data without noticing? → workstream A
2. Can an agent do everything the UI can do? → workstream B
3. Does day-to-day table work compare to Notion? → workstream C

## Workstreams

### A. Data safety (M0)

- Versioned schema migrations: `PRAGMA user_version`, ordered migration steps, idempotent on boot,
  `--dry-run` flag, automatic backup before the first write.
- `/healthz` with substance: HTTP 200 plus DB `integrity_check`, schema version, `deployed.sha`,
  backup age, and the result of a write round-trip.
- Deploy gate: `stichpunkt-deploy.sh` performs a real API round-trip (read a collection, create a
  scratch row, expect `409` on a stale hash, delete the row) and refuses the swap on failure.
- Export: `GET /api/v1/export` plus a CLI (`npm run export`) producing Markdown, JSON per
  collection and CSV per collection, with a version header.

Exit: restore drill passes on a produced export; a deploy with a broken write path is refused.

### B. Agent parity (M1)

- MCP tools for collections on top of the existing service layer: list, get, query, create/update/
  delete row, history — same validation and `base_hash` conflicts as REST.
- Search covers collection rows, not only pages; results carry the collection and row identity.
- Both are additive: `/api/v1` keeps its shape, no field removals.

Exit: an agent completes read, filtered query, create, edit, conflict resolution and history
entirely over MCP.

### C. Table usability (M2)

- Grouping: `group_by` in a saved view, collapsible groups, group counts.
- Footer aggregates per column (count, sum, min, max, average) where the type allows it.
- Multi-select bulk edit and undo through the existing `revision` table.
- Mobile layout under 640px: card list instead of a horizontally scrolling table, same filters and
  sort.

Exit: the three existing workflows (Bücher, Fixkosten, Lesezeichen) are usable on a phone and with
bulk edits, verified against the live data set.

### D. Structure (M3)

- Row as page: a content field per row plus an editor panel; row backlinks.
- Relations: one typed relation property (1:N), resolved server-side; rollup limited to count and
  sum.
- Migration path for existing link-style text fields, applied to Rolodex ↔ Dienste.

Exit: Rolodex and Dienste are related in production data, the relation survives export and restore.

## Out of scope for 1.0

Comments, mentions, notifications and presence; realtime multi-user editing; board, calendar and
timeline views; arbitrary formulas; native apps; a Notion block editor; per-page ACLs. These are
either multi-user concerns with no value for a single operator, or a different product.

## Cadence

| Milestone | Window | Content |
|---|---|---|
| M0 | Nov 3 – Nov 7 | migrations, `/healthz`, deploy write gate, export |
| M1 | Nov 10 – Nov 14 | MCP collections, search over rows |
| M2 | Nov 17 – Nov 21 | grouping, aggregates, bulk edit, undo, mobile |
| M3 | Nov 24 – Nov 28 | row as page, relations, rollup |
| 1.0.0 | Dec 1 | tag, changelog, demo refresh, verified deploy |

Each milestone ends with a deployed build and a short evidence note: PR links, CI run, healthcheck
output.

## Definition of done (every PR)

- `npm run check`, `npm test`, `npm run build` green; CI green.
- The shipped server is exercised, not only the unit layer: a route check or API round-trip covers
  the change.
- Migrations are idempotent and tested twice in a row; a failed migration leaves the previous state
  intact.
- No default of an existing environment flag is flipped. New write capabilities ship behind an
  explicit flag until verified on the live instance.
- `docs/` updated in the same PR; `MANIFEST` changes go through `write_page` with `base_hash`.
- Post-merge: deployed, healthcheck green, one sentence of evidence in the PR.

## Risks

| Risk | Mitigation |
|---|---|
| Migration damages live data | Backup gate, dry run, idempotency test, restore drill before M0 closes |
| Scope creep from Notion parity | M2/M3 are closed lists; anything else becomes a 1.1 ticket |
| Two agents editing the same rows | `base_hash`/conflict path is mandatory for MCP writes, same as REST |
| Row-as-page bloats the row table | Content stored beside rows, not in `cell`; size limit as with pages |
| Mobile work lands without data checks | Exit criteria tie it to the three real collections |
