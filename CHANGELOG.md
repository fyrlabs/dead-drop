# Changelog

Notable changes to dead-drop. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

All packages in this repository share one version number and are released together.

## [Unreleased]

### Added

- `ddrop trace` shows a request as a span tree. Because a message id is its trace id, the request id in a timeout error is the argument you pass.
- Architecture and quick-start diagrams in the README and `docs/architecture.md`.

### Changed

- **Breaking.** The command is now `ddrop`, with `dead-drop` as a second name for the same binary. The old name collided with iproute2's `bridge(8)` on Linux.
- **Breaking.** `bridge.config.json` is now `deaddrop.config.json`, `BRIDGE_SECRET` is `DEADDROP_SECRET`, `BRIDGE_PEER_ID` is `DEADDROP_PEER_ID`, the data directory is `.deaddrop`, and the git data branch is `deaddrop-data`.
- **Breaking.** Prometheus metrics are prefixed `deaddrop_` instead of `bridge_`.
- **Breaking.** `BridgeError` is now `DeadDropError`, along with its code, options and helper types, plus `BridgeRuntime` and `BridgeClient`.
- Packages publish under the `@fyrlabs` scope.

### Fixed

- Client commands computed the control socket from the default data directory while `ddrop start` derived it from the config, so the documented quick start could never connect.
- A leading `~` in a config path resolved to a literal directory named `~` beside the config file.
- `ddrop connect` reused the configured peer id and raced an already-running `ddrop start` for the same inbox.
- Static exposures rejected valid paths on Windows because the traversal guard compared a resolved path against an unresolved root.
- Every per-package README linked to `https://github.com/` with no path.

## [0.1.0]

Unreleased. This is the first version; the entries above describe it.
