# @dead-drop/protocol

The Bridge wire contract: envelope shape and validation, sortable message ids, the AES-256-GCM frame codec, payload chunking and the error model. No runtime dependencies and no policy — it defines what a message *is*, not what happens to it.

Part of [Bridge](https://github.com/) — a transport-agnostic runtime for distributed applications. See the repository README for the full picture, and `docs/` for the architecture, security model and delivery guarantees.

## Install

```bash
npm install @dead-drop/protocol
```

Requires Node.js 20.11 or newer.

## Licence

Apache-2.0.
