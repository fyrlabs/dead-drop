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
| Envelope validation, framing, encryption, chunking, HTTP mapping | `packages/dead-drop/test/protocol/*.test.ts` |
| Tamper detection, key rotation, cross-workspace key isolation | `packages/dead-drop/test/protocol/frame.test.ts` |
| Transport contract, for every store transport | conformance suite, run per transport |
| Retry, jitter, circuit breaker, deduplication, fake clock | `packages/dead-drop/test/core/reliability/*.test.ts` |
| Transport scoring, retry, failover, breaker, health | `packages/dead-drop/test/core/transport-manager.test.ts` |
| Delivery, acknowledgement, redelivery, dead letters, topics, chunk reassembly, adaptive polling | `packages/dead-drop/test/core/mailbox.test.ts` |
| Config parsing, plugin loading, path traversal | `packages/dead-drop/test/runtime/config.test.ts` |
| CLI argument handling and failure messages | `packages/dead-drop/test/cli/cli.test.ts` |
| Two real runtimes over a real transport | `test/e2e.test.ts` |
| Real git: clone, push, fetch, push races, batching | `packages/dead-drop/test/transports/git/index.test.ts` |
| GitHub logic against a scripted `gh` | `packages/dead-drop/test/transports/github/index.test.ts` |

Each package keeps its tests in a `test/` tree mirroring `src/`, so the subject of `test/core/mailbox.test.ts` is `src/core/mailbox.ts`. Nothing under `src/` is a test. Shared test doubles live in `packages/dead-drop/test/core/testing.ts`.

The end-to-end suite is the one that answers "does it work". It runs two independent runtimes against a shared directory and proxies real HTTP through them. One of its tests reads every byte the transport ever held and asserts that no application data, query string or exposure name appears in clear text.

Time is injected everywhere through a `Clock`, so retry and backoff suites run in milliseconds instead of sleeping. `TestClock.advance` drains the microtask queue through a macrotask boundary before each timer, which is what stops fake-timer tests from hanging on promise chains deeper than a fixed tick count.

## The scenario suite

Unit tests answer "does this function behave". The scenario suite answers "can a user do this, and is it stopped from doing what it should not". Every bug found during the 0.2.x series was invisible to the unit suite because it only existed once real processes, real sockets, real files and real restarts were involved.

```bash
e2e/run.sh fast                        # no network, no credentials
e2e/run.sh live <owner>/<repo>         # a real GitHub repository, opt-in
e2e/run.sh all <owner>/<repo>          # both
e2e/run.sh fast --npm 0.2.5            # a published version instead of this tree
e2e/run.sh fast --only broadcast       # one file
e2e/run.sh --list                      # what is in each tier
```

Every scenario is written as what a user **can** do and what a user **cannot** do, and both halves are required: the runner fails a scenario that declares only one kind, because a capability nobody has bounded is a capability nobody understands. The `PASS CAN` / `PASS CANNOT` lines are the documentation.

Scenarios live one file per subject under `e2e/fast/` and `e2e/live/`, with the shared harness in `e2e/lib.sh`. Adding one means adding a file; the runner picks it up.

### The fast tier

No network, no credentials, safe for CI, and it runs before every release. Under four minutes. The slowest files are `07-failover.sh`, which waits for real circuit breakers to trip, `06-key-rotation.sh`, which restarts peers, and `10-reaping.sh`, which has to outlast a retention window.

