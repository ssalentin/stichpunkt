---
tags: [diagrams]
---
# Mermaid

The `%%{init}%%` directive below is the dark palette used by the real notes; it is respected. Mermaid diagrams sit on a dark panel in both themes.

```mermaid
%%{init: {"theme":"base","themeVariables":{"darkMode":true,"lineColor":"#7d8fa1","textColor":"#dbe4ec","edgeLabelBackground":"#0b0f14","clusterBkg":"#111823","clusterBorder":"#3a4a5a","fontSize":"15px"}}}%%
flowchart LR
  subgraph edge[Edge]
    P[Proxy] --> A[Auth]
  end
  A --> W[Wiki]
  W --> K[(Files)]
  W -. render .-> D[Kroki]
```

Without an init directive the dark default theme applies:

```mermaid
sequenceDiagram
  participant Agent
  participant Wiki
  Agent->>Wiki: write_page(base_hash)
  Wiki-->>Agent: ok or 409 conflict
```
