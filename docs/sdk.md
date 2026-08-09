# Using dead-drop from code

Proxy mode needs none of this. `ddrop connect` gives you an ordinary local URL and your application talks to it like any other HTTP endpoint. This page is for applications that want dead-drop-native interactions instead: request/response over a channel, or broadcast to everyone in the workspace.

## The client

The client talks to a runtime that is already running, over its control socket.

```ts
import { createClient } from '@fyrlabs/dead-drop/sdk';

// dataDir must match the running runtime's; it defaults to ~/.deaddrop.
const ddrop = createClient({ workspace: 'demo', dataDir: '.deaddrop' });

await ddrop.publish('events/orders', { type: 'order.created', id: 42 });
const sum = await ddrop.call('machine-a', 'math.add', { a: 10, b: 20 });
```

`call` waits for a reply and takes a timeout; `publish` is fire-and-forget to every subscriber. Delivery is at-least-once, so a handler that is not idempotent will eventually run twice. See [guarantees.md](guarantees.md).

`ddrop.queues()` answers what is still waiting, per peer, without decrypting or consuming anything. It backs the `ddrop queues` command and is described in [operations.md](operations.md#queued-depth); check `read` before trusting an empty `queues` array.

## Serving

From an embedded runtime, a service is a plain object of functions:

```ts
workspace.service('math', {
  add: ({ a, b }) => a + b,
});
```

Each key becomes a channel under the service name, so the example above answers `math.add`.

Authorise on `context.identity`, never on `context.from`. `from` is the address a reply goes back to, which for a `ddrop connect` client is a per-process value that appears in no config file; `identity` is the caller's configured `peerId`. Use `senderIdentity(envelope)` when you are working with envelopes directly.

## Embedding the runtime

`@fyrlabs/dead-drop/runtime` exports `DeadDropRuntime`, which is what the CLI drives. Build it from the same `RuntimeConfig` the config file parses to, so a container image, a test and the CLI all produce the same runtime.

## Entry points

dead-drop ships as two packages. Everything the runtime needs is in one; the transport contract is separate so a third-party adapter does not depend on the whole runtime.

| Import | Purpose |
| --- | --- |
| `@fyrlabs/dead-drop` | The `ddrop` command, and the client at the root import. |
| `@fyrlabs/dead-drop/sdk` | Application client over the control socket. |
| `@fyrlabs/dead-drop/runtime` | Embed the runtime in your own process. |
| `@fyrlabs/dead-drop/core` | Transport manager, reliability, mailbox engine, observability. |
| `@fyrlabs/dead-drop/protocol` | Envelope, framing, encryption, chunking. |
| `@fyrlabs/dead-drop/transports/<name>` | `filesystem`, `git`, `github`, `memory`. |
| `@fyrlabs/dead-drop/cli` | Run a command programmatically. |
| `@fyrlabs/dead-drop-transport-sdk` | `defineTransport` and the conformance suite. The only package a transport author needs. |
