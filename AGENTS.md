# Working on dead-drop

Instructions for coding agents. Humans should read [CONTRIBUTING.md](CONTRIBUTING.md), which covers the same ground more briefly.

## What this is

A transport-agnostic runtime that lets applications on different machines talk through infrastructure they already share: a git repository, a synced folder, object storage. Two packages in an npm workspace, TypeScript throughout, zero runtime dependencies outside the workspace itself.

Read [docs/architecture.md](docs/architecture.md) before changing anything structural. It explains the layering and, more usefully, what each layer is forbidden to know.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships, including the doc layer (`docs/`, ADRs, this file) — dead-drop is doc-heavy (791 of 2198 nodes), so skipping docs would miss most of what's worth knowing.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- The committed graph is a snapshot and can be stale. It carries no rebuild hook: the checked-in `graphify-out/` is whatever the last contributor to rebuild it produced, so treat it as orientation and read the source file before making a claim that matters. Refresh with `graphify extract . --backend claude-cli`, which covers code and docs; `graphify update` is code-only and would leave the doc layer behind.

## Commands

```bash
npm install
npm run verify      # lint, build, tests with coverage thresholds. The gate.
npm test            # tests only
npm run build       # tsc --build
npm run format      # prettier --write
npm run format:check
node examples/custom-transport/index.js   # 19/19 conformance cases
```

`npm run verify` must pass before you consider a change done. CI additionally runs `npm run format:check`, the three examples, and the whole suite on Windows, so a change that only passes on macOS is not finished.

The git and github transport tests need a `git` binary. Nothing needs network access or credentials.

## Layout

Two published packages. `packages/transport-sdk` is the contract; `packages/dead-drop` is everything else, split into layers that are directories, not packages.

| Path | What lives there |
| --- | --- |
| `packages/transport-sdk` | The contract third parties compile against, plus the conformance suite. Versioned independently. |
| `packages/dead-drop/src/protocol` | What a message is: envelope, framing, encryption, chunking, errors. Zero policy. |
| `packages/dead-drop/src/core` | All policy: mailbox engine, transport manager, retry, breaker, dedupe, observability. |
| `packages/dead-drop/src/runtime` | Workspaces, exposures, discovery, plugin loading, control plane. |
| `packages/dead-drop/src/sdk` | Client over the control socket. |
| `packages/dead-drop/src/cli` | The `ddrop` command. |
| `packages/dead-drop/src/transports/*` | filesystem, git, github, memory. |
| `packages/*/test/` | Unit tests, mirroring that package's `src/` tree. No test file lives in `src/`. |
| `test/` | Cross-package end-to-end and CLI tests. |
| `e2e/` | The scenario suite: `run.sh`, the `lib.sh` harness, and one file per subject under `fast/` and `live/`. |
| `docs/adr/` | Decision records for anything that deviates from the original design. |

Each layer is a subpath export of `@fyrlabs/dead-drop` (`./core`, `./runtime`, and so on). Layering is enforced by `no-restricted-imports` in `eslint.config.js`, not by package boundaries, in the direction protocol <- core <- runtime <- {sdk, cli}. Two documented exceptions: `runtime/plugins.ts` owns the transport table, and the github transport delegates to git. Tests are exempt because every layering rule scopes itself to `src/` and no test lives there.

## Invariants. Breaking one of these is a bug even if tests pass

