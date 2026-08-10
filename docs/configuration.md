# Configuration reference

Every field `deaddrop.config.json` accepts, with its type, default and whether it is required. For a worked example see [operations.md](operations.md); this page is the exhaustive version.

The parser is `parseRuntimeConfig` in `packages/runtime/src/config.ts`. Anything it rejects, it rejects at start-up with a `CONFIG_INVALID` error naming the workspace and field, never silently.

## Where the file is found

In order: `--config <path>`, then `./deaddrop.config.json`, then `~/.deaddrop/config.json`. Client commands such as `ddrop status` run the same discovery as `ddrop start`, so they find the same runtime.

## Rules that apply to every field

**References.** `${env:NAME}` and `${file:PATH}` are expanded anywhere in the file, at any depth, in values. An unset variable or an unreadable file is a hard error rather than an empty string, so a missing secret fails loudly at start-up instead of producing a runtime that cannot decrypt anything.

`${file:PATH}` reads the file and strips surrounding whitespace, because a secret written by an editor or a shell redirect carries a trailing newline and a key with a newline on the end is not the key. `PATH` follows the same rules as any other path below: a leading `~` is your home directory, and a relative path resolves against the config file's directory. This is what `ddrop init` writes, so the config can be committed and copied between machines while the secret stays beside it.

Both are expanded in a single pass, so whatever a reference expands to is data. A secret file whose contents happen to read `${env:...}`, or a variable holding `${file:...}`, is never followed as a second lookup.

**Starting or joining.** `ddrop init` generates a new workspace secret. `ddrop init --secret <value|->` uses one you already have, which is how a second machine joins an existing workspace rather than founding a one-peer workspace of its own; `-` reads stdin so the secret stays out of shell history. `--github <owner>/<repo>` writes a GitHub transport block instead of a filesystem one, so neither transport needs the config hand-edited afterwards. `--root` and `--github` name two different transports and cannot be combined.

**Placeholders.** `ddrop init` writes `REPLACE-ME` where it cannot choose for you. Any value still containing that text fails at load with the field named. It is deliberately not a default: the shared location is the one thing no default can guess, and the old behaviour -- a path under the local data directory -- let two machines each start cleanly, write into their own folder, and never see each other.

**Path resolution.** A leading `~` expands to your home directory. Relative paths resolve against the config file's directory, not the working directory, so a config means the same thing wherever you run it from. Inside a transport's `config` block this applies to the keys `root`, `workDir`, `directory` and `path`.

**Names.** Workspace names, peer ids and exposure names match `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$` and may not contain `..`. Channel names additionally allow `/`, up to 256 characters. The restriction exists because these become path segments in transport object keys.

## Top level

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `workspaces` | array | **yes** | | At least one. Duplicate `name` values are rejected. |
| `dataDir` | string | no | `~/.deaddrop` | Runtime state: control socket, dedupe cache, logs. |
| `logLevel` | string | no | `info` | One of `debug`, `info`, `warn`, `error`, `silent`. |
| `controlSocket` | string | no | `<dataDir>/deaddrop.sock` | Unix socket path. On Windows the control plane uses a named pipe derived from `dataDir` and this field does not apply. |

A Unix socket path cannot exceed 104 bytes. When `<dataDir>/deaddrop.sock` would be longer, the runtime instead uses a short path under the system temp directory, derived from a hash of `dataDir`. This is automatic, and the CLI and SDK resolve the same path, so nothing needs configuring. Setting `controlSocket` explicitly opts out of the fallback: if the path you give is too long, startup fails.

## Workspace

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `name` | string | **yes** | | Identifies the workspace across all peers. Must match on every machine. |
| `secrets` | string[] | **yes** | | At least one. The first encrypts; the rest still decrypt, which is what makes rotation possible without downtime. Generate with `ddrop keygen`. |
| `transports` | array | **yes** | | At least one. See below. |
| `peerId` | string | no | `DEADDROP_PEER_ID`, else the machine's hostname (`ddrop init` writes it explicitly) | This machine's address within the workspace. Set it explicitly if hostnames are not stable: changing a peer id strands messages already addressed to the old one. This field wins over the environment variable, which only supplies the default. |
| `policy` | object | no | score-based | Transport selection. See below. |
| `exposures` | array | no | none | Local applications made reachable to peers. See below. |
| `subscribe` | string[] | no | none | Broadcast channels joined at start-up. |
| `requestTimeoutMs` | number | no | `30000` | Default request timeout for this workspace. Must be positive. |
| `polling` | object | no | | `minIntervalMs` (default `250`) and `maxIntervalMs` (default `15000`). The mailbox backs off between these two while a workspace is idle and drops back to the minimum as soon as it sees traffic. |
| `retry` | object | no | see below | How a failed transport operation is retried. |
| `breaker` | object | no | see below | When a failing transport is taken out of rotation, and when it is probed again. |
| `healthIntervalMs` | number | no | `30000` | How often every transport is probed for health. Must be positive. See below. |
| `presenceIntervalMs` | number | no | `30000` | How often this peer republishes its presence beacon. Must be positive. See below. |
| `inboxOrphanMs` | number | no | `604800000` | How long mail for an absent peer survives before any peer may delete it. `0` turns reaping off. See below. |
| `concurrency` | number | no | `1` | How many inbound messages this workspace handles at once. Must be a whole number of at least 1. See below. |

