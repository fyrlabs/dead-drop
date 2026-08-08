# @fyrlabs/dead-drop-core

The policy layer of dead-drop. Everything that decides *what to do*, as opposed to what a message is or where it goes.

- **Mailbox engine.** Turns a plain object store into at-least-once messaging: delivery, acknowledgement, redelivery, dead letters, retained topics, chunk reassembly and adaptive polling that backs off while idle and snaps back on traffic.
- **Transport manager.** Scores transports on health and latency, retries with jittered backoff, opens a circuit breaker on a failing one, and fails over.
- **Reliability primitives.** Retry, circuit breaker, deduplication, and an injectable `Clock` so all of it is testable without sleeping.
- **Observability.** Structured logging with credential redaction, Prometheus metrics, and tracing where a message id is its own trace id.

This is an internal layer. Install [@fyrlabs/dead-drop](https://www.npmjs.com/package/@fyrlabs/dead-drop) to run dead-drop, or [@fyrlabs/dead-drop-runtime](https://www.npmjs.com/package/@fyrlabs/dead-drop-runtime) to embed it. Reach for this one only if you are building something unusual on the primitives directly.

## Install

```bash
npm install @fyrlabs/dead-drop-core
```

Requires Node.js 20.11 or newer.

## Delivery, stated plainly

At-least-once, with ordering best-effort per recipient. Duplicates are suppressed by a persisted deduplication cache rather than prevented, so a handler that runs twice must be safe to run twice. The [guarantees](https://github.com/fyrlabs/dead-drop/blob/main/docs/guarantees.md) document says what is not guaranteed as clearly as what is.

## Documentation

Part of [dead-drop](https://github.com/fyrlabs/dead-drop), a transport-agnostic runtime for distributed applications.

- [Architecture](https://github.com/fyrlabs/dead-drop/blob/main/docs/architecture.md)
- [Delivery guarantees](https://github.com/fyrlabs/dead-drop/blob/main/docs/guarantees.md)

## Licence

Apache-2.0.