1. **Nothing above the transport manager may name a transport.** Application code cannot ask for "the GitHub one". If it could, transport independence would be a slogan rather than a property.
2. **Two transport kinds, not one interface.** Adapters implement `put`/`get`/`list`/`delete` (`store`) or `send`/`subscribe` (`native`). Do not add `send`/`receive` to the store contract. See [ADR 0001](docs/adr/0001-store-and-native-transports.md).
3. **The control plane is a Unix socket, mode 0600, or a Windows named pipe. Never TCP.** See [ADR 0003](docs/adr/0003-unix-socket-control-plane.md).
4. **Delivery is at-least-once and ordering is best-effort per recipient.** Never write a doc or a comment that claims stronger.
5. **A message id is its trace id.** `workspace.request`, `mailbox.send` and `mailbox.deliver` key their span to the envelope id, a response using its `correlationId`. That is what makes `ddrop trace <requestId>` work with the id a timeout error already returns. Keep it if you add spans.
6. **A built-in transport may import only node builtins or a declared dependency of `packages/dead-drop`.** Workspaces are hoisted here, so a module that loads fine in this repo can be missing from a real install. `test/transport-imports.test.ts` enforces this. It went unguarded for several releases because the test that enforced it was named after `packages/cli` and did not survive the consolidation.
7. **`@fyrlabs/dead-drop-transport-sdk` is the only stable public contract.** It is the one thing outside this repository that must keep working across releases. Changing it is a breaking change.
8. **Never reintroduce the old name.** The project was called Bridge and the binary was `bridge`, which collided with iproute2's `bridge(8)` on Linux. Check with `rg -cil bridge -g '!AGENTS.md' -g '!.github/RELEASE_CHECKLIST.md' -g '!package-lock.json' -g '!graphify-out/**'`, which must print nothing. Those two files state the rule, so they are the only ones allowed to contain the word, and `graphify-out/` is extractor output that quotes the rule back out of them; a hit anywhere else is a regression.
9. **The transport is hostile storage, for frame *contents*.** Every frame is ciphertext including the envelope header, so do not add an envelope field that leaks a channel, peer or workspace name in clear text. **Object keys are the documented exception**: `ws/<workspace>/inbox/<peer>/<id>.ddf` puts those names in the storage path on purpose, so an operator can look at a git repo and understand it ([docs/security-model.md](docs/security-model.md)). Do not describe the transport as leaking nothing; a 0.1.0 release note claimed names "never appear in clear text" and was simply false. Changing the key layout means updating that doc.
10. **No key enters a `KeyRing` without a proof under the workspace secret.** Era keys arrive from the store now ([ADR 0007](docs/adr/0007-per-peer-key-wrapping.md)), and wrapping one needs only the recipient's public key, which is published in the clear on purpose. Before that, opening a frame at all proved its author held the secret; `unwrapEraKey` checks `dead-drop/v1/key-wrap-proof` before any Diffie-Hellman to keep it true, and the same goes for the era pointer that decides what everyone seals under. Drop either check and whoever can write to the store can forge a request from any peer, because a frame opens under whichever key id it names and the sender is only a field. This was a real hole between stages, caught by writing the attack as a test.
11. **`DeadDropError` identity is a registry symbol, never `instanceof`.** `DeadDropError.is` brand-checks `Symbol.for('@fyrlabs/dead-drop.DeadDropError')` so it still holds when two copies of transport-sdk end up in one dependency tree. Reverting it to `instanceof` is silent and bad: a third-party adapter's non-retryable error would be re-wrapped by `DeadDropError.from` as `INTERNAL`, which is retryable, and the retry loop would hammer a permanent failure. The same reasoning forbids an exact-version pin on transport-sdk.

## Conventions

**Commits.** Angular convention: `type(scope): subject`, imperative and lowercase, no trailing period. Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`. The body explains what and why, not how. Breaking changes use `!` or a `BREAKING CHANGE:` footer. One commit per completed logical unit, not one per session.

**Tests.** A test that would have caught the bug beats a test that covers the fix. Three real defects were caught this way and each is noted in the commit that fixed it. Coverage thresholds are 80% and currently sit near 90%, but coverage is a floor, not a goal.

**Time.** Injected everywhere through `Clock`. Never call `Date.now()` or a bare timer in runtime code; use the injected clock so retry and backoff suites run in milliseconds instead of sleeping.

**Errors.** Throw `DeadDropError` with a stable code and an honest `retryable` flag. The transport manager reads `retryable` to decide between retrying and failing over, so getting it wrong causes real misbehaviour.

**Docs.** If you change behaviour, config or the CLI, update the docs in the same commit. [docs/configuration.md](docs/configuration.md) is expected to match `packages/dead-drop/src/runtime/config.ts` field for field. Add a `CHANGELOG.md` entry under Unreleased for anything user-visible.

**ADRs.** Anything that deviates from the direction in [docs/vision.md](docs/vision.md) gets a record in `docs/adr/` explaining what was rejected and why.

## Things that will bite you

- **Windows.** Path handling and the named-pipe control plane differ. Never compare a resolved path against an unresolved one, and never assume `/` separators. Two Windows-only CI failures have happened for this, and the second one was in a *test*: a helper that binds its own control socket must take the same named-pipe branch `defaultSocketPath` does, because `listen` on a socket path fails there with a bare `EACCES` that names nothing. Anything that binds a listener, in `src/` or in a test, needs the platform branch.
- **Hoisting.** Every workspace package resolves from the repo root here, which hides missing dependencies. Check manifests, not just imports.
- **Prettier and identifier length.** Renaming a symbol can reflow lines and fail `format:check` in files you did not touch. Run `npm run format` after any large rename.
- **`npm publish` and `bin` paths.** A `./` prefix on a bin path makes npm warn that the entry "was invalid and removed". Write `dist/bin.js`, not `./dist/bin.js`.
- **Unix socket paths cap at 104 bytes.** `defaultSocketPath` falls back to a hashed path under the temp directory past that. Do not reintroduce a raw `join(dataDir, ...)`; a deep `dataDir` is reachable from the documented quick start and `bind` fails with a bare `EINVAL`.
- **`git push` exit 0 is not proof anything was published.** It prints "Everything up-to-date" and exits 0 when HEAD no longer carries the commit you meant to push, which happens whenever a second process shares the clone — and `ddrop connect` starts its own runtime from the same config, so it does. The git transport checks `merge-base --is-ancestor <commit> origin/<branch>` instead. Do not simplify that back to reading the exit code: it silently resolved writes whose data was gone, and a live GitHub run lost 10 of 50 requests to it.
- **`git rev-parse --git-dir` answers for the enclosing repository, not for the directory you are standing in.** It exits 0 anywhere under a checkout, so using it to decide whether `workDir` is already this transport's clone made a nested `workDir` read the user's own project as the clone, and `initialise` then repointed their `origin`, rewrote `user.name`/`user.email` and checked out an orphan branch over their work. Ask whether `<workDir>/.git` exists instead. Do not replace that with a `--show-toplevel` path comparison either: on macOS the temp directory is a symlink, so the resolved and unresolved forms differ and the check silently inverts.
- **A git working tree holds no dead-drop bookkeeping.** `git add --all` stages everything under the prefix, and `walk` lists everything that is not `.git` or `README.md`, so a file or directory placed inside `workDir` gets committed into the data branch and served as an object. Both the ownership lock and the extra clones live *beside* `workDir` (`<workDir>.owner`, `<workDir>.peers/`) for this reason. Putting either inside broke checkout for every other clone, twice, during development.
- **Never hard-code the version.** `VERSION` in `cli/cli.ts` reads the manifest. A literal there went stale and shipped a CLI that reported the wrong version in `--version`, `status` and `/health`. A test asserting the CLI output equals `VERSION` does not catch this; assert against `package.json`.

## Releasing

Both packages publish from a published GitHub release on a `v*` tag, but they **do not share a version**. `@fyrlabs/dead-drop-transport-sdk` is the stable contract and moves on its own, rarely; `@fyrlabs/dead-drop` depends on it by caret range and churns freely. The release workflow skips whichever package is already on the registry at its manifest version, so a release that only moves one of them works. The tag name tracks `@fyrlabs/dead-drop`.

Never pin the transport-sdk dependency to an exact version. `DeadDropError` identity depends on one copy of transport-sdk being installed, and an exact pin forces a second copy into any tree that also holds a third-party adapter. See invariant 11.

The checklist and the notes body are in [.github/RELEASE_TEMPLATE.md](.github/RELEASE_TEMPLATE.md). Do not tag without running the live GitHub walkthrough in [docs/testing.md](docs/testing.md); everything GitHub-specific is otherwise tested only against a scripted fake `gh`.

**Releasing does not need permission. Releasing something broken is the only thing to avoid.** When a change is an improvement and [.github/RELEASE_CHECKLIST.md](.github/RELEASE_CHECKLIST.md) passes end to end, publish it and say so afterwards. Do not leave verified work sitting unreleased waiting to be asked about, and do not stop to confirm a routine patch. Version numbers are cheap; a broken artifact on the registry is not, because a published version can never be reused.

**A tag is not a release.** `release.yml` publishes when a GitHub release is published, so tags are cheap and reversible: cut and push as many as are useful, and publish only the ones that earn it. Pushing `vX.Y.Z` marks a candidate and does nothing else; `gh release create vX.Y.Z` is what puts it on npm. A candidate that the following changes prove bad is simply never released, and the tag can be dropped with `git push origin :refs/tags/vX.Y.Z`. If a release exists but its publish run failed, re-run the workflow with `gh workflow run release.yml -f ref=vX.Y.Z` rather than re-tagging.

**Throwaway GitHub repositories for testing are fine to create without asking**, and fine to leave behind. Make them private (`gh repo create <owner>/<name> --private`), reuse one across sessions where that is simpler, and do not interrupt anyone to request cleanup; deleting them needs a `delete_repo` scope that is deliberately not granted. `e2e/run.sh live` takes the repository as its argument for this reason.
