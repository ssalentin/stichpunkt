---
tags: [feature, example]
title: Search
date: 2026-10-08
---
# Search

Search is server-rendered and ranked. Open it from the top bar, the bottom bar, or press **Ctrl/Cmd-K** for the quick switcher; type and press Enter to run a full-text search.

## Result cards

Each hit shows the **title**, the folder it lives in, the **section that matched** (with a link to its anchor) and a snippet with the matching words highlighted.

## Filters

The query supports three forms, and you can mix them:

- `#tag` — only pages with that tag, e.g. `#feature`
- `in:folder` — only pages inside a folder, e.g. `in:Features`
- `"a phrase"` — the words must appear together

Examples:

- `diagram #feature` — pages that mention *diagram* and carry the `feature` tag.
- `in:Features mermaid` — search *mermaid* inside `Features/`.
- `"bullet point"` — the exact phrase.

The facets above the results (folders and tags) do the same thing with one tap and show how many hits each would keep.

## Empty state

With an empty query the page lists the **recently changed** pages, so it is useful as a jump-off point too.
