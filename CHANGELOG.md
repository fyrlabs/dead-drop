# Changelog

Notable changes to dead-drop. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

Versions here track `@fyrlabs/dead-drop`. `@fyrlabs/dead-drop-transport-sdk` is the stable transport contract and versions independently; its changes are called out explicitly.

## [Unreleased]

### Added

- `concurrency` on a workspace, so a poll that finds several messages can handle them together instead of one at a time. Default 1, which is the behaviour up to now. Raising it removes head-of-line blocking behind a slow handler, at the cost of messages being answered out of the order they were sent.

## [0.4.1]

### Added

- `retry` and `breaker` on a workspace, so the retry ladder and the circuit breaker can be tuned from `deaddrop.config.json` instead of only in code. Every field is validated at start-up and a typo names itself, rather than silently falling back to the default.

  Raising `retry.maxAttempts` alone usually buys nothing: since 0.3.0 the request timeout bounds the whole request, so the extra attempts are cut off by the deadline rather than run. Raise `requestTimeoutMs` with it. `docs/configuration.md` says so next to the field.

## [0.4.0]

### Changed

- **`ddrop init` now writes a config that works.** It generates the workspace secret into `.deaddrop/secret` and points at it, so there is nothing to export before `ddrop start`. It writes the peer id explicitly, so two peers no longer default to the same hostname and collide. And it marks the shared location `REPLACE-ME` instead of quietly defaulting to a local folder, which used to leave two people each running a peer that could never see the other. `ddrop init --root <folder>` fills that in and leaves nothing to edit.

### Added

- Config values can now read a file with `${file:PATH}`, alongside `${env:NAME}`. Relative paths resolve against the config file, and surrounding whitespace is stripped, so a config can be committed with the secret sitting beside it rather than inside it.
- A config still holding a `REPLACE-ME` placeholder fails at start-up naming the exact field, instead of starting a runtime that reaches nobody.

### Docs

- The README now opens with a quick start that runs on one machine: two peers, a folder between them, and a `curl` that returns. The SDK, services and package entry points moved to `docs/sdk.md`.
- The README claimed channel, peer and workspace names "never appear in clear text", and listed object keys among the unprotected things two paragraphs later. The first was false. Keys read `ws/<workspace>/inbox/<peer>/<id>.ddf` on purpose, so an operator can look at a repository and understand it; frame contents were and are encrypted.

## [0.3.1]

### Fixed

- **The git transport no longer takes over a repository its `workDir` sits inside.** Pointing `workDir` at a path within one of your own checkouts -- which the quick start invites, since it suggests a relative path -- made the transport treat that checkout as its own clone: it repointed `origin`, rewrote the commit name and email, and checked out its data branch over your work. It now uses the directory it was given, and nothing above it.
- A runtime now starts even when no transport is reachable. `ddrop connect` used to wait for the first presence beacon to be published before binding its local port, so during a transport outage it never bound and callers saw "connection refused" with nothing in the log. Peers come and go; a local server no longer waits for one.
- Presence beacons no longer pile up on a slow transport. Only one is published at a time and it is abandoned once it is too old to be believed, so a backend that is merely slow is not pushed into failing by its own presence records.
- A transport that failed to start up once is no longer dead for good. The git and GitHub transports cached the failure from their first clone or authentication attempt and re-threw it for the life of the process, so a momentary network fault left a transport that could never recover, whatever its circuit breaker did.

## [0.3.0]

### Changed

- **A request timeout now bounds the whole request, not just the wait for a reply.** It used to guard only the reply, so while transports were failing the send in front of it ran unbounded and a caller asking for 15 seconds could wait two minutes. Check your timeouts before upgrading: a transport that is legitimately slower than the deadline you set will now fail at the deadline instead of succeeding late. Raise `requestTimeoutMs`, or `--timeout` on `ddrop connect`, if you move large payloads over a slow remote.
- Failing over to a healthy transport now takes seconds instead of minutes. A retry no longer backs off in front of a circuit breaker that is already open; the manager moves to the next transport immediately, which is why the fallback was configured.
- `allowPeers` matches the caller's configured `peerId`. It used to match the address replies are sent to, which for a `ddrop connect` client is a per-process value that appears in no config file, so a hand-written list matched nobody and denied everyone.

