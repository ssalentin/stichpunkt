---
tags: [feature, compat]
---
# SilverBullet-only syntax

SilverBullet uses a few constructs that stichpunkt does **not** run. It shows them as a small, quiet, collapsed placeholder so nothing is lost and nothing executes — expand the block to read the original text.

An unknown expression, for example `${1 + 1}`, stays an inline placeholder:

```space-lua
print("this never runs")
```

```query
page where tags = "feature"
```

```space-style
body { color: red }
```

None of these code blocks are executed. The four helper calls stichpunkt *does* understand are described in [[Features/Expressions]].