| File | What it establishes |
| --- | --- |
| `01-configuration.sh` | Bad configuration is refused out loud, before anything looks alive |
| `02-control-plane.sh` | The control plane is an owner-only socket, and a data directory too deep for one still works |
| `03-two-peers.sh` | Discovery, a round trip, ciphertext on the transport, static exposure limits, offline redelivery, message expiry, 30 MiB payloads and the 32 MiB cap |
| `04-exposures.sh` | `allowPeers`, and an `http` exposure proxying a local server that is up and then down |
| `05-broadcast.sh` | One publisher, three subscribers, one peer that never subscribed, one that was offline |
| `06-key-rotation.sh` | Two-stage rotation with no downtime, and a peer left on the retired key failing closed |
| `07-failover.sh` | A transport dying under a running peer, recovery when it comes back, and the `parallel` policy putting a copy on every transport while `failover` puts it on one |
| `08-git-transport.sh` | The git transport against a local bare repository, including two runtimes sharing one `workDir` |
| `09-dashboard.sh` | The dashboard binds where it was told, renders with no network, only reads, and starts no runtime |
| `10-reaping.sh` | Mail for a peer that comes back survives its window; mail for one that never existed is reclaimed, and running peers' beacons are not |

### The live tier

Real credentials, a real repository, about fifteen minutes. It writes a `deaddrop-data` branch to the repository you name and leaves it there, so point it at a private throwaway:

```bash
gh repo create <owner>/dead-drop-trial --private
e2e/run.sh live <owner>/dead-drop-trial
```

It covers authentication failure, discovery, a real round trip, fifty concurrent requests, and a 30 MiB object through git. This is the tier that found the `git push` exit-code bug: nothing local reproduced it, because a local push is too fast to interleave.

**Do not put the live tier in CI.** It needs credentials and writes to a real repository.

### One thing a same-machine run must do

**Set `peerId` explicitly in every config.** It defaults to the machine's hostname, so two runtimes on one box otherwise share a mailbox address, poll each other's mail, and fail with `DECODE_FAILED` on garbage frames. That is correct behaviour for a colliding address, not a bug, and it is the first thing to check when a local multi-peer setup misbehaves.

## What still needs a human

The walkthrough below is worth doing once on two real machines, because one machine cannot tell you anything about the network between them. Windows named pipes also still need driving by hand: the Windows CI job proves the test suite passes, not that anyone has used the control plane there.

### The walkthrough, start to finish

This is the first live test to run. It takes about half an hour and answers the one question the automated suite cannot: does this move real bytes between two real machines over a real GitHub repository.

You need two machines, both with Node.js 20.11 or newer, `git`, and `gh`. Anything works as the second machine: a laptop, a VM, a cloud shell, a colleague's desktop.

**1. Install the CLI on both machines.** Nothing is published yet, so install from a clone:

```bash
git clone https://github.com/fyrlabs/dead-drop && cd dead-drop
npm install && npm run build
npm link --workspace packages/cli     # puts `ddrop` on your PATH
ddrop --help                          # confirm it runs
```

If you would rather not touch your global npm prefix, skip `npm link` and use `node /path/to/dead-drop/packages/cli/dist/bin.js` everywhere this guide says `ddrop`.

**2. Authenticate, on both machines:**

```bash
gh auth login
gh auth setup-git
```

**3. Make one secret, on machine A only:**

```bash
ddrop keygen        # prints ddk1_… on stdout, guidance on stderr
```

Copy that value to both machines over something you trust. Holding it is workspace membership, so treat it like a password. On both machines:

```bash
export DEADDROP_SECRET='ddk1_…'
```

**4. Write `deaddrop.config.json` on machine A.** Run something on `localhost:3000` first, any HTTP server at all, so there is a real application to expose:

```json
{
  "dataDir": ".deaddrop",
  "workspaces": [
    {
      "name": "demo",
      "peerId": "machine-a",
      "secrets": ["${env:DEADDROP_SECRET}"],
      "transports": [
        {
          "use": "github",
          "config": {
            "repo": "YOUR-USERNAME/deaddrop-live-test",
            "workDir": ".deaddrop/gh",
            "createIfMissing": true,
            "private": true
          }
        }
      ],
      "exposures": [{ "name": "my-api", "type": "http", "target": "http://localhost:3000" }]
    }
  ]
}
```

**5. On machine B, the same file with two changes:** `peerId` is `machine-b`, `exposures` is `[]`, and `createIfMissing` is `false` so a typo in the repository name fails loudly instead of silently creating a second repository.

**6. Start both runtimes.** `ddrop start` holds the foreground, so the rest goes in a second shell on each machine:

