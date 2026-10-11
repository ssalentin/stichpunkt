---
tags: [feature]
---
# Navigation

## Phone

- One column, read mode. The bottom bar has **Back**, **Search**, **Home** and **More**.
- **More** opens a bottom sheet with outline, backlinks, tags and page actions.
- Tap a link: the next page is prefetched on touch.

## Desktop

- Three columns: folder tree and recent pages on the left, the page at a readable width in the middle, outline and backlinks on the right.
- `Ctrl/Cmd-K` opens the quick switcher: fuzzy over titles and paths, recent pages first. If nothing matches, it offers a full-text search.

## Search

Full-text search shows snippets with highlighted matches. Try searching for `zebra` or `kroki`.

## Breadcrumbs

Every folder in the breadcrumb opens its namespace listing, for example `Features/Diagrams`.

## Hidden

Pages under `Library/` are not listed in the tree, switcher or search.

## Live updates

Open pages follow the content. When a page is written through MCP or the API, or a file changes on disk, every open browser tab and installed app reloads the data by itself:

- the changed paragraphs, list items or blocks flash briefly (a changed list item flashes alone, not the whole list);
- the changed page also flashes in the tree and under **Recent**;
- a small notice says "Page updated", with **Show change** when the change is out of view;
- a deleted or newly created page is announced the same way.

Nothing reloads while you have text selected in the page; it applies the update as soon as you click elsewhere. A tab in the background catches up when you return to it. The footer shows **live** (connected) or **offline**; after a lost connection the app reconnects on its own and reloads once to catch up. Try it: edit [[Features/Short-Page]] through the API and watch this app.
