---
tags: [diagrams]
---
# Pele

Pele renders Stichpunkt's `mermaid` fences in the browser. It follows the active light or dark theme and adapts diagram layout to the available width.

The fence language stays `mermaid`, so existing notes keep working:

```mermaid
flowchart LR
  Reader[Reader] --> Wiki[Stichpunkt]
  Wiki --> Pele[Pele]
  Pele --> SVG[SVG]
```

Sequence diagrams:

```mermaid
sequenceDiagram
  participant Author
  participant Wiki
  Author->>Wiki: write_page
  Wiki-->>Author: ok or conflict
```

State diagrams:

```mermaid
stateDiagram-v2
  [*] --> Draft
  Draft --> Review
  Review --> Published
  Published --> [*]
```

See [[Features/Diagrams/Mermaid]] for directive compatibility and [[Features/Diagrams/Errors]] for error handling.