### Fixed

- A peer id was doing two jobs at once: a mailbox address and an identity. They are now separate, so a short-lived session can take its own address without losing who it is.

## [0.2.6]

### Fixed

- A request that timed out while its transport was still sending crashed the runtime. `ddrop connect` died outright the first time this happened during a transport outage.
- Connecting to an exposure a peer does not have now says `NOT_FOUND` with a 404, instead of `DECODE_FAILED` with a 500.

### Added

- `scripts/e2e.sh`: one scenario suite in two tiers, `fast` (no network, runs in CI) and `live` (a real GitHub repository, opt-in). Every scenario states what a user can and cannot do. It replaces the two older check scripts and covers broadcast, key rotation, transport failover, message expiry, `allowPeers` and the `http` exposure type for the first time. Both fixes above came out of writing it.

## [0.2.5]

### Changed

- Two runtimes on one `workDir` no longer share a git working tree, which git does not support. The first to start claims the directory and is laid out exactly as before; a second one clones into `<workDir>.peers/<workspace>-<peer>-<transport>/` and logs that it did. Abandoned clones are removed when the next runtime starts. This needs no configuration and mainly affects `ddrop connect`, which builds its runtime from the same config file as the peer already running.

## [0.2.4]

### Fixed

- The git and github transports could drop a message with no error anywhere. `git push` exits 0 saying "Everything up-to-date" when the commit it was meant to publish is no longer HEAD, which happens whenever a second process shares the clone. `ddrop connect` starts its own runtime from the same config, so it shares it. A push is now only treated as published once the commit is on the remote-tracking branch, and a discarded one is retried and logged. A live GitHub run lost 10 of 50 requests to this.

### Added

- `scripts/github-live-check.sh` runs the live GitHub walkthrough end to end against a real repository: authentication failure, discovery, a round trip, sustained concurrent load, and a 30 MiB object. It is opt-in and needs an account.
- `scripts/two-peer-check.sh` now also covers offline peer redelivery and the 32 MiB response cap.

## [0.2.3]

### Fixed

- A transport that can never work now says so. A wrong `repo` on the github transport used to let the runtime report `runtime started` and `control plane listening`, then flap its circuit breaker forever while the transport's own actionable message ("repository X does not exist or is not visible to you") reached no log at any level. Non-retryable health failures are now logged at error level, once per change. Found by running the walkthrough against a real GitHub account.

### Docs

- The 0.1.0 notes claimed channel, peer and workspace names "never appear in clear text on a transport". That was false: object keys are `ws/<workspace>/inbox/<peer>/<id>.ddf` and carry those names in the clear, deliberately, as `docs/security-model.md` has always documented. Corrected the claim and `AGENTS.md` invariant 9. Frame contents were and are encrypted; only the keys are readable.

## [0.2.2]

### Fixed

- The runtime reported version `0.1.0` when constructed directly without a `version` option, which reached `ddrop status` and `/health`. The version now comes from one module that reads the package manifest, and a test fails the build if any source file hard-codes one again.

### Docs

- Added a release checklist at `.github/RELEASE_CHECKLIST.md` and `scripts/two-peer-check.sh`, which runs two peers over one shared transport on a single machine. `docs/testing.md` explains the one thing that setup needs: an explicit `peerId`, since it otherwise defaults to the hostname for both.

## [0.2.1]

### Fixed

- `ddrop start` no longer dies with `listen EINVAL: invalid argument` when the data directory is nested deeply. A Unix socket path cannot exceed 104 bytes, and `ddrop init` writes a relative `.deaddrop` that resolves against the working directory, so any project more than about 84 characters deep hit it. The socket now falls back to a short deterministic path under the temp directory, keyed by a hash of the data directory, matching what Windows named pipes already did. Both the runtime and the client commands derive it the same way, so discovery is unaffected.
- `ddrop --version` reported `0.1.0` from a 0.2.0 install. The version was a hard-coded literal that the 0.2.0 release did not update, and it also fed the runtime, so `ddrop status` and `/health` reported it too. It is now read from the package manifest.

