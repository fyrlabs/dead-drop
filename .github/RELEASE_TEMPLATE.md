# Release template

The body used for a GitHub release. Copy the block below into the notes and fill it in from `CHANGELOG.md`.

**The checklist that has to pass before tagging lives in [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).** It is kept separate and single-sourced so the two cannot drift apart, which is exactly how `AGENTS.md` ended up claiming ten packages after the repo had two.

Two packages, and they do not share a version. `@fyrlabs/dead-drop-transport-sdk` is the stable transport contract and moves on its own, rarely; `@fyrlabs/dead-drop` depends on it by caret range and churns freely. The tag name and the release title are both `vX.Y.Z`, with no `dead-drop` prefix, and they track `@fyrlabs/dead-drop`.

## Release notes body

```markdown
<!-- One or two sentences: what this release is, and who should care. -->

### Breaking changes

<!-- What breaks and what to do about it. Write N/A if there are none; do not delete the section. -->

### Added

### Changed

### Fixed

### Install

​```bash
npm install -g @fyrlabs/dead-drop
​```

Requires Node.js 20.11 or newer.

### Packages

`@fyrlabs/dead-drop` at this version. `@fyrlabs/dead-drop-transport-sdk` versions independently; state its version explicitly and say whether it moved.

**Full changelog:** https://github.com/fyrlabs/dead-drop/blob/main/CHANGELOG.md
```

## After publishing

- [ ] `@fyrlabs/dead-drop` resolves on npm at the new version, and transport-sdk at whatever version it should be
- [ ] `verify-release.sh <version>` passes 40/40 against the registry, not just green CI
- [ ] `scripts/e2e.sh fast --npm <version>` is green against the published package, not just against this tree
- [ ] Provenance shows on the npm package page
- [ ] Tags and releases still line up: every released version keeps its tag and its release page. Delete a tag only when it never had a release, or when its artifact is broken and withdrawn
- [ ] A new Unreleased section opened in `CHANGELOG.md`
