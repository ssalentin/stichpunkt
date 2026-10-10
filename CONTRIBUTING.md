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
