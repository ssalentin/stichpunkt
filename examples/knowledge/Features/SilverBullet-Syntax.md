---
tags: [feature, compat]
---
# SilverBullet-only syntax

SilverBullet uses a few constructs that stichpunkt does **not** run. It shows them as a small, quiet, collapsed placeholder so nothing is lost and nothing executes — expand the block to read the original text.

```space-lua
print("this never runs")
```

```query
page where tags = "feature"
```

```space-style
body { color: red }
```

None of these code blocks are executed. An expression in the old Lua style stays an inline placeholder too, as long as the grammar cannot read it: ${for i = 1, 10 do print(i) end} and ${kb.section(someVariable)}. A plain arithmetic body like `${1 + 1}` is now evaluated — see [[Features/Expressions]].

The four SilverBullet helper calls stichpunkt *does* understand are also described in [[Features/Expressions]].
