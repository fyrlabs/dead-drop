# Release checklist

Work top to bottom. Every item here exists because something went wrong once; the parenthetical says what. Do not skip an item because it looks obvious, especially the ones that only fail in a published artifact.

The notes body template is in [RELEASE_TEMPLATE.md](RELEASE_TEMPLATE.md).

## 1. Before you touch a version number

- [ ] `main` is green on all three CI jobs, **including Windows**. A change that only passes on macOS is not finished.
- [ ] `npm run verify` passes from a clean checkout (`npm ci`, not a warm `node_modules`).
- [ ] `npm run format:check` passes. A rename can reflow files you never opened.
- [ ] `node examples/custom-transport/index.js` reports 19/19 conformance cases.
- [ ] `rg -cil bridge -g '!AGENTS.md' -g '!.github/RELEASE_CHECKLIST.md' -g '!package-lock.json'` prints nothing (invariant 8). The two files that state the rule contain the word, so they have to be excluded or this can never pass.

## 2. Versions

The two packages **do not share a version**. `@fyrlabs/dead-drop` churns; `@fyrlabs/dead-drop-transport-sdk` is the stable contract and should stand still.

- [ ] `packages/dead-drop/package.json` bumped, and the root `package.json` matches it (the root is private, but its version shows in every build banner).
- [ ] transport-sdk bumped **only if its public surface actually changed**, by semver against its own last version, not in lockstep.
- [ ] The transport-sdk dependency in `packages/dead-drop/package.json` is a **caret range**, never an exact pin. (An exact pin forces a second copy of the SDK into any tree holding a third-party adapter, which breaks `DeadDropError` identity and silently turns a permanent failure into an infinite retry. AGENTS.md invariant 10.)
- [ ] No source file hard-codes a version. `npx vitest run packages/dead-drop/src/version.test.ts` enforces this. (0.2.0 shipped a CLI reporting `0.1.0` from `--version`, `status` and `/health`, because three files each held their own literal.)
- [ ] `CHANGELOG.md` has an entry, and nothing user-visible is missing from it.
- [ ] Breaking changes are called out in the changelog **and** in the release notes.

## 3. Docs match the code

- [ ] `docs/configuration.md` matches `packages/dead-drop/src/runtime/config.ts` field for field.
- [ ] `AGENTS.md` still describes the real layout. (It claimed ten packages for two commits after the consolidation.)
- [ ] Anything you changed in behaviour, config or the CLI is documented in the same commit.

## 4. The thing that is never done and always should be

- [ ] `scripts/e2e.sh fast` is green. No network, no credentials, about ten minutes. It runs real runtimes against real transports and asserts what a user can and cannot do, which is where every bug in the 0.2.x series was found.
- [ ] `scripts/e2e.sh live <owner>/<throwaway-repo>` is green, in about fifteen minutes. Everything GitHub-specific is otherwise tested only against a scripted fake `gh` and a local bare repo, so real auth, rate limits, latency and large-repo behaviour are unverified without it. (0.2.4 fixed a silent message loss that only this found: it lost 10 of 50 concurrent requests, and nothing in the suite could see it.)

## 5. Tag and publish

- [ ] `NPM_TOKEN` is present in the repository secrets and is **read-write** for the `@fyrlabs` scope. (The first 0.1.0 attempt died with `E404 PUT`, which is what npm returns for an unauthorised publish, not a missing package.)
- [ ] Tag name and GitHub release title are both `vX.Y.Z`. No `dead-drop` prefix.

Publishing the GitHub release is what publishes to npm; the tag on its own does nothing. Push the tag whenever a version is worth marking, and come back for the second half when it has earned a release.

```bash
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z                                    # a candidate, nothing is published yet

gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <notes>   # this publishes
gh run watch $(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

The workflow publishes in dependency order and skips whichever package is already on the registry at its manifest version, so a release moving only one package works. If the release exists but its run failed, re-run it with `gh workflow run release.yml -f ref=vX.Y.Z` instead of re-tagging.

## 6. Verify the published artifact, not the green check

**A green CI run proves the tests passed. It does not prove the tarball is right.** Both 0.1.0 and 0.2.0 passed CI while shipping a CLI that reported the wrong version.

- [ ] Run it:

```bash
~/.claude/artifacts/-Users-me-workspace-dead-drop/verify-release.sh X.Y.Z
```

It installs from the registry into a throwaway prefix and checks: retired packages gone, survivors intact, exactly one transport-sdk copy, caret range, both bins, every subpath export, `ddrop --version`, a `dataDir` past the 104-byte socket limit binding, the `DeadDropError` cross-copy brand, and a live runtime answering over its control socket. Expect 40 pass, 0 fail.

## 7. Clean up

- [ ] Tags and releases line up. Every released version keeps its tag and its release page; that history is the point. Delete a tag only when it never had a release, or when its artifact is broken and withdrawn:

```bash
git push origin :refs/tags/vOLD && git tag -d vOLD
```

- [ ] Deprecate a version only if it is **actually bad**, not merely superseded. Deprecating every previous release trains people to ignore the warning. When you do, deprecate rather than unpublish: deprecation is reversible, unpublishing is not, and a version number can never be reused.

```bash
npm deprecate @fyrlabs/dead-drop@X.Y.Z "superseded by A.B.C" --otp=<code>
```

Deprecation takes tens of seconds to show on the registry. Checking immediately shows the version still active; that is lag, not failure.

- [ ] If you must unpublish: `npm unpublish` **always** demands an OTP, so it can never run unattended, and it returns `E422 Unprocessable Entity` when you fire several in a row even with nothing depending on them. Retry with a fresh code. Never unpublish every version of a name; that blocks republishing it for 24 hours.
