## What this changes

<!-- What the change does and why. Describe the behaviour as it now is, not the diff. -->

## Why

<!-- The problem being solved. If it fixes an issue, link it: Fixes #123 -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation
- [ ] Refactor, performance or tooling

## Breaking changes

<!-- If you ticked "Breaking change": what breaks, and what a user has to do about it.
     Wire format, transport contract, config schema, CLI flags and exported types
     are all public surface. Write "None" if nothing breaks. -->

None.

## Testing

<!-- What you ran, and what a reviewer should run to see it work.
     A test that would have caught the bug is worth more than a test that covers the fix. -->

- [ ] `npm run verify` passes (lint, build, tests with coverage thresholds)
- [ ] New or changed behaviour has a test that fails without the change
- [ ] Ran the examples if they touch this area: `node examples/*/index.js`

## Checklist

- [ ] Commits follow the Angular convention: `type(scope): subject`
- [ ] Docs updated if behaviour, config or the CLI changed
- [ ] `CHANGELOG.md` updated under Unreleased if this is user-visible
- [ ] An ADR added under `docs/adr/` if this deviates from `docs/design-sketch.md`
- [ ] No secrets, tokens or absolute local paths in the diff

## Notes for the reviewer

<!-- Anything worth knowing: a decision you were unsure about, an alternative you
     rejected, the part most likely to be wrong. -->
