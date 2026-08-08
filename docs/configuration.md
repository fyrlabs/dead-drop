# Configuration reference

Every field `deaddrop.config.json` accepts, with its type, default and whether it is required. For a worked example see [operations.md](operations.md); this page is the exhaustive version.

The parser is `parseRuntimeConfig` in `packages/runtime/src/config.ts`. Anything it rejects, it rejects at start-up with a `CONFIG_INVALID` error naming the workspace and field, never silently.

## Where the file is found

In order: `--config <path>`, then `./deaddrop.config.json`, then `~/.deaddrop/config.json`. Client commands such as `ddrop status` run the same discovery as `ddrop start`, so they find the same runtime.

## Rules that apply to every field

**Environment references.** `${env:NAME}` is expanded anywhere in the file, at any depth, in keys' values. An unset variable is a hard error rather than an empty string, so a missing secret fails loudly at start-up instead of producing a runtime that cannot decrypt anything.

**Path resolution.** A leading `~` expands to your home directory. Relative paths resolve against the config file's directory, not the working directory, so a config means the same thing wherever you run it from. Inside a transport's `config` block this applies to the keys `root`, `workDir`, `directory` and `path`.

**Names.** Workspace names, peer ids and exposure names match `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$` and may not contain `..`. Channel names additionally allow `/`, up to 256 characters. The restriction exists because these become path segments in transport object keys.

## Top level

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `workspaces` | array | **yes** | | At least one. Duplicate `name` values are rejected. |
| `dataDir` | string | no | `~/.deaddrop` | Runtime state: control socket, dedupe cache, logs. |
| `logLevel` | string | no | `info` | One of `debug`, `info`, `warn`, `error`, `silent`. |
| `controlSocket` | string | no | `<dataDir>/deaddrop.sock` | Unix socket path. On Windows the control plane uses a named pipe derived from `dataDir` and this field does not apply. |

## Workspace

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `name` | string | **yes** | | Identifies the workspace across all peers. Must match on every machine. |
| `secrets` | string[] | **yes** | | At least one. The first encrypts; the rest still decrypt, which is what makes rotation possible without downtime. Generate with `ddrop keygen`. |
| `transports` | array | **yes** | | At least one. See below. |
| `peerId` | string | no | `DEADDROP_PEER_ID`, else the machine's hostname | This machine's address within the workspace. Set it explicitly if hostnames are not stable: changing a peer id strands messages already addressed to the old one. This field wins over the environment variable, which only supplies the default. |
| `policy` | object | no | score-based | Transport selection. See below. |
| `exposures` | array | no | none | Local applications made reachable to peers. See below. |
| `subscribe` | string[] | no | none | Broadcast channels joined at start-up. |
| `requestTimeoutMs` | number | no | `30000` | Default request timeout for this workspace. Must be positive. |
| `polling` | object | no | | `minIntervalMs` (default `250`) and `maxIntervalMs` (default `15000`). The mailbox backs off between these two while a workspace is idle and drops back to the minimum as soon as it sees traffic. |

## Transports

Each entry selects an adapter and configures it.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `use` | string | **yes** | A built-in short name, a package specifier such as `@my-company/deaddrop-transport-foo`, or a relative path to a local module. |
| `name` | string | no | Instance name, defaulting to the transport's own id. Needed when you configure two instances of the same transport, and when `policy` refers to one by name. |
| `config` | object | no | Passed to the adapter, which validates it. |

Built-in short names: `memory`, `filesystem` (also `fs`), `git`, `github`. All four ship with the CLI.

### `filesystem`

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `root` | string | **yes** | | Directory holding the workspace's objects. Created if missing. |
| `pollIntervalMs` | number | no | `1000` | Poll interval for `watch` where native filesystem events are unavailable. |
| `forcePolling` | boolean | no | `false` | Skip `fs.watch` entirely. Set this on network filesystems, where events are silently unreliable. |

