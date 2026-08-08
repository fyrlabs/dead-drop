# @dead-drop/transport-memory

An in-process object store for tests and examples. Instances sharing a namespace share one backing map, so two runtimes in one process can talk. Not for production: nothing survives a restart.

Part of [Bridge](https://github.com/) — a transport-agnostic runtime for distributed applications. See the repository README for the full picture, and `docs/` for the architecture, security model and delivery guarantees.

## Install

```bash
npm install @dead-drop/transport-memory
```

Requires Node.js 20.11 or newer.

## Licence

Apache-2.0.
