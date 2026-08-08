# @fyrlabs/dead-drop-transport-sdk

The contract third-party transports compile against, plus the conformance suite that proves one behaves.

Deliberately small and deliberately stable: it is the only thing outside the dead-drop repository that has to keep working across releases. Install this if you are writing a transport. You do not need it to use dead-drop.

## Install

```bash
npm install @fyrlabs/dead-drop-transport-sdk
```

Requires Node.js 20.11 or newer.

## Writing a transport

Most backends people want are object stores with no delivery semantics of their own: S3, a git remote, a synced folder, SharePoint. So a `store` transport implements four methods, and the runtime supplies encryption, chunking, acknowledgement, retries, deduplication, ordering and failover on top.

```js
import { assertValidKey, defineTransport } from '@fyrlabs/dead-drop-transport-sdk';

export const acmeTransport = defineTransport({
  id: 'acme',
  capabilities: {
    kind: 'store',
    ordering: 'partition',
    binaryPayloads: true,
    delete: true,
    watch: false,
    orderedList: true,
  },
  create(config, context) {
    return {
      kind: 'store',
      async put(key, data, options = {}) {
        assertValidKey(key);
        /* … */
      },
      async get(key) {
        /* … returns undefined when missing, never throws */
      },
      async list(prefix, options) {
        /* … */
      },
      async delete(key) {
        /* … idempotent */
      },
      async health() {
        return { status: 'healthy' };
      },
    };
  },
});
```

A backend that already is a message system can declare `kind: 'native'` and send and subscribe directly instead.

## Prove it behaves

```js
import { transportConformanceCases } from '@fyrlabs/dead-drop-transport-sdk/testing';
```

The suite is framework-agnostic: it hands you cases you run under vitest, jest, node:test or a bare script. It covers the behaviour the mailbox engine depends on, including that `get` returns undefined rather than throwing for a missing key, that `delete` is idempotent, that `list` does not treat a prefix as a substring, that pagination terminates, and that every byte value survives a round trip.

A complete transport in about 60 lines, with the suite running against it, is in [examples/custom-transport](https://github.com/fyrlabs/dead-drop/blob/main/examples/custom-transport/index.js).

## Documentation

Part of [dead-drop](https://github.com/fyrlabs/dead-drop), a transport-agnostic runtime for distributed applications.

- [Writing a transport](https://github.com/fyrlabs/dead-drop/blob/main/docs/writing-a-transport.md)

## Licence

Apache-2.0.
