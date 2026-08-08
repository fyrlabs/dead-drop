# @fyrlabs/dead-drop-protocol

What a dead-drop message *is*: envelope shape, wire framing, AES-256-GCM encryption, chunking of large payloads, the HTTP request/response mapping, workspace secrets and the error model.

Zero dependencies and zero policy. It knows nothing about transports, workspaces or applications, which is what lets everything above it change without touching the wire format.

Most people never install this directly. You want it if you are implementing a transport, inspecting frames, or handling `DeadDropError` by code.

## Install

```bash
npm install @fyrlabs/dead-drop-protocol
```

Requires Node.js 20.11 or newer.

## Usage

```js
import { DeadDropError, generateWorkspaceSecret, isValidName } from '@fyrlabs/dead-drop-protocol';

const secret = generateWorkspaceSecret(); // ddk1_…, 32 bytes of entropy

isValidName('machine-a'); // true
isValidName('../etc'); // false

throw new DeadDropError('TRANSPORT_ERROR', 'the remote rejected the push', { retryable: true });
```

`DeadDropError` carries a stable `code`, a `retryable` flag the transport manager reads when deciding whether to retry or fail over, and an optional `retryAfterMs`. It survives a round trip through JSON with `toJSON` and `fromJSON`, so a remote failure reaches the caller with its original code rather than as a generic error.

## What is on the wire

Everything, including the envelope header, is ciphertext. Channel names, peer ids and workspace names never appear in clear text, because the transport is treated as hostile storage. Message sizes, timing and object keys are not hidden. The [security model](https://github.com/fyrlabs/dead-drop/blob/main/docs/security-model.md) states exactly what is and is not protected.

## Documentation

Part of [dead-drop](https://github.com/fyrlabs/dead-drop), a transport-agnostic runtime for distributed applications.

- [Security model](https://github.com/fyrlabs/dead-drop/blob/main/docs/security-model.md)
- [Architecture](https://github.com/fyrlabs/dead-drop/blob/main/docs/architecture.md)

## Licence

Apache-2.0.
