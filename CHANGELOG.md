# Changelog

Notable changes to dead-drop. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

All packages in this repository share one version number and are released together.

## [Unreleased]

## [0.2.0]

### Changed

- **Breaking.** dead-drop now ships as two packages instead of ten. Everything except the transport contract lives in `@fyrlabs/dead-drop`, reachable by subpath: `/sdk`, `/runtime`, `/core`, `/protocol`, `/cli` and `/transports/<name>`. `@fyrlabs/dead-drop-transport-sdk` stays separate so a third-party adapter does not depend on the whole runtime. The eight other packages are gone.
- **Breaking.** The error model (`DeadDropError` and its codes) moved into `@fyrlabs/dead-drop-transport-sdk`, which is where it belongs: a transport adapter has to throw it, and the transport manager reads its `retryable` flag. `@fyrlabs/dead-drop/protocol` re-exports it, so importing it from the protocol layer still works.

### Fixed

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
- AES-256-GCM encryption of the whole envelope, header included, so channel, peer and workspace names never appear in clear text on a transport.
- Multiple transports per workspace with health-based scoring, retry with jittered backoff, circuit breaking and failover.
- Observability: structured JSON logs with credential redaction, Prometheus metrics, and tracing where a message id is its own trace id, so `ddrop trace <requestId>` works with the id a timeout error already returns.
- A plugin contract for third-party transports, plus a framework-agnostic conformance suite. A `store` adapter is four methods.
- `@fyrlabs/dead-drop-sdk` for applications that want RPC and pub/sub rather than HTTP proxying.

### Known limitations

- The `github` transport is tested against a scripted `gh` and a local bare repository. It has not yet been validated against a live GitHub account, so real rate limits, real auth failures and real large-repository latency are unverified. The walkthrough for checking it yourself is in [docs/testing.md](docs/testing.md).
- Responses are buffered whole and capped at 32 MiB. Streaming is not implemented.
- Ordering is best-effort per recipient, and duplicates are suppressed rather than prevented, so handlers must be safe to run twice. See [docs/guarantees.md](docs/guarantees.md).
- `polling` and `policy` sub-fields are not type-checked when the config loads, so a wrong type there fails later than it should.
