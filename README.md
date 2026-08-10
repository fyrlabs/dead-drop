# dead-drop

**Build the application. Bring the transport. dead-drop connects them.**

Two machines talk to each other through infrastructure they already share: a git repository, a synced folder, object storage. Neither one listens on a public port, so this works from behind NAT, from a CI runner, or from a locked-down corporate network.

```mermaid
flowchart LR
    subgraph A ["Machine A, behind NAT"]
        app["your app on :3000"]
        ra["dead-drop"]
        app --- ra
    end

    store[("a git repo,<br/>a folder, S3")]

    subgraph B ["Machine B, elsewhere"]
        rb["dead-drop"]
        port["localhost:8080"]
        rb --- port
    end

    ra -- "encrypted objects" --> store
    store -- "polled, decrypted" --> rb
    rb -. "the reply goes back the same way" .-> store
```

## Install

Requires Node.js 20.11 or newer.

```bash
npm install -g @fyrlabs/dead-drop
```

## Try it on one machine

Two peers and a folder between them. Nothing to edit, nothing to export.

```bash
mkdir -p try/a try/b try/shared try/site
echo '<h1>it works</h1>' > try/site/index.html

(cd try/a && ddrop init --name demo --peer peer-a --root ../shared)
(cd try/b && ddrop init --name demo --peer peer-b --root ../shared \
               --secret - < ../a/.deaddrop/secret)
```

The second command **joins** the first peer's workspace: `--secret -` reads the secret from stdin, so both peers share one and nothing has to be copied into place afterwards.

`ddrop start` runs in the foreground, so give each peer its own shell, or background them:

```bash
(cd try/a && exec ddrop start) &
(cd try/b && exec ddrop start) &

(cd try/a && ddrop expose ../site --name site)
(cd try/b && ddrop discover)                       # peer-a shows up here
(cd try/b && exec ddrop connect peer-a/site --port 8080) &

curl http://127.0.0.1:8080/index.html              # <h1>it works</h1>
```

The `exec` matters: without it you background a shell that starts the runtime and exits, so `kill` reaps the wrapper and leaves the runtime serving.

Look in `try/shared` while it runs. The object keys name the workspace and the peers on purpose, so an operator can understand what is there; every file is ciphertext.

Stop everything with `kill %1 %2 %3`, and delete `try/` when you are done.

## Two real machines

The same thing, with the folder replaced by something both machines can reach. One command each.

```bash
# machine A: starts the workspace, prints the secret's location
ddrop init --name demo --peer machine-a --root ~/Dropbox/deaddrop

# machine B: joins it, pasting the secret from machine A
ddrop init --name demo --peer machine-b --root ~/Dropbox/deaddrop --secret -
```

`--secret -` reads from stdin, so paste the contents of machine A's `.deaddrop/secret` and press Ctrl-D. Send it over a channel you trust: holding that secret *is* membership in the workspace. A secret typed as `--secret ddk1_...` also works, and the command warns you, because an argument is visible in shell history and in the process list.

To expose a real local server rather than a directory:

```bash
ddrop expose --target http://localhost:3000 --name my-api   # machine A
ddrop connect machine-a/my-api                              # machine B
```

`ddrop connect` prints an ordinary local URL. curl it, open it in a browser, or point a client library at it; nothing on that side knows any of the above happened.

### Over a git repository instead

Data moves by pushing and pulling a dedicated branch. Authentication is whatever `gh` already has, and dead-drop never sees a token.

```bash
gh auth login && gh auth setup-git

# machine A
ddrop init --name demo --peer machine-a --github your-org/deaddrop-workspace

# machine B
ddrop init --name demo --peer machine-b --github your-org/deaddrop-workspace --secret -
```

The repository is created for you if it does not exist, private by default. Objects go to a `deaddrop-data` orphan branch, so the repository's real history is untouched. Deleting that branch discards undelivered messages and nothing else.

### More than one transport

A workspace can list several, and the runtime chooses between them. Your application never names one.

