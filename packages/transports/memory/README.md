# @fyrlabs/dead-drop-transport-memory

An in-process dead-drop transport backed by a `Map`. For tests, examples and local development, where you want two runtimes talking without touching a disk or a network.

Instances sharing a `namespace` see the same objects, which is what lets two runtimes in one process reach each other.

Ships with [@fyrlabs/dead-drop](https://www.npmjs.com/package/@fyrlabs/dead-drop); install it separately only when embedding the runtime yourself.

## Install

```bash
npm install @fyrlabs/dead-drop-transport-memory
```

Requires Node.js 20.11 or newer.

## Configure

```json
{
  "use": "memory",
  "config": { "namespace": "tests" }
}
```

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `namespace` | string | `default` | Instances sharing it see the same objects. |
| `latencyMs` | number | none | Delay injected per operation. |
| `failureRate` | number | none | Fails operations with probability 0 to 1. |
| `random` | function | `Math.random` | Supply one to make `failureRate` deterministic. |
| `status` | string | `healthy` | What `health()` reports: `healthy`, `degraded` or `unavailable`. |

The last four exist to drive failure paths on purpose. `failureRate` with a seeded `random`, or a pinned `status`, lets you assert that retry, circuit breaking and failover behave without waiting for a real backend to misbehave.

Nothing survives the process. This transport is not for production.

## Documentation

Part of [dead-drop](https://github.com/fyrlabs/dead-drop), a transport-agnostic runtime for distributed applications.

- [Configuration reference](https://github.com/fyrlabs/dead-drop/blob/main/docs/configuration.md)

## Licence

Apache-2.0.