## [0.2.0]

### Changed

- `@fyrlabs/dead-drop-transport-sdk` is now **1.0.0** and no longer shares a version with `@fyrlabs/dead-drop`, which depends on it by caret range. The contract is settled and should stay put while the runtime keeps moving, so an adapter written today keeps working across dead-drop majors.

- **Breaking.** dead-drop now ships as two packages instead of ten. Everything except the transport contract lives in `@fyrlabs/dead-drop`, reachable by subpath: `/sdk`, `/runtime`, `/core`, `/protocol`, `/cli` and `/transports/<name>`. `@fyrlabs/dead-drop-transport-sdk` stays separate so a third-party adapter does not depend on the whole runtime. The eight other packages are gone.
- **Breaking.** The error model (`DeadDropError` and its codes) moved into `@fyrlabs/dead-drop-transport-sdk`, which is where it belongs: a transport adapter has to throw it, and the transport manager reads its `retryable` flag. `@fyrlabs/dead-drop/protocol` re-exports it, so importing it from the protocol layer still works.

### Fixed

- `DeadDropError.is` brand-checks a `Symbol.for` registry key instead of using `instanceof`, so it still recognises errors thrown across two copies of transport-sdk in one dependency tree. Previously such an error was re-wrapped as `INTERNAL`, which is retryable, so a permanent failure like `UNAUTHORIZED` would be retried indefinitely.
- The release workflow skips a package already published at its manifest version, instead of aborting the whole job before the package that did change gets published.
- Built-in transports load through static `import()` thunks rather than a specifier string. A dynamic `import(variable)` cannot be resolved relative to the importing module by bundlers or test runners, so the previous form worked under plain Node and failed everywhere else.

### Internal

- The layering used to be enforced by package boundaries. An eslint `no-restricted-imports` rule now enforces the same direction inside the single package: protocol imports nothing above it, core never names a transport, and a transport sees only the protocol and the transport SDK.

## [0.1.0]

First release.

### Added

- A runtime that moves traffic between machines over infrastructure they already share, with nothing deployed and no public port opened.
- Four transports: `filesystem` (any shared or synced directory), `git` (any remote `git clone` accepts), `github` (via the `gh` CLI, with rate-limit awareness), and `memory` (tests and examples).
- Proxy mode. `ddrop expose --target http://localhost:3000` makes an unmodified local server reachable to peers; `ddrop connect peer/name` serves it back as an ordinary local URL. Static directory exposures too.
- At-least-once delivery over plain object storage: framing, chunking, delete-as-acknowledgement, redelivery with backoff, dead letters, deduplication, retained broadcast topics, and polling that adapts to traffic.
- AES-256-GCM encryption of the whole envelope, header included, so message contents and envelope metadata are unreadable on the transport. Object keys are deliberately readable: workspace, peer and broadcast channel names appear in clear text in the storage path, along with message sizes, counts and timing. See [docs/security-model.md](docs/security-model.md) for what that does and does not protect.
- Multiple transports per workspace with health-based scoring, retry with jittered backoff, circuit breaking and failover.
- Observability: structured JSON logs with credential redaction, Prometheus metrics, and tracing where a message id is its own trace id, so `ddrop trace <requestId>` works with the id a timeout error already returns.
- A plugin contract for third-party transports, plus a framework-agnostic conformance suite. A `store` adapter is four methods.
- `@fyrlabs/dead-drop-sdk` for applications that want RPC and pub/sub rather than HTTP proxying.

### Known limitations

- The `github` transport is tested against a scripted `gh` and a local bare repository. It has not yet been validated against a live GitHub account, so real rate limits, real auth failures and real large-repository latency are unverified. The walkthrough for checking it yourself is in [docs/testing.md](docs/testing.md).
- Responses are buffered whole and capped at 32 MiB. Streaming is not implemented.
- Ordering is best-effort per recipient, and duplicates are suppressed rather than prevented, so handlers must be safe to run twice. See [docs/guarantees.md](docs/guarantees.md).
- `polling` and `policy` sub-fields are not type-checked when the config loads, so a wrong type there fails later than it should.
