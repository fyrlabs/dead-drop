# @dead-drop/transport-sdk

Everything needed to write a Bridge transport adapter, and nothing else. Implement four methods (put, get, list, delete) and the runtime supplies encryption, chunking, acknowledgement, retries, deduplication and failover on top. Ships a framework-agnostic conformance suite at `@dead-drop/transport-sdk/testing` — see `docs/writing-a-transport.md`.

Part of [Bridge](https://github.com/) — a transport-agnostic runtime for distributed applications. See the repository README for the full picture, and `docs/` for the architecture, security model and delivery guarantees.

## Install

```bash
npm install @dead-drop/transport-sdk
```

Requires Node.js 20.11 or newer.

## Licence

Apache-2.0.
