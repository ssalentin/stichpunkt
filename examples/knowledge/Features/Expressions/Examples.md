---
tags: [feature, expressions]
date: 2026-09-20
status: active
---
# Expressions in use

Realistic cases, each with its source in backticks next to the live result.

## Count by status

How many projects are active, planned or shipped:

- active: ${count({tag: "project"})} projects in total
- with a budget: ${count({folder: "Projects"})} pages under `Projects`

`${count({tag: "project"})}` counts every page tagged `project`, before any `limit`. The `count` builtin is the same number a `pages` block shows with `show: count`.

## A frontmatter sum

The total budget of all project pages:

${sum(pages({folder: "Projects"}), "budget")}

`${sum(pages({folder: "Projects"}), "budget")}` sums the frontmatter key `budget`. Values that are not numbers, and `null`, are skipped, so a project without a budget does not break the total.

## "Open for N days"

This page carries a `date` in its frontmatter, so:

Offen seit ${days(this.fm.date, today())} Tagen. Seit dem ${fmt_date(this.fm.date, "DD.MM.YYYY")}.

`${days(this.fm.date, today())}` gives the whole days from the page date to today; `today()` is the server's date. The result is `null`-safe because a missing field is `null`, and `days` accepts an ISO string.

## The newest page of a tag as a link

The newest project, listed as a link:

${link("Projects/Alpha", "Newest project")}

`link(path, label)` makes a wikilink anchor. To pick the newest page of a tag automatically, a `pages` block with `sort: date desc` and `limit: 1` is the tool; a short expression renders the whole list instead:

${pages({tag: "project", sort: "date desc", limit: 3})}

## In a table cell and in a heading

The count works anywhere inline, including inside a table:

| Metric | Value |
| --- | --- |
| Projects | ${count({tag: "project"})} |
| Total budget | ${sum(pages({folder: "Projects"}), "budget")} |
| Features | ${count({tag: "feature"})} |

### Today is ${fmt_date(today(), "DD.MM.YYYY")}

A heading can contain an expression too. The heading text is plain: an expression in a heading is evaluated and its text ends up in the outline.