```bash
ddrop start
```

**7. Work through the checks.** Each line has an expected result, so a wrong answer is obvious:

| On | Command | What you should see |
| --- | --- | --- |
| A | `ddrop status` | the workspace `demo`, one transport, healthy |
| A | `gh repo view YOUR-USERNAME/deaddrop-live-test` | the repository exists and is private |
| A | `git ls-remote --heads https://github.com/YOUR-USERNAME/deaddrop-live-test` | a `deaddrop-data` branch, and no change to `main` |
| B | `ddrop discover` | `machine-a`, with the exposure `my-api` |
| B | `ddrop connect machine-a/my-api` | a local URL such as `http://127.0.0.1:53219` |
| B | `curl http://127.0.0.1:53219/` in a third shell | exactly what `localhost:3000` on machine A returns |
| B | `ddrop transport health` | the github transport, with its rate-limit headroom |

**8. Confirm the transport cannot read your traffic.** This is the claim in [the security model](security-model.md), so check it rather than trusting it:

```bash
git clone --branch deaddrop-data --single-branch \
  https://github.com/YOUR-USERNAME/deaddrop-live-test /tmp/inspect
grep -ri "something that appeared in your http response" /tmp/inspect   # expect no matches
```

**9. Record the round trip.** Time a request through `ddrop connect` and write the number down. It will be seconds, not milliseconds, and it is what you should set `requestTimeoutMs` from.

If every row matches, the GitHub transport works end to end and the rest of this section is hardening rather than discovery. If any row does not, that is a bug worth filing with the output of `ddrop logs` and `ddrop trace`.

### The rest of the checklist

**GitHub transport, live**

- [ ] The walkthrough above, end to end.
- [ ] Confirm the `deaddrop-data` orphan branch is created and the repository's default branch is untouched.
- [ ] Run two peers on different machines. Confirm `ddrop discover` sees both and `ddrop connect` proxies a real request.
- [ ] Confirm no readable application data appears in the repository: clone the data branch and inspect it.
- [ ] Revoke `gh` auth mid-session. Confirm health reports `unavailable` with an actionable message and that failover to a second transport happens if one is configured.
- [ ] Drive the API rate limit low (or set `rateLimitIntervalMs` short and check `ddrop transport health`). Confirm the transport reports `degraded` below 10% headroom.
- [ ] Push to the data branch from outside dead-drop while a peer is sending, and confirm the push-race path recovers.
- [ ] Measure the real round trip. Set `requestTimeoutMs` accordingly and record it for your team.

**Scale and endurance**

- [ ] Leave two peers running for 24 hours with light traffic. Confirm the store does not grow without bound and memory is flat.
- [ ] Send a message to a peer that is offline for hours. Confirm it is delivered on return, or expires if it had a TTL.
- [ ] Run three or more peers in one workspace. Confirm broadcast reaches all of them and the retention reaper does not remove messages a slow subscriber has not read.
- [ ] Kill a runtime mid-delivery, restart, confirm the message is redelivered exactly once thanks to the persisted deduplication cache.

**Platform**

- [ ] Windows: named-pipe control plane, path handling, `ddrop connect`.
- [ ] A network filesystem (SMB/NFS): the filesystem transport's polling watcher and atomic writes.
- [ ] OneDrive or Dropbox as the shared directory: confirm the sync client does not corrupt partially written frames. Atomic rename should prevent it; verify it.

Anything ticked here should be recorded with the date and the version tested.

## Coverage

Thresholds are 80% lines, functions, branches and statements, enforced by `npm run verify`. Index files, type-only modules and test helpers are excluded because coverage of a re-export is noise.

Coverage is a floor, not a goal. The tests that matter are the ones that would have caught a real defect, and three of those already have: the circuit breaker reading raw state instead of time-adjusted state, the mailbox acknowledging messages with no handler installed, and the topic reaper deleting messages whose age it could not determine. Each is noted in the commit that fixed it.

<!-- graphify hook verification, 2026-08-10 -->
