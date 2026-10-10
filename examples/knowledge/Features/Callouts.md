---
tags: [feature, example]
---
# Callouts

Start a block quote with `> [!type]` to turn it into a highlighted box. Text after the marker on the same line becomes the title; without one, the type name is used.

> [!note]
> A plain note. **Markdown** works inside, including [[Features/Wikilinks|wikilinks]] and `code`.

> [!tip] Faster navigation
> Press `Ctrl`/`⌘` + `K` to jump to any page.

> [!warning] Careful
> A warning box with a list:
>
> - first
> - second

> [!danger]
> Something that must not be ignored.

> [!success] Done
> Green for finished work.

> [!question] Is this foldable?
> Not this one. Add `+` or `-` after the marker to fold.

## Foldable callouts

> [!example]- Collapsed by default (`[!example]-`)
> Opened by clicking the title.

> [!abstract]+ Open by default (`[!abstract]+`)
> Can be collapsed by clicking the title.

## Supported types

| Style | Types |
| --- | --- |
| note | `note`, `info`, `todo` |
| abstract | `abstract`, `summary`, `tldr` |
| tip | `tip`, `hint`, `important` |
| success | `success`, `check`, `done` |
| question | `question`, `help`, `faq` |
| warning | `warning`, `caution`, `attention` |
| danger | `danger`, `error`, `failure`, `fail`, `missing`, `bug` |
| example | `example` |
| quote | `quote`, `cite` |

Unknown types render as a note, keeping the type name as the title. A normal block quote without `[!…]` stays a quote:

> Just a quote.
