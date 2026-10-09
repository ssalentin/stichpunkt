---
tags: [feature, expressions]
---
# Expressions reference

Every line shows the source in backticks, then the live result. Values come from the index of this example space.

## Literals

| Source | Live |
| --- | --- |
| `${42}` and `${-3.5}` | ${42} and ${-3.5} |
| `${"text" + " joined"}` | ${"text" + " joined"} |
| `${'single quoted'}` | ${'single quoted'} |
| `${true} / ${false}` | ${true} / ${false} |
| `${null}` | ${null} |
| `${[1, 2, 3]}` | ${[1, 2, 3]} |
| `${["a", "b"]}` | ${["a", "b"]} |

An escape like `\n`, `\"`, `\'` and `\\` works inside a string.

## Operators

| Source | Live |
| --- | --- |
| `${1 + 2 * 3}` | ${1 + 2 * 3} |
| `${(1 + 2) * 3}` | ${(1 + 2) * 3} |
| `${7 - 3}` and `${7 % 3}` | ${7 - 3} and ${7 % 3} |
| `${7 / 3}` | ${7 / 3} |
| `${-7}` | ${-7} |
| `${2 > 1}` and `${2 >= 2}` | ${2 > 1} and ${2 >= 2} |
| `${1 < 2}` and `${1 <= 2}` | ${1 < 2} and ${1 <= 2} |
| `${1 == 1}` and `${1 != 1}` | ${1 == 1} and ${1 != 1} |
| `${true and false}` | ${true and false} |
| `${true or false}` | ${true or false} |
| `${not true}` | ${not true} |
| `${null ?? "fallback"}` | ${null ?? "fallback"} |
| `${1 > 2 ? "yes" : "no"}` | ${1 > 2 ? "yes" : "no"} |

`+` adds two numbers or joins two strings; mixed types are an error. Division by zero is an error.

## Field access

`this` is the page carrying the expression; a page value has `path`, `title`, `folder`, `tags`, `date`, `modified` and `fm` (the frontmatter). A missing field or a field on `null` is `null`.

| Source | Live |
| --- | --- |
| `${this.title}` | ${this.title} |
| `${this.path}` and `${this.folder}` | ${this.path} and ${this.folder} |
| `${this.fm.status ?? "offen"}` | ${this.fm.status ?? "offen"} |
| `${page("Projects/Alpha").title}` | ${page("Projects/Alpha").title} |
| `${page("Projects/Alpha").fm.budget}` | ${page("Projects/Alpha").fm.budget} |
| `${page("Nope").title}` | ${page("Nope").title} |

## Builtins

| Builtin | Meaning | Live |
| --- | --- | --- |
| `count(q)` | matches before `limit` | ${count({tag: "project"})} |
| `page(path)` | one page record or `null` | ${page("Projects/Alpha").title} |
| `sum(list, feld)` | sum over a page list or numbers | ${sum(pages({folder: "Projects"}), "budget")} |
| `min` / `max(list, feld)` | smallest and largest number | ${min(pages({folder: "Projects"}), "budget")} / ${max(pages({folder: "Projects"}), "budget")} |
| `avg(list, feld)` | average; `null` for an empty list | ${avg(pages({folder: "Projects"}), "budget")} |
| `len(x)` | length of a list or string | ${len("hello")} |
| `join(list, sep)` | join with a separator | ${join(["a", "b", "c"], " · ")} |
| `lower(s)` / `upper(s)` | case | ${lower("HELLO")} / ${upper("hello")} |
| `round(x, n)` | round to `n` places | ${round(3.14159, 2)} |
| `today()` / `date(s)` | today, or a date from an ISO string | ${today()} / ${date("2026-01-15")} |
| `days(a, b)` | whole days from `b - a` | ${days("2026-01-01", "2026-01-15")} |
| `fmt_date(d, muster)` | date as `YYYY`, `MM`, `DD` | ${fmt_date(today(), "DD.MM.YYYY")} |
| `link(path, label?)` | a link value | ${link("Projects/Alpha")} |

### A whole page list

`pages` renders through the same list renderer as the `pages` block:

${pages({tag: "project", sort: "title asc"})}

## What the language does not have

No assignment, no lambdas, no loops, no user functions, no regular expressions, no indexing with `[]` and no writes. An expression can only read, and it always ends.
