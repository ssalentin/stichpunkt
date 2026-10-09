---
tags: [diagrams]
---
# Broken diagrams

A syntax error in Mermaid:

```mermaid
flowchart LR
  A --> 
  B ---> ((
```

A syntax error in a Kroki type:

```plantuml
@startuml
this is not valid plantuml at all
