---
manifest: 1
summary: "Notes are short and factual. Every page needs an `updated` date in its frontmatter. Put pages into one of the declared folders. Never store credentials in pages."
pages:
  required_frontmatter: [updated]
  forbidden_prefixes: ["Sources:"]
folders:
  Projects: { owner: "Project leads", description: "One page per project" }
  Runbooks: { description: "How to operate things", template: "Templates/Runbook" }
  Templates: { description: "Page templates" }
checks: [secrets]
---
# Documentation rules

- Keep pages short; link instead of copying.
- Every page carries `updated: YYYY-MM-DD` in its frontmatter.
- New pages go below `Projects/`, `Runbooks/` or `Templates/`.
- Do not start lines with `Sources:`; link the source inline.
- Secrets belong in a password manager, never in a page.
