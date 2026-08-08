# Writing a transport

A Bridge transport is an ordinary npm package. You do not fork Bridge, you do not send a pull request here, and you do not need anything merged. Publish it, `npm install` it, name it in a config file.

## The short version

Most backends are object stores: put bytes at a key, get them back, list a prefix, delete. That is the whole contract.

```ts
import { defineTransport } from '@dead-drop/transport-sdk';

export interface AcmeConfig {
  endpoint: string;
  bucket: string;
}

export const acmeTransport = defineTransport<AcmeConfig>({
  id: 'acme',

  capabilities: {
    kind: 'store',
    ordering: 'partition',    // per-recipient ordering from sorted keys
    binaryPayloads: true,     // bytes survive a round trip unchanged
    delete: true,             // required for store transports
    watch: false,             // no push notifications
    orderedList: true,        // list returns keys in lexicographic order
    maxPayloadBytes: 5 * 1024 * 1024,
  },

  parseConfig(raw) {
    // Throw BridgeError('CONFIG_INVALID', …) on anything you cannot use.
    // This runs at start-up, so a typo fails immediately rather than at 3am.
    return raw as AcmeConfig;
  },

  create(config, context) {
    return new AcmeStore(config, context);
  },
});
```

Bridge supplies everything above the store: framing, encryption, chunking for your `maxPayloadBytes`, acknowledgement, retries with jitter, deduplication, dead-lettering, health-based routing, failover, metrics and tracing. You supply four methods.

## The contract

```ts
interface StoreTransport {
  kind: 'store';
  put(key, data, options?): Promise<{ key: string; etag?: string }>;
  get(key, options?): Promise<Uint8Array | undefined>;
  list(prefix, options?): Promise<{ entries: ObjectEntry[]; cursor?: string }>;
  delete(key, options?): Promise<void>;
  watch?(prefix, onChange): Promise<() => Promise<void>>;
  health(): Promise<TransportHealth>;
  close(): Promise<void>;
}
```

Rules that are not negotiable, because the mailbox engine relies on them:

- **`get` on a missing key resolves `undefined`.** It never throws for absence. Absence is normal: another consumer may have deleted the object between the list and the get.
- **`delete` is idempotent.** Deleting a key that does not exist succeeds.
- **`put` is durable when it resolves.** If your backend batches, resolve after the batch lands, not when it is queued.
- **`list` matches on path boundaries**, not raw string prefixes. `inbox/peer-a` must not return `inbox/peer-abc/…`.
- **`put` with `ifAbsent` fails if the key exists**, atomically. Use your backend's create-or-fail primitive; a check-then-write race defeats the purpose.
- **Keys are validated for you.** Call `assertValidKey` / `assertValidPrefix` from the SDK before you interpolate a key into a path or URL. The conformance suite checks that you do.
- **Concurrency is expected.** Two calls can be in flight at once.

`startAfter` in `ListOptions` is worth implementing properly: subscribers use it to ask "what is new since this key", which on a remote backend is the difference between one cheap call and one that grows with retention.

## Health

```ts
async health(): Promise<TransportHealth> {
  const started = Date.now();
  try {
    await this.probe();            // a real operation, not a no-op
    return { status: 'healthy', latencyMs: Date.now() - started };
  } catch (error) {
    return { status: 'unavailable', message: String(error) };
  }
}
```

Report `degraded` for "working but you should prefer something else" — high latency, a nearly exhausted rate limit. The transport manager scores on health, recent reliability, latency and rate-limit headroom, so an honest `degraded` is what makes failover work.

Probe something that would actually fail. A `stat` on a disconnected network mount often succeeds; a write does not.

## Errors

Throw `BridgeError` from `@dead-drop/protocol`. The code decides what happens next:

| Code | Effect |
| --- | --- |
| `TRANSPORT_ERROR` | Retried, then failed over. Set `retryable: false` for permanent failures. |
| `RATE_LIMITED` | Retried; set `retryAfterMs` and Bridge waits exactly that long instead of guessing. |
| `TIMEOUT` | Retried, then failed over. |
| `UNAUTHORIZED`, `BAD_REQUEST`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED` | Not failed over: they fail the same way on every backend. |
| `CANCELLED` | Not retried, not counted against the circuit breaker. |

## Run the conformance suite

This is the part people skip and should not. The suite is framework-agnostic — it returns plain `{ name, run }` cases — so it works with vitest, `node:test`, jest or a bare script, and it does not pull a test runner into your dependency tree.

```ts
import { describe, it } from 'vitest';
import { registerConformanceTests } from '@dead-drop/transport-sdk/testing';
import { acmeTransport } from './index.js';

registerConformanceTests({ describe, it }, 'acme', {
  capabilities: acmeTransport.definition.capabilities,
  async create() {
    return acmeTransport.definition.create({ /* pointed at a fresh namespace */ }, testContext());
  },
  async cleanup(transport) { /* drop the namespace */ },
  // Non-zero only if your backend is eventually consistent.
  settleMs: 0,
});
```

The suite adapts to what you declare: claiming `orderedList` adds an ordering test, `watch` adds a notification test, `binaryPayloads` adds an all-256-byte-values test. Declaring a capability you do not have will fail.

## Native transports

If your backend already has delivery semantics — AMQP, MQTT, a websocket relay — use `kind: 'native'` and implement `send`/`subscribe` instead. Bridge stays out of the way and does not synthesise acknowledgements.

Most people do not want this. If your backend is storage, `store` is both less work and more correct.

## Publishing

Name it `<scope>/bridge-transport-<name>` by convention. Users reference it by package specifier:

```json
{ "use": "@acme/bridge-transport-foo", "config": { "endpoint": "…" } }
```

Local paths work too, which is the fastest way to develop one:

```json
{ "use": "./my-transport/index.js", "config": {} }
```

## Checklist before you publish

- [ ] Conformance suite passes.
- [ ] `parseConfig` rejects bad configuration with a message that says how to fix it.
- [ ] Credentials come from the environment or a credential helper, never from committed config.
- [ ] Nothing secret reaches a log or an error message; strip inline credentials from urls.
- [ ] `close()` releases connections, timers and file handles, and is safe to call twice.
- [ ] `maxPayloadBytes` reflects the real limit, so chunking is sized correctly.
- [ ] `health()` probes something that can genuinely fail.
