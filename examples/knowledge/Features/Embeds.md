---
tags: [feature, example]
---
# Embeds (transclusion)

`![[Page]]` pulls a whole page into the current one; `![[Page#Heading]]` pulls just the section below that heading, up to the next heading of the same or a higher level. The embed carries a header that links back to its source and updates whenever the source changes.

## A section

The next box is `![[Features/Embeds-Source#Shared snippet]]`:

![[Features/Embeds-Source#Shared snippet]]

## A whole page

And this one is `![[Features/Short-Page]]`:

![[Features/Short-Page]]

## Rules

- The embedded page is rendered like any page: wikilinks, tags, callouts, diagrams, `pages` blocks and expressions all work. Its headings do not appear in this page's outline.
- Embeds can nest, up to 3 levels, with at most 20 per page. A page that would embed itself is skipped with a note.
- A missing page or heading shows a red note instead of failing the page.
- An embed counts as a link, so the source page lists this one under **Backlinks**.
- Inside running text (not alone on its line) an embed degrades to a plain link.
- `![[picture.png]]` embeds an image from the attachments.

A missing page shows a note:

![[Features/Does-Not-Exist]]

A loop guard: the source page embeds this page back, which is skipped.

![[Features/Embeds-Source]]
