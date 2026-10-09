---
tags: [feature, expressions]
date: 2026-09-20
status: active
---
# Expressions in use

Realistic cases, each with its source in backticks next to the live result.

## Counting pages

How many pages match:

- projects in total: ${count({tag: "project"})}
- pages under `Projects`: ${count({folder: "Projects"})}

`${count({tag: "project"})}` counts every page tagged `project`, before any `limit`. The `count` builtin is the same number a `pages` block shows with `show: count`. Counting by status (active, planned, shipped) is not possible yet: the query has no frontmatter filter.

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

${pages({tag: "project", sort: "date desc", limit: 1})}

`sort: date desc` with `limit: 1` picks the newest page, and a one-element page list renders as a single link. With `limit: 3` the same expression renders the three newest:

${pages({tag: "project", sort: "date desc", limit: 3})}

`link(path, label)` makes a wikilink to a fixed path with a label of your choice: ${link("Projects/Alpha", "Alpha")}.

## In a table cell and in a heading

The count works anywhere inline, including inside a table:

| Metric | Value |
| --- | --- |
| Projects | ${count({tag: "project"})} |
| Total budget | ${sum(pages({folder: "Projects"}), "budget")} |
| Features | ${count({tag: "feature"})} |

### Today is ${fmt_date(today(), "DD.MM.YYYY")}

A heading can contain an expression too and it is evaluated in the page. The outline and the heading anchor are built from the source text, so the heading above appears there as "Today is".
