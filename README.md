# Bridge

**Build the application. Bring the transport. Bridge connects them.**

Bridge is a local-first runtime that lets applications on different machines talk to each other through infrastructure you already have: a git repository, a shared or synced folder, object storage, or an adapter you write yourself. There is nothing to deploy, no public endpoint, no broker, and the application does not need to know how its bytes move.

```bash
# machine A — an ordinary Express app on :3000, unmodified
bridge expose --target http://localhost:3000 --name my-api

# machine B
bridge connect machine-a/my-api
# http://127.0.0.1:53219  →  curl it, open it in a browser, point a client at it
```

## What this is, and what it is not

Bridge is genuinely useful when you want two machines to talk and the network between them is the problem: a laptop behind NAT, a locked-down corporate environment, a CI runner, an air-gapped review box that can still reach a git remote. It is a real runtime with encryption, retries, failover, deduplication, health-based routing and observability.

It is **not** a message broker, and it will not pretend to be one. A round trip over a git remote costs seconds, not milliseconds. If you have Kafka, use Kafka. Bridge is for the case where standing up infrastructure is the expensive part.

Delivery is **at-least-once**. Ordering is best-effort per recipient. Both are stated plainly in [docs/guarantees.md](docs/guarantees.md) rather than buried.

## Install

Requires Node.js 20.11 or newer.

```bash
npm install -g @dead-drop/cli
```

## Quick start: two machines, a shared folder

```bash
# Once, on either machine:
bridge keygen                      # prints ddk1_… — share it with the other peer, securely
export BRIDGE_SECRET='ddk1_…'
bridge init --name demo            # writes bridge.config.json
```

`bridge.config.json`:

```json
{
  "dataDir": ".bridge",
  "workspaces": [
    {
      "name": "demo",
      "peerId": "machine-a",
      "secrets": ["${env:BRIDGE_SECRET}"],
      "transports": [{ "use": "filesystem", "config": { "root": "/Volumes/shared/bridge" } }],
      "exposures": [{ "name": "my-api", "type": "http", "target": "http://localhost:3000" }]
    }
  ]
}
```

```bash
bridge start          # machine A
bridge start          # machine B, same secret, peerId "machine-b", no exposures
bridge discover       # machine B sees machine-a and its exposures
bridge connect machine-a/my-api
```

## Quick start: over GitHub

Data moves by pushing and pulling a dedicated branch. Authentication is whatever `gh` already has; Bridge never sees a token.

```bash
gh auth login && gh auth setup-git
```

```json
{
  "use": "github",
  "config": {
    "repo": "your-org/bridge-workspace",
    "workDir": "./.bridge/github",
    "createIfMissing": true
  }
}
```

Bridge writes to a `bridge-data` orphan branch, so your repository's real history is untouched. Deleting that branch discards undelivered messages and nothing else.

## Native SDK

For applications that want Bridge-native interactions rather than HTTP proxying:

```ts
import { createClient } from '@dead-drop/sdk';

const bridge = createClient({ workspace: 'demo' });

await bridge.publish('events/orders', { type: 'order.created', id: 42 });
const sum = await bridge.call('machine-a', 'math.add', { a: 10, b: 20 });
```

And on the serving side, from an embedded runtime:

```ts
workspace.service('math', {
  add: ({ a, b }) => a + b,
});
```

The SDK is optional. Proxy mode needs none of it.

## Writing a transport

A transport is an ordinary npm package. Nothing in this repository changes, and nothing needs to be merged.

```ts
import { defineTransport } from '@dead-drop/transport-sdk';

export const acmeTransport = defineTransport({
  id: 'acme',
  capabilities: {
    kind: 'store',
    ordering: 'partition',
    binaryPayloads: true,
    delete: true,
    watch: false,
    orderedList: true,
  },
  create(config, context) {
    return {
      kind: 'store',
      async put(key, data) { /* … */ },
      async get(key) { /* … */ },
      async list(prefix, options) { /* … */ },
      async delete(key) { /* … */ },
      async health() { return { status: 'healthy' }; },
      async close() {},
    };
  },
});
```

Four methods. Bridge supplies framing, encryption, chunking, acknowledgement, retries, deduplication, dead-lettering and adaptive polling on top. Run the conformance suite against your adapter before publishing it — see [docs/writing-a-transport.md](docs/writing-a-transport.md).

## Commands

```text
bridge start                         run the runtime
bridge status                        runtime, workspaces, transports
bridge discover                      peers visible in the workspace
bridge transport list | health       transport scores and health
bridge expose --target <url> --name <n>
bridge expose <dir> --name <n>
bridge connect <peer>/<exposure>
bridge call <peer> <channel> --input '{"a":1}'
bridge publish <channel> --input '{...}'
bridge logs | metrics
bridge keygen | init
```

Everything takes `--json` for scripting.

## Packages

| Package | Purpose |
| --- | --- |
| `@dead-drop/protocol` | Envelope, framing, encryption, chunking. No dependencies. |
| `@dead-drop/transport-sdk` | `defineTransport` and the conformance suite. |
| `@dead-drop/core` | Transport manager, reliability, mailbox engine, observability. |
| `@dead-drop/runtime` | Workspaces, exposures, discovery, control plane. |
| `@dead-drop/sdk` | Application client. |
| `@dead-drop/cli` | The `bridge` command. |
| `@dead-drop/transport-filesystem` | Reference transport: any directory. |
| `@dead-drop/transport-git` | Any git remote. |
| `@dead-drop/transport-github` | GitHub, via `gh` for auth and repo management. |
| `@dead-drop/transport-memory` | In-process, for tests and examples. |

## Security

One 32-byte secret per workspace. Holding it *is* membership. Everything on a transport is AES-256-GCM ciphertext including the envelope header, so channel, peer and workspace names never appear in clear text. The transport is treated as hostile storage.

What is *not* protected: message sizes, timing, and the object keys the mailbox writes. Read [docs/security-model.md](docs/security-model.md) before deciding this fits your threat model.

## Documentation

- [Architecture](docs/architecture.md) — how the pieces fit and why
- [Security model](docs/security-model.md) — threat model, key rotation, what is exposed
- [Delivery guarantees](docs/guarantees.md) — at-least-once, ordering, duplicates
- [Writing a transport](docs/writing-a-transport.md)
- [Operations](docs/operations.md) — configuration, metrics, troubleshooting
- [Testing](docs/testing.md) — what is covered automatically and what needs a human
- [Decision records](docs/adr/) — the choices that deviate from the original design sketch

## Development

```bash
npm install
npm run verify      # lint, build, test with coverage
npm test            # tests only
```

The git transport tests require a `git` binary. Everything else runs with no external dependencies, no network and no credentials.

## Licence

Apache-2.0.
