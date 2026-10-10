---
tags: [feature, expressions]
---
# Expression errors

A runtime failure becomes a red error chip with the message and the source text. The page never breaks and never goes blank.

An unknown name:

${unknownName}

A type error, here `+` on a number and a string:

${1 + "two"}

Division by zero:

${1 / 0}

An unknown function:

${doesNotExist(1)}

A query that does not match the `pages` schema:

${count({tga: "project"})}

A source longer than 500 characters is rejected before it runs (this one is padded):

${1 + 11111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111}

A parse failure, by contrast, stays the quiet chip: a Lua remnant that no grammar can read.

${for i = 1, 10 do print(i) end}

${kb.section(someVariable)}

Anything the grammar cannot parse keeps the same quiet chip, so old SilverBullet expressions stay visible but inert.
