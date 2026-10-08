---
tags: [feature, compat]
---
# SilverBullet-only syntax

These constructs come from SilverBullet. They render as muted, inert chips and are never executed.

An expression: ${1 + 1} sits inline.

```space-lua
print("this never runs")
```

```query
page where tags = "feature"
```

```space-style
body { color: red }
```