```json
"transports": [
  { "use": "filesystem", "name": "office-nas",
    "config": { "root": "/Volumes/share/deaddrop", "forcePolling": true } },
  { "use": "github", "name": "remote",
    "config": { "repo": "your-org/deaddrop-workspace", "workDir": "~/.deaddrop/clones/demo" } }
],
"policy": { "mode": "failover", "primary": "office-nas", "fallback": ["remote"] }
```

On the LAN the shared folder carries everything. Unmount it and the runtime works out that it is gone, moves the traffic to GitHub, and moves it back when the folder returns. No restart, no config change, and the caller sees a slow request rather than an error.

Give every peer the same list. Writes go to one transport, but every peer polls all of the ones it has, so a message written over a transport somebody else has not configured is a message that peer never receives. [Transport policy](docs/configuration.md#policy) has the modes and the trade-offs.

## What this is, and what it is not

Useful when two machines need to talk and the network between them is the problem. It is a real runtime: encryption, retries, failover, deduplication, health-based routing, observability.

It is **not** a message broker and will not pretend to be one. A round trip over a git remote costs seconds, not milliseconds. If you have Kafka, use Kafka.

Delivery is **at-least-once** and ordering is best-effort per recipient, stated plainly in [docs/guarantees.md](docs/guarantees.md) rather than buried.

## Security

One 32-byte secret per workspace. Holding it *is* membership. Every frame is AES-256-GCM ciphertext, envelope header included, so a channel name or a payload never appears in clear text.

**Object keys are the deliberate exception.** They read `ws/<workspace>/inbox/<peer>/<id>.ddf`, so anyone who can read the transport can see workspace names, peer names and roughly how much traffic there is. That is a design choice: an operator looking at a git repository should be able to tell what it holds. Message sizes and timing are visible for the same reason.

Read [docs/security-model.md](docs/security-model.md) before deciding this fits your threat model.

## Commands

```text
ddrop init [--root <folder>]        write a config, and a secret beside it
           [--github <owner>/<repo>]  use a GitHub repo instead of a folder
           [--secret -]               join an existing workspace, secret on stdin
ddrop start                         run the runtime
ddrop status                        runtime, workspaces, transports
ddrop discover                      peers visible in the workspace
ddrop queues                        messages waiting in each peer's inbox
ddrop dashboard [--no-open]         the same, in a browser on 127.0.0.1
ddrop expose --target <url> --name <n>
ddrop expose <dir> --name <n>
ddrop connect <peer>/<exposure>
ddrop call <peer> <channel> --input '{"a":1}'
ddrop publish <channel> --input '{...}'
ddrop list | logs | metrics
ddrop transport list | health       transport scores and health
ddrop trace [<traceId>]             recent traces, or one as a span tree
ddrop keygen                        a new workspace secret, for rotation
```

`--json` makes the output machine-readable, including errors. Client commands find the runtime through the config they discover, so run them from the directory holding `deaddrop.config.json`, or pass `--config` or `--socket`.

## Documentation

- [Configuration reference](docs/configuration.md): every field, its type and its default
- [Using it from code](docs/sdk.md): the client, services, and the package entry points
- [Architecture](docs/architecture.md): how the pieces fit and why
- [Security model](docs/security-model.md): threat model, key rotation, what is exposed
- [Delivery guarantees](docs/guarantees.md): at-least-once, ordering, duplicates
- [Writing a transport](docs/writing-a-transport.md): four methods, and a conformance suite to run against them
- [Operations](docs/operations.md): running it, metrics, troubleshooting
- [Vision](docs/vision.md): where this is going, and what it refuses to become
- [Testing](docs/testing.md): what is covered automatically, and what still needs a human
- [Decision records](docs/adr/): choices that deviate from the original design, and why

## Development

```bash
npm install
npm run verify      # lint, build, test with coverage
```

The git transport tests need a `git` binary. Everything else runs with no network and no credentials. Contributor guidance is in [CONTRIBUTING.md](CONTRIBUTING.md); [AGENTS.md](AGENTS.md) is the same ground for coding agents.

## Licence

Apache-2.0.