### `retry`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `maxAttempts` | number | `5` | Total attempts including the first. `1` disables retrying. |
| `initialDelayMs` | number | `200` | Delay before the second attempt. |
| `maxDelayMs` | number | `30000` | Ceiling on any single delay. |
| `factor` | number | `2` | Multiplier applied to the delay between attempts. |
| `jitter` | string | `full` | One of `none`, `full`, `equal`. Randomises the delay so retries from many peers do not land together. |
| `maxElapsedMs` | number | none | Never sleep longer than this in total across all attempts. |

**Raising `maxAttempts` on its own usually buys nothing, and this is the part worth reading twice.** Since 0.3.0 the request timeout bounds the *whole* request, the send included. Extra attempts are therefore cut off by the deadline rather than run: a caller with the default 30s timeout does not get more retries by asking for 10 attempts, it just fails at the same 30s with more of the ladder unused. Raise `requestTimeoutMs` in step, or the knob is decoration.

Every field is checked at start-up. A misspelling or a non-number fails with the field named, rather than falling back to the default, because a knob that silently does nothing is worse than no knob.

### `breaker`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `failureThreshold` | number | `5` | Consecutive failures that take the transport out of rotation. |
| `resetTimeoutMs` | number | `30000` | How long it stays out before one probe is allowed through. |
| `successThreshold` | number | `2` | Consecutive successes on probes needed to return it to service. |

Lower `resetTimeoutMs` when you want failover to recover quickly in a test; the defaults are tuned for a real remote that is briefly unwell rather than gone.

### `healthIntervalMs`

A transport's reported status changes on a health sweep, not at the moment it fails. So this is what decides how quickly `ddrop transport health` and the failover scores notice a transport has died, and at the default of 30 seconds a dead transport can look healthy for most of a minute.

Lower it when a probe is nearly free and detection speed matters, which is the case for `filesystem` and for a local `git` remote. Raise it when a probe costs something real: the `github` transport spends an API call on every sweep, and a workspace with several github transports polling every few seconds is spending its rate limit on health rather than on messages. Failover itself does not wait for a sweep -- the circuit breaker reacts to real failures as they happen -- so a longer interval costs you reporting lag, not availability.

### `presenceIntervalMs`

Every peer writes one small object per interval saying it is alive, what services it answers and what exposures it offers. A peer is treated as gone once its beacon is three intervals old, so at the default of 30 seconds `ddrop discover` can be up to 90 seconds behind reality in both directions: a peer that just started may not be listed, and one that just left may still be.

Lower it where a write is cheap and discovery should feel immediate, which is the case for `filesystem`. Leave it alone, or raise it, on `git` and `github`, where every beacon is a commit and a push: the cost is one object per peer per interval, forever, and it is also history that never goes away on the git transports.

### `inboxOrphanMs`

Only the peer a message is addressed to ever takes it out of its inbox. So when a peer stops coming back, whatever was waiting for it stays waiting forever, and compacting the store does not help: preserving the live tree is the point of compaction, so an abandoned object is carried into every compacted commit intact. This is measurable rather than theoretical. One trial repository compacted from 433 MB down to a single commit still held 60 MB, nearly all of it two abandoned payloads addressed to `ddrop connect` sessions that had exited.

Every `ddrop connect` session takes its own short-lived mailbox address, so that shape of leak is the normal one, not an exotic failure.

Past this window, **any** peer may delete such a message, and it needs two things to be true at once: the message is older than `inboxOrphanMs`, and the peer it is addressed to has published no presence beacon, or one older than the same window. Being merely offline for an afternoon costs nothing, because the beacon is what separates "gone" from "not looking right now". Age comes from the message id in the key, so deciding costs a listing and nothing is downloaded or decrypted.

**A peer offline for longer than this loses its mail.** That is the real cost of the setting, and it is why the default sits far beyond a closed laptop and far below "forever". Raise it if peers in your workspace routinely disappear for weeks. Set it to `0` to turn reaping off completely and go back to a store that only ever grows.

This is not the per-message TTL, and the two are not interchangeable. A message's real TTL lives in its encrypted header, which only its recipient can read, so honouring it from outside would mean decrypting every candidate. `inboxOrphanMs` therefore applies to every message including one that asked for no expiry at all.

