# @fyrlabs/dead-drop-sdk

A client for a running dead-drop runtime. Talks to it over its local control socket, so your application can inspect peers, publish events and read metrics without shelling out to `ddrop`.

Use this when something already runs `ddrop start` and you want to drive it from Node.js. If you want to embed the runtime in your own process instead, use [@fyrlabs/dead-drop-runtime](https://www.npmjs.com/package/@fyrlabs/dead-drop-runtime).

## Install

```bash
npm install @fyrlabs/dead-drop-sdk
```

Requires Node.js 20.11 or newer.

## Usage

```js
import { createClient } from '@fyrlabs/dead-drop-sdk';

const client = createClient(); // finds the socket under the default data dir

const { version } = await client.ping();
const status = await client.status();
const peers = await client.peers();
const transports = await client.transports();

await client.publish('events/orders', { type: 'order.created', id: 42 });

const prometheus = await client.metrics();
```

Point it somewhere else with `createClient({ socketPath })`, or `createClient({ dataDir })` to derive the socket the way the runtime does.

Failures arrive as `DeadDropError` with the runtime's own error code intact, so you can branch on `error.code` rather than parsing messages.

## Documentation

Part of [dead-drop](https://github.com/fyrlabs/dead-drop), a transport-agnostic runtime for distributed applications.

- [Architecture](https://github.com/fyrlabs/dead-drop/blob/main/docs/architecture.md)
- [Configuration reference](https://github.com/fyrlabs/dead-drop/blob/main/docs/configuration.md)

## Licence

Apache-2.0.
