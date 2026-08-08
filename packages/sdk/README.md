# @fyrlabs/dead-drop-sdk

The optional application client: publish/subscribe, RPC and services over the local runtime socket. Optional by design — an existing application is exposed with `bridge expose` and never imports this. Transport credentials stay in the runtime, not in your process.

Part of [Bridge](https://github.com/) — a transport-agnostic runtime for distributed applications. See the repository README for the full picture, and `docs/` for the architecture, security model and delivery guarantees.

## Install

```bash
npm install @fyrlabs/dead-drop-sdk
```

Requires Node.js 20.11 or newer.

## Licence

Apache-2.0.
