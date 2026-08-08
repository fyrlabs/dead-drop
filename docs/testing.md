# Testing

```bash
npm run verify        # lint, build, tests with coverage thresholds
npm test              # tests only
npx vitest            # watch mode
```

Everything runs with no network, no credentials and no external services. The git transport tests need a `git` binary; that is the only external dependency.

## What is covered automatically

| Area | Where |
| --- | --- |
| Envelope validation, framing, encryption, chunking, HTTP mapping | `packages/protocol/src/*.test.ts` |
| Tamper detection, key rotation, cross-workspace key isolation | `packages/protocol/src/frame.test.ts` |
| Transport contract, for every store transport | conformance suite, run per transport |
| Retry, jitter, circuit breaker, deduplication, fake clock | `packages/core/src/reliability/*.test.ts` |
| Transport scoring, retry, failover, breaker, health | `packages/core/src/transport-manager.test.ts` |
| Delivery, acknowledgement, redelivery, dead letters, topics, chunk reassembly, adaptive polling | `packages/core/src/mailbox.test.ts` |
| Config parsing, plugin loading, path traversal | `packages/runtime/src/config.test.ts` |
| CLI argument handling and failure messages | `packages/cli/src/cli.test.ts` |
| Two real runtimes over a real transport | `tests/e2e.test.ts` |
| Real git: clone, push, fetch, push races, batching | `packages/transports/git/src/index.test.ts` |
| GitHub logic against a scripted `gh` | `packages/transports/github/src/index.test.ts` |

The end-to-end suite is the one that answers "does it work". It runs two independent runtimes against a shared directory and proxies real HTTP through them. One of its tests reads every byte the transport ever held and asserts that no application data, query string or exposure name appears in clear text.

Time is injected everywhere through a `Clock`, so retry and backoff suites run in milliseconds instead of sleeping. `TestClock.advance` drains the microtask queue through a macrotask boundary before each timer, which is what stops fake-timer tests from hanging on promise chains deeper than a fixed tick count.

## What needs a human

These need real credentials and a real account, so they cannot run in CI. Work through them before trusting the GitHub transport in production.

**GitHub transport, live**

- [ ] `gh auth login` and `gh auth setup-git`, then start a runtime with a `github` transport against a private repository you own.
- [ ] Confirm the `bridge-data` orphan branch is created and the repository's default branch is untouched.
- [ ] Run two peers on different machines. Confirm `bridge discover` sees both and `bridge connect` proxies a real request.
- [ ] Confirm no readable application data appears in the repository: clone the data branch and inspect it.
- [ ] Revoke `gh` auth mid-session. Confirm health reports `unavailable` with an actionable message and that failover to a second transport happens if one is configured.
- [ ] Drive the API rate limit low (or set `rateLimitIntervalMs` short and check `bridge transport health`). Confirm the transport reports `degraded` below 10% headroom.
- [ ] Push to the data branch from outside Bridge while a peer is sending, and confirm the push-race path recovers.
- [ ] Measure the real round trip. Set `requestTimeoutMs` accordingly and record it for your team.

**Scale and endurance**

- [ ] Leave two peers running for 24 hours with light traffic. Confirm the store does not grow without bound and memory is flat.
- [ ] Send a message to a peer that is offline for hours. Confirm it is delivered on return, or expires if it had a TTL.
- [ ] Run three or more peers in one workspace. Confirm broadcast reaches all of them and the retention reaper does not remove messages a slow subscriber has not read.
- [ ] Kill a runtime mid-delivery, restart, confirm the message is redelivered exactly once thanks to the persisted deduplication cache.

**Platform**

- [ ] Windows: named-pipe control plane, path handling, `bridge connect`.
- [ ] A network filesystem (SMB/NFS): the filesystem transport's polling watcher and atomic writes.
- [ ] OneDrive or Dropbox as the shared directory: confirm the sync client does not corrupt partially written frames. Atomic rename should prevent it; verify it.

Anything ticked here should be recorded with the date and the version tested.

## Coverage

Thresholds are 80% lines, functions, branches and statements, enforced by `npm run verify`. Index files, type-only modules and test helpers are excluded because coverage of a re-export is noise.

Coverage is a floor, not a goal. The tests that matter are the ones that would have caught a real defect, and three of those already have: the circuit breaker reading raw state instead of time-adjusted state, the mailbox acknowledging messages with no handler installed, and the topic reaper deleting messages whose age it could not determine. Each is noted in the commit that fixed it.
