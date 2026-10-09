---
title: Syntax
tags:
  - meta
---
# Syntax

Text with a tag #syntax-test and a `[[not a link]]` in code, and #123 is not a tag.

| a | b |
|---|---|
| 1 | 2 |

~~strike~~ and https://example.org autolink.

```ts
const x: number = 1;
```

```space-lua
print("never executed")
```

```query
page where tags = "x"
```

Inline expression ${1 + 1} stays inert.

Inline math $a^2 + b^2 = c^2$ and price $5 stays text.

$$
\int_0^1 x\,dx = \tfrac12
$$

```mermaid
%%{init: {"theme":"base","themeVariables":{"darkMode":true,"lineColor":"#7d8fa1","textColor":"#dbe4ec","edgeLabelBackground":"#0b0f14","clusterBkg":"#111823","clusterBorder":"#3a4a5a","fontSize":"15px"}}}%%
flowchart LR
  A[Client] --> B[Proxy] --> C[App]
```

```vega-lite
{"data":{"values":[{"x":"a","y":3},{"x":"b","y":5}]},"mark":"bar","encoding":{"x":{"field":"x","type":"nominal"},"y":{"field":"y","type":"quantitative"}}}
```

```plantuml
@startuml
Alice -> Bob: hello
@enduml
```

```graphviz
digraph G { a -> b }
```

```d2
x -> y
```

```plantuml
@startuml
this is not valid plantuml
