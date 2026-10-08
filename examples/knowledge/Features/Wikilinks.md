---
tags: [feature]
---
# Wikilinks

A wikilink shows the **page name**, not the path you typed. The full path stays in the tooltip and the URL, so links read well without losing where they point.

| Form | Result |
| --- | --- |
| `[[Projects/Alpha]]` | [[Projects/Alpha]] |
| `[[Features/Markdown#Tables]]` | [[Features/Markdown#Tables]] |
| `[[alpha]]` (case-insensitive, unique name) | [[alpha]] |
| `[[Does Not Exist]]` | [[Does Not Exist]] |

If two pages share a name, both keep the shortest distinguishing folder, so the label stays unambiguous.

Alias form (written outside a table, because a pipe would split table cells): `[[Projects/Alpha|a custom label]]` renders as [[Projects/Alpha|a custom label]].

## Heading links

This section is the target of a heading link from [[Projects/Alpha]]. Heading ids are generated from the text.

## Backlinks

Open the **More** sheet (phone) or the right column (desktop) on [[Projects/Alpha]] to see which pages link to it, including this one.

Links inside code stay literal: `[[Projects/Alpha]]`.
