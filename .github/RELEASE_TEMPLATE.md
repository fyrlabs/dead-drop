# Release template

The body used for a GitHub release, plus the checklist that has to pass before tagging. Copy the second half into the release notes and fill it in from `CHANGELOG.md`.

Two packages, and they **do not share a version**. `@fyrlabs/dead-drop-transport-sdk` is the stable transport contract and moves on its own, rarely; `@fyrlabs/dead-drop` depends on it by caret range and churns freely. The tag name tracks `@fyrlabs/dead-drop`.

Pushing a `v*` tag runs `.github/workflows/release.yml`, which publishes in dependency order with npm provenance and skips whichever package is already on the registry at its manifest version. So a release that only moves one package works without touching the other.

## Before tagging

- [ ] `main` is green on all three CI jobs, including Windows
- [ ] `npm run verify` passes locally from a clean checkout
- [ ] `CHANGELOG.md` has an entry for this version, and nothing user-visible is missing from it
- [ ] `@fyrlabs/dead-drop` version bumped, and the transport-sdk dependency is still a caret range, never an exact pin
- [ ] transport-sdk bumped only if its public surface actually changed, and by semver against its own last version
- [ ] `ddrop --version` on a built tree reports the manifest version
- [ ] Breaking changes are called out in the changelog and in the notes below
- [ ] The live GitHub walkthrough in `docs/testing.md` has been run against a real account
- [ ] `NPM_TOKEN` is present in the repository secrets

## Tagging

The tag is the version. The message is one line.

```bash
git tag -a v0.1.0 -m "dead-drop 0.1.0"
git push origin v0.1.0
```

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
