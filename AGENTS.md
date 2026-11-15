# Agent instructions

Rules for agents working in this repository. [CONTRIBUTING.md](CONTRIBUTING.md) covers language, development commands and smoke-test isolation, and applies unchanged.

## Visual evidence for finished features

A feature is finished only with visual evidence. Every PR that completes a feature includes at least one screenshot of the feature working in the real product.

- UI features: a screenshot of the running app with the feature visible, desktop, plus mobile below 640px when the feature touches the layout.
- Backend features (API, CLI, scripts, deploy tooling): a capture of the observable result instead, such as the rendered API response, the produced file opened in its target application, or the terminal session with its output.
- Store evidence images in `docs/assets/`, named `<feature>-<view>.png`, following the existing `screenshot-desktop.png` and `screenshot-mobile.png` convention.
- Embed the screenshots in the PR description, and reference them from `docs/` when the feature is documented there.

A PR without visual evidence for the feature it ships is not merge-ready.
