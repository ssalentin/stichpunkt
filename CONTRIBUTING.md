# Contributing

## Language: English only

Everything that lands on GitHub is written in **English**:

- pull request titles and descriptions
- PR, issue and review comments
- issue titles and bodies
- commit messages
- branch names
- code comments, documentation and test names

German (or any other language) is fine for internal tickets and chat, but not for text we write in this repository. When copying text from an internal ticket into GitHub, translate it first.

This applies to text we write. Test fixtures and sample data that reproduce real input (e.g. the German strings in `test/widgets.test.ts`) keep their original language.

Commit messages that are already published on a shared branch are not rewritten (no force-push); note the exception in the PR instead.

## Development

See [Development](README.md#development) for setup and tests. Run `npm run check`, `npm test` and `npm run build` (the CI order) before opening a PR.

## Smoke tests that write must prove their isolation

A smoke test that calls `write_page`, `append_to_page`, `delete_page`, `move_page` or `write_pages` must never touch a real space. Copy the space with `cp -aL` from the **resolved** path: `SPACE_DIR` is commonly a symlink (for example `space -> /mnt/hetzner/knowledgebase`), and a plain `cp -r` would copy the symlink and make the test instance serve the live files.

Before the first write, prove which directory the instance reads:

1. start the instance against the copy on a free port,
2. create a marker page through that instance and read it back through the same instance,
3. check on disk that the marker exists in the copy and **does not** exist in the original,
4. keep that output in the test protocol.

Without step 3 the test has not proven anything and must not run. A read-only check (`check_links`, `search`, `history`) still needs the same proof when it is used as evidence about a specific space.
