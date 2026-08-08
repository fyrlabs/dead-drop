# Working on dead-drop

Instructions for coding agents. Humans should read [CONTRIBUTING.md](CONTRIBUTING.md), which covers the same ground more briefly.

## What this is

A transport-agnostic runtime that lets applications on different machines talk through infrastructure they already share: a git repository, a synced folder, object storage. Ten packages in an npm workspace, TypeScript throughout, zero runtime dependencies outside the workspace itself.

Read [docs/architecture.md](docs/architecture.md) before changing anything structural. It explains the layering and, more usefully, what each layer is forbidden to know.

## Commands

```bash
npm install
npm run verify      # lint, build, tests with coverage thresholds. The gate.
npm test            # tests only
npm run build       # tsc --build
npm run format      # prettier --write
npm run format:check
node examples/custom-transport/index.js   # 18/18 conformance cases
```

`npm run verify` must pass before you consider a change done. CI additionally runs `npm run format:check`, the three examples, and the whole suite on Windows, so a change that only passes on macOS is not finished.

The git and github transport tests need a `git` binary. Nothing needs network access or credentials.

## Layout

| Path | What lives there |
| --- | --- |
| `packages/protocol` | What a message is: envelope, framing, encryption, chunking, errors. Zero deps, zero policy. |
| `packages/transport-sdk` | The contract third parties compile against, plus the conformance suite. |
| `packages/core` | All policy: mailbox engine, transport manager, retry, breaker, dedupe, observability. |
| `packages/runtime` | Workspaces, exposures, discovery, plugin loading, control plane. |
| `packages/sdk` | Client over the control socket. |
| `packages/cli` | The `ddrop` command. |
| `packages/transports/*` | filesystem, git, github, memory. |
| `tests/` | Cross-package end-to-end and CLI tests. |
| `docs/adr/` | Decision records for anything that deviates from the original design. |

## Invariants. Breaking one of these is a bug even if tests pass

1. **Nothing above the transport manager may name a transport.** Application code cannot ask for "the GitHub one". If it could, transport independence would be a slogan rather than a property.
2. **Two transport kinds, not one interface.** Adapters implement `put`/`get`/`list`/`delete` (`store`) or `send`/`subscribe` (`native`). Do not add `send`/`receive` to the store contract. See [ADR 0001](docs/adr/0001-store-and-native-transports.md).
3. **The control plane is a Unix socket, mode 0600, or a Windows named pipe. Never TCP.** See [ADR 0003](docs/adr/0003-unix-socket-control-plane.md).
4. **Delivery is at-least-once and ordering is best-effort per recipient.** Never write a doc or a comment that claims stronger.
5. **A message id is its trace id.** `workspace.request`, `mailbox.send` and `mailbox.deliver` key their span to the envelope id, a response using its `correlationId`. That is what makes `ddrop trace <requestId>` work with the id a timeout error already returns. Keep it if you add spans.
6. **Every built-in transport short name must be a dependency of `packages/cli`.** Workspaces are hoisted here, so a module that loads fine in this repo can be missing from a real install. `packages/cli/src/cli.test.ts` enforces this.
7. **`@fyrlabs/dead-drop-transport-sdk` is the only stable public contract.** It is the one thing outside this repository that must keep working across releases. Changing it is a breaking change.
8. **Never reintroduce the old name.** The project was called Bridge and the binary was `bridge`, which collided with iproute2's `bridge(8)` on Linux. Check with `rg -ci bridge`, excluding `node_modules`, `dist` and `package-lock.json`. This file is the only one that may match. A hit anywhere else is a regression.
9. **The transport is hostile storage.** Everything on it is ciphertext including the envelope header. Do not add a field that leaks a channel, peer or workspace name in clear text.

## Conventions

**Commits.** Angular convention: `type(scope): subject`, imperative and lowercase, no trailing period. Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`. The body explains what and why, not how. Breaking changes use `!` or a `BREAKING CHANGE:` footer. One commit per completed logical unit, not one per session.

**Tests.** A test that would have caught the bug beats a test that covers the fix. Three real defects were caught this way and each is noted in the commit that fixed it. Coverage thresholds are 80% and currently sit near 90%, but coverage is a floor, not a goal.

**Time.** Injected everywhere through `Clock`. Never call `Date.now()` or a bare timer in runtime code; use the injected clock so retry and backoff suites run in milliseconds instead of sleeping.

**Errors.** Throw `DeadDropError` with a stable code and an honest `retryable` flag. The transport manager reads `retryable` to decide between retrying and failing over, so getting it wrong causes real misbehaviour.

**Docs.** If you change behaviour, config or the CLI, update the docs in the same commit. [docs/configuration.md](docs/configuration.md) is expected to match `packages/runtime/src/config.ts` field for field. Add a `CHANGELOG.md` entry under Unreleased for anything user-visible.

**ADRs.** Anything that deviates from the direction in [docs/vision.md](docs/vision.md) gets a record in `docs/adr/` explaining what was rejected and why.

## Things that will bite you

- **Windows.** Path handling and the named-pipe control plane differ. Never compare a resolved path against an unresolved one, and never assume `/` separators. A Windows-only CI failure has already happened once for exactly this reason.
- **Hoisting.** Every workspace package resolves from the repo root here, which hides missing dependencies. Check manifests, not just imports.
- **Prettier and identifier length.** Renaming a symbol can reflow lines and fail `format:check` in files you did not touch. Run `npm run format` after any large rename.
- **`npm publish` and `bin` paths.** A `./` prefix on a bin path makes npm warn that the entry "was invalid and removed". Write `dist/bin.js`, not `./dist/bin.js`.

## Releasing

All ten packages share one version and publish together from a `v*` tag. The checklist and the notes body are in [.github/RELEASE_TEMPLATE.md](.github/RELEASE_TEMPLATE.md). Do not tag without running the live GitHub walkthrough in [docs/testing.md](docs/testing.md); everything GitHub-specific is otherwise tested only against a scripted fake `gh`.