Letting any member delete another member's mail grants no privilege that member did not already have: everyone in a workspace holds the same secret and already has unrestricted `delete` on the store. The reasoning is in [ADR 0006](adr/0006-reaping-orphaned-inboxes.md), and the boundary itself in [docs/security-model.md](security-model.md).

Stale presence beacons are reaped on the same schedule but far more aggressively, with no setting of their own. A beacon repairs itself: its owner rewrites it every `presenceIntervalMs`, so deleting one wrongly costs a single interval of that peer being invisible to `ddrop discover`. A message has no such second chance, which is the whole reason for the two horizons.

### `concurrency`

A poll can find several messages waiting. At the default of `1` they are handled one at a time, in the order they were sent, and a handler that takes ten seconds keeps every message behind it waiting. Raising `concurrency` lets that batch run together.

**The trade is ordering, and it is the reason the default is 1.** Concurrent handlers finish in whatever order they finish, so a peer can see two of its requests answered out of the order it sent them. dead-drop has only ever promised best-effort ordering per recipient ([docs/guarantees.md](guarantees.md)), so nothing is broken by this, but a handler written against the serial behaviour can notice the difference. Requests from different peers were never ordered relative to each other in the first place.

Raise it when handlers spend their time waiting -- on a database, an HTTP call, a disk -- which is the usual case. Leave it at 1 when handlers must not interleave, for example when they mutate one shared file. It does not make a single message faster, and a batch now holds up to `concurrency` payloads in memory at once rather than one, so pair a large value with a modest `maxMessageBytes`.

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
| `compactAfterCommits` | number | no | `500` | Commits on the branch that trigger compacting it back to one. `0` never compacts. |
| `authorName`, `authorEmail` | string | no | git's own config | Identity on the generated commits. |
| `gitPath` | string | no | `git` | Path to the git binary. |
| `timeoutMs` | number | no | `120000` | Per-git-command timeout. |

A git working tree has one writer, so only one runtime uses `workDir` itself. The first to start claims it, recording the owner in a `<workDir>.owner` file beside the directory. A second runtime on the same config — which is what `ddrop connect` is, since it builds its runtime from the same file — clones into `<workDir>.peers/<workspace>-<peer>-<transport>/` instead and logs that it did. Clones whose runtime is gone are deleted when the next one starts, so they do not accumulate.

You do not need to configure anything for this, and a single-runtime setup is laid out exactly as it was and never re-clones. Giving each runtime its own `workDir` explicitly is still the tidier arrangement when you are writing the config by hand.

**The data branch is compacted, not grown forever.** Every send, response and delete is its own commit, so the history would otherwise grow without bound while the tree stays the size of the undelivered backlog. Once the branch passes `compactAfterCommits`, whichever peer notices first replaces it with a single commit holding the current tree and force-pushes that, under a compare-and-swap lease so a message written in the same moment cannot be lost. Nothing is dropped: the tree is carried over unchanged, and peers still holding the old history pick the new one up on their next poll with no intervention.

Two consequences worth knowing. The branch's commit log is discarded, so it is not somewhere to look for a record of delivered messages. And if the branch is protected against force-pushes, compaction cannot succeed there: set `compactAfterCommits` to `0` to stop it trying, and expect the history to grow instead.

### `github`

A thin layer over `git`: it resolves the clone url through `gh`, then delegates. It forwards `branch`, `prefix`, `gitPath`, `timeoutMs`, `batchWindowMs`, `freshnessMs` and `compactAfterCommits` to the git transport, and takes these of its own:

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

Only writes are affected. Receiving, discovery and `ddrop queues` read every store transport on every cycle, whatever the policy says. That asymmetry is what makes a second transport worth configuring: a message written over whichever transport was healthy at the time is still found by a peer polling both.

| Field | Type | Notes |
| --- | --- | --- |
| `mode` | string | `failover`, `parallel` or `score`. Anything else is rejected. |
| `primary` | string | Transport instance name to prefer. |
| `fallback` | string[] | Instance names to try, in order, when the primary is unavailable. |

Names here are transport `name` values, defaulting to the adapter's own id. Two entries that resolve to the same name are rejected at start-up, so two instances of one adapter need an explicit `name` each. A `primary` or `fallback` naming a transport that is not configured is a start-up error too, listing the names that are.

### A worked example: a folder on the LAN, with GitHub behind it

```json
{
  "workspaces": [
    {
      "name": "demo",
      "peerId": "machine-a",
      "secrets": ["${file:.deaddrop/secret}"],
      "transports": [
        {
          "use": "filesystem",
          "name": "office-nas",
          "config": { "root": "/Volumes/share/deaddrop", "forcePolling": true }
        },
        {
          "use": "github",
          "name": "remote",
          "config": {
            "repo": "your-org/deaddrop-workspace",
            "workDir": "~/.deaddrop/clones/demo"
          }
        }
      ],
      "policy": { "mode": "failover", "primary": "office-nas", "fallback": ["remote"] }
    }
  ]
}
```

