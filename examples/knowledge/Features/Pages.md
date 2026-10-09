---
tags: [feature, pages]
date: 2026-10-09
---
# Pages block

A fenced `pages` block lists pages from the index. The body is a small YAML object, checked against a fixed schema. There is no expression language and nothing is executed: the same query engine backs the four built-in widgets, the `query_pages` MCP tool and `POST /api/v1/query`.

A page by tag, newest first:

```pages
tag: project
sort: date desc
limit: 5
```

The same set as a table with chosen columns:

```pages
tag: feature
sort: title asc
show: table
columns: [title, date, tags]
```

Just the number of pages in a folder:

```pages
folder: Projects
show: count
```

Backlinks to this page (pages that link here):

```pages
links-to: this
sort: title asc
```

## Errors

An invalid block shows the message and the block source instead of failing the page. Unknown key:

```pages
tga: project
```

Wrong type:

```pages
limit: many
```

Broken YAML:

```pages
tag: [unclosed
```

## Notes

- Filters are only equality, a path prefix and backlinks. No regex, no scripting.
- `folder: this` and `links-to: this` refer to the page the block lives on.
- `sort` accepts `title`, `modified`, `date` or any frontmatter key, with `asc` or `desc`.
- `limit` defaults to 50 and never exceeds 200.
