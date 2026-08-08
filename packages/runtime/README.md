# @fyrlabs/dead-drop-runtime

The dead-drop runtime, embeddable in your own process. Owns workspaces, exposures, peer discovery, plugin loading and the control plane that `ddrop` and the SDK talk to.

Use this when you want dead-drop inside your application rather than as a separate `ddrop start` process. If you just want to run it, install [@fyrlabs/dead-drop](https://www.npmjs.com/package/@fyrlabs/dead-drop) instead.

## Install

```bash
npm install @fyrlabs/dead-drop-runtime
```

Requires Node.js 20.11 or newer. Transports are separate packages; install the ones you name in your config.

## Usage

```js
import { DeadDropRuntime, parseRuntimeConfig } from '@fyrlabs/dead-drop-runtime';

const runtime = new DeadDropRuntime({
  config: parseRuntimeConfig({
    dataDir: '/var/lib/deaddrop',
    workspaces: [
      {
        name: 'demo',
        peerId: 'machine-a',
        secrets: [process.env.DEADDROP_SECRET],
        transports: [{ use: 'filesystem', config: { root: '/mnt/shared/deaddrop' } }],
      },
    ],
  }),
});

await runtime.start();

const workspace = runtime.defaultWorkspace();

// Expose a set of functions. Arguments and results are JSON.
workspace.service('math', {
  add: ({ a, b }) => a + b,
});

// Call one on another peer.
const sum = await workspace.call('machine-b', 'math.add', { a: 1, b: 2 });

// Broadcast, and subscribe to broadcasts.
workspace.subscribe('events/orders', (payload) => console.log(Buffer.from(payload).toString()));
await workspace.publish('events/orders', Buffer.from('{"id":42}'));
```

`parseRuntimeConfig` validates everything up front and throws a `CONFIG_INVALID` error naming the offending workspace and field. `loadRuntimeConfig(path)` does the same from a JSON file, resolving relative paths against the file's directory.

## Documentation

Part of [dead-drop](https://github.com/fyrlabs/dead-drop), a transport-agnostic runtime for distributed applications.

- [Architecture](https://github.com/fyrlabs/dead-drop/blob/main/docs/architecture.md)
- [Configuration reference](https://github.com/fyrlabs/dead-drop/blob/main/docs/configuration.md)
- [Delivery guarantees](https://github.com/fyrlabs/dead-drop/blob/main/docs/guarantees.md)

## Licence

Apache-2.0.
