# @fyrlabs/dead-drop-core

The policy layer: transport selection and scoring, retry with jitter, circuit breaking, failover, the mailbox engine that turns an object store into at-least-once messaging, and observability (structured logs with credential redaction, Prometheus metrics, tracing).

Part of [dead-drop](https://github.com/fyrlabs/dead-drop) — a transport-agnostic runtime for distributed applications. See the repository README for the full picture, and `docs/` for the architecture, security model and delivery guarantees.

## Install

```bash
npm install @fyrlabs/dead-drop-core
```

Requires Node.js 20.11 or newer.

## Licence

Apache-2.0.
