---
tags: [feature, compat]
---
# SilverBullet-only syntax

These constructs come from SilverBullet. They render as muted, inert chips and are never executed.

An expression that stichpunkt does not know: ${1 + 1} sits inline as a chip. See [[Features/Expressions]] for the four built-in widgets.

```space-lua
print("this never runs")
```

```query
page where tags = "feature"
```

```space-style
body { color: red }
```
