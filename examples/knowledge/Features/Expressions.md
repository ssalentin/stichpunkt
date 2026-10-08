---
tags: [feature, compat]
date: 2026-10-08
---
# Expressions

mdwiki does **not** evaluate expressions. It recognises exactly four SilverBullet helper calls and renders them as built-in, server-side widgets; every other `${...}` stays an inert chip.

| Expression | Renders |
| --- | --- |
| `kb.section("<tag>")` | category header: badge, label, note count, last date, link to the start page |
| `kb.recent("<tag>", n)` (also in the `kb.safe(...)` wrapper) | newest notes first by frontmatter `date` |
| `kb.header` | "N notes in M categories" |
| `kb.categories` | one card per category |

Categories come from the `tag.define` entries in `CONFIG`. Live examples:

${kb.section("feature")}

${kb.recent("feature", 3)}

${(kb and kb.safe("Status", kb.header)) or "*Status unavailable*"}

An unknown category shows a warning:

${kb.section("does-not-exist")}

Anything else stays inert: ${kb.section(someVariable)} and ${1 + 1}.
