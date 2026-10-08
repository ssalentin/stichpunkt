---
tags: collection
---
# Projects

${kb.section("project")}

${(kb and kb.safe("Project list", function() return kb.recent("project", 200) end)) or "*List unavailable*"}

A category page. The widgets above are built in: a header with the note count and last date, and the newest notes first. Because the page contains a `kb.recent` list, the automatic "Pages tagged" list is not appended a second time.