### `git`

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `remote` | string | **yes** | | Anything `git clone` accepts: https, ssh, or a local path. |
| `workDir` | string | **yes** | | Local clone directory. Created if missing. |
| `branch` | string | no | `deaddrop-data` | Orphan branch holding the objects. Your default branch is never touched. |
| `prefix` | string | no | none | Subdirectory inside the branch, so one repository can host several workspaces. |
| `freshnessMs` | number | no | `5000` | How stale a local read may be before a fetch is forced. |
| `batchWindowMs` | number | no | `50` | How long to wait for other writes before committing, so concurrent sends become one commit. |
| `pushRetries` | number | no | `5` | Attempts to resolve a push race before giving up. |
| `authorName`, `authorEmail` | string | no | git's own config | Identity on the generated commits. |
| `gitPath` | string | no | `git` | Path to the git binary. |
| `timeoutMs` | number | no | `120000` | Per-git-command timeout. |

### `github`

A thin layer over `git`: it resolves the clone url through `gh`, then delegates. It forwards `branch`, `prefix`, `gitPath`, `timeoutMs`, `batchWindowMs` and `freshnessMs` to the git transport, and takes these of its own:

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `repo` | string | **yes** | | `owner/name`. |
| `workDir` | string | **yes** | | Local clone directory. |
| `createIfMissing` | boolean | no | `false` | Create the repository when it does not exist. Leave it off on peers that should never create anything, so a typo fails loudly. |
| `private` | boolean | no | `true` | Visibility used when creating. |
| `rateLimitIntervalMs` | number | no | `60000` | How often the API rate limit is re-read. The transport reports `degraded` below 10% headroom, which the transport manager uses when scoring. |
| `ghPath` | string | no | `gh` | Path to the `gh` binary. |

Authentication is whatever `gh` already has. dead-drop never sees a token.

The git transport's `pushRetries`, `authorName` and `authorEmail` are **not** forwarded, so a `github` transport uses their defaults. Use the `git` transport directly if you need them.

### `memory`

In-process, for tests and examples. `namespace` (default `default`) decides which instances see each other. `latencyMs`, `failureRate`, `random` and `status` exist to drive failure paths in tests.

## Policy

Controls which transport carries a message when a workspace has more than one.

| Field | Type | Notes |
| --- | --- | --- |
| `mode` | string | `failover`, `parallel` or `score`. Anything else is rejected. |
| `primary` | string | Transport instance name to prefer. |
| `fallback` | string[] | Instance names to try, in order, when the primary is unavailable. |

Names here are transport `name` values, defaulting to the adapter's own id.

## Exposures

An exposure makes a local application reachable to peers. Peers reach it with `ddrop connect <peer>/<name>`.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `name` | string | **yes** | | Name peers use. |
| `type` | string | **yes** | | `http` or `static`. |
| `target` | string | for `http` | | Absolute `http:` or `https:` url, e.g. `http://localhost:3000`. Other schemes are rejected. |
| `directory` | string | for `static` | | Directory to serve. Paths are clamped inside it, so no request can escape the root. |
| `allowPeers` | string[] | no | every workspace member | Peers allowed to call this exposure. |
| `timeoutMs` | number | no | `30000` | Per-request timeout. Must be positive. |

Static exposures serve `GET` and `HEAD` only, fall back to `index.html` for a directory, and refuse files larger than 32 MiB.

## Two gaps worth knowing

`polling` and `policy` are checked for shape but their inner fields are not type-checked: `polling.minIntervalMs` is accepted as a string, and `policy.primary` is accepted as a number. Both would fail later rather than at start-up, which is not the standard the rest of this parser holds itself to. Neither is exploitable, and both are on the list to fix.

## Environment variables

| Variable | Effect |
| --- | --- |
| `DEADDROP_PEER_ID` | Overrides this machine's peer id. |
| `DEADDROP_SECRET` | Nothing on its own. It is the name `ddrop init` writes into the generated config as `${env:DEADDROP_SECRET}`, so the secret stays out of the file. |

Any variable can be referenced from the config with `${env:NAME}`; those two are the only ones the runtime reads by name.
