---
tags: [feature, compat]
date: 2026-10-09
---
# Expressions

`${ ausdruck }` is evaluated by stichpunkt with a small, own expression language. It runs on the server, can only read the index and always terminates: no loops, no user functions, no assignment. It is a Pratt parser and a tree-walking evaluator written in TypeScript; there is no `eval`, no Lua and no JavaScript runtime.

Three outcomes are possible:

| Outcome | How it looks |
| --- | --- |
| A value | the value itself: a number, `true`/`false`, a muted dash for `null`, a comma-separated list, a wikilink for a page, or a page list through the `pages` renderer |
| Not run | a quiet chip "expression · not run", for a Lua remnant or a body that is not valid syntax |
| Runtime error | a red error chip with the message and the source text, never blank |

A few live examples:

${1 + 1}

${this.fm.status ?? "offen"}

${count({tag: "feature"})}

${link("Features/Expressions/Reference", "The full reference")}

`${...}` is only ever escaped output: an expression never produces HTML, and a frontmatter string that looks like an expression is left as data.

More:

- [[Features/Expressions/Reference]]: every builtin and every operator with a live example.
- [[Features/Expressions/Examples]]: realistic cases from a knowledge base.
- [[Features/Expressions/Errors]]: what the red and the quiet chips look like.

## The `kb.*` helpers still work

The four SilverBullet helper calls remain recognised before the expression grammar and render exactly as before, from the index. Every other `${...}` in the old Lua style stays a quiet chip. Live examples:

${kb.section("feature")}

${kb.recent("feature", 3)}

${(kb and kb.safe("Status", kb.header)) or "*Status unavailable*"}

An unknown category shows a warning:

${kb.section("does-not-exist")}

A Lua remnant that is not one of the four presets stays inert: ${kb.section(someVariable)} and ${for i = 1, 10 do print(i) end}.
