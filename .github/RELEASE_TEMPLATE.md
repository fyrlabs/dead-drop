# Release template

The body used for a GitHub release. Copy the block below into the notes and fill it in from `CHANGELOG.md`.

**The checklist that has to pass before tagging lives in [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).** It is kept separate and single-sourced so the two cannot drift apart, which is exactly how `AGENTS.md` ended up claiming ten packages after the repo had two.

Two packages, and they do not share a version. `@fyrlabs/dead-drop-transport-sdk` is the stable transport contract and moves on its own, rarely; `@fyrlabs/dead-drop` depends on it by caret range and churns freely. The tag name and the release title are both `vX.Y.Z`, with no `dead-drop` prefix, and they track `@fyrlabs/dead-drop`.

## Release notes body

```markdown
<!-- One or two sentences: what this release is, and who should care. -->

### Breaking changes

<!-- What breaks and what to do about it. Delete the section if there are none. -->

### Added

### Changed

### Fixed

### Install

​```bash
npm install -g @fyrlabs/dead-drop
​```

Requires Node.js 20.11 or newer.

### Packages

All published at this version: `@fyrlabs/dead-drop`, `-sdk`, `-runtime`, `-core`, `-protocol`, `-transport-sdk`, `-transport-filesystem`, `-transport-git`, `-transport-github`, `-transport-memory`.

**Full changelog:** https://github.com/fyrlabs/dead-drop/blob/main/CHANGELOG.md
```

## After publishing

- [ ] All ten packages resolve on npm at the new version
- [ ] `npm install -g @fyrlabs/dead-drop` on a clean machine, then `ddrop --help`
- [ ] Provenance shows on the npm package pages
- [ ] A new Unreleased section opened in `CHANGELOG.md`