Every machine in the workspace gets both transports and the same policy, with only `peerId` differing. A peer reads only the transports it has configured, so one that is missing `remote` never sees anything sent while the folder was down. `forcePolling` is set here because the folder is a network mount, where `fs.watch` events are silently unreliable.

While the folder is mounted it carries everything: it is first in the declared order, and nothing else is tried. Unmount it, or let the VPN drop, and the first write to notice exhausts its retries on the folder and then moves to `remote` inside the same request, so the caller sees a slow request rather than an error. After `breaker.failureThreshold` consecutive failures the breaker opens and later writes skip the folder immediately instead of paying that retry ladder again. When it returns, one probe through the open breaker succeeds, `breaker.successThreshold` of them closes it, and the primary carries traffic again. No application code named either transport at any point.

**What is already on a transport when it goes down stays there.** A message written to the folder is not copied to GitHub afterwards; it waits until the folder is readable again, and its recipient collects it on the next poll. Nothing is lost, but "sent" does not mean "reachable over the surviving transport". A request is bounded either way, because its TTL is its timeout: one stranded on a transport that dies expires rather than arriving long after the caller gave up.

### Choosing a mode

`score`, the default, picks the healthiest transport for each operation, ranking on health (45%), recent reliability (25%), latency (20%) and rate-limit headroom (10%). An open breaker scores zero, so it is chosen only when nothing else is left. Use it when the transports are interchangeable and you want whichever one is well right now. Among healthy transports latency usually decides, so a local folder beats a git remote nearly always.

`failover` uses the declared order verbatim: `primary`, then each of `fallback` in turn, then any transport the policy does not name, best score first. It ignores the scores among the named ones, and that is the point. An operator who puts a slower or cheaper transport first means it. Use it when the transports are not interchangeable, for example when one of them spends API quota or money.

`parallel` is accepted by the parser but currently behaves exactly like `score`: one transport carries each message. It is named here so the word does not read as a feature. Do not configure it expecting a copy on every transport.

`ddrop transport list` prints the scores and breaker states behind the current choice, which is what to read when that choice surprises you:

```text
office-nas       filesystem     healthy      breaker closed     score 0.94  2ms  errors 0%
remote           github         degraded     breaker closed     score 0.71  240ms  errors 0%
```

## Exposures

An exposure makes a local application reachable to peers. Peers reach it with `ddrop connect <peer>/<name>`.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `name` | string | **yes** | | Name peers use. |
| `type` | string | **yes** | | `http` or `static`. |
| `target` | string | for `http` | | Absolute `http:` or `https:` url, e.g. `http://localhost:3000`. Other schemes are rejected. |
| `directory` | string | for `static` | | Directory to serve. Paths are clamped inside it, so no request can escape the root. |
| `allowPeers` | string[] | no | every workspace member | Peer ids allowed to call this exposure, written exactly as they appear in each caller's `peerId`. |
| `timeoutMs` | number | no | `30000` | Per-request timeout. Must be positive. |

Static exposures serve `GET` and `HEAD` only, fall back to `index.html` for a directory, and refuse files larger than 32 MiB.

`allowPeers` matches the caller's configured `peerId`, not the address its replies go to. Those differ for a `ddrop connect` client: it runs a runtime of its own and takes a per-process mailbox address so it never polls the same inbox as an already-running peer sharing the config file. Write the list against the `peerId` in the caller's config and it matches either way.

It is a guardrail, not a security boundary. Every peer holding the workspace secret can write any peer id it likes, so `allowPeers` keeps honest peers out of an exposure that is not for them. It does not defend against a workspace member who has decided to lie. Use a separate workspace and a separate secret when the boundary has to hold.

## Two gaps worth knowing

`polling` and `policy` are checked for shape but their inner fields are not type-checked: `polling.minIntervalMs` is accepted as a string, and `policy.primary` is accepted as a number. Both would fail later rather than at start-up, which is not the standard the rest of this parser holds itself to. Neither is exploitable, and both are on the list to fix.

## Environment variables

| Variable | Effect |
| --- | --- |
| `DEADDROP_PEER_ID` | Overrides this machine's peer id. |
| `DEADDROP_SECRET` | Nothing on its own. It is a conventional name to reference from the config as `${env:DEADDROP_SECRET}` when you keep the secret in the environment or a secret manager. `ddrop init` writes `${file:.deaddrop/secret}` instead, so a fresh install needs nothing exported. |

Any variable can be referenced from the config with `${env:NAME}`, and any file with `${file:PATH}`; those two variables are the only ones the runtime reads by name.
