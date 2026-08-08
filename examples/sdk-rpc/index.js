/**
 * Bridge-native interactions: services, RPC and publish/subscribe.
 *
 *   node examples/sdk-rpc/index.js
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateWorkspaceSecret } from '@dead-drop/protocol';
import { BridgeRuntime, parseRuntimeConfig } from '@dead-drop/runtime';

const shared = await mkdtemp(join(tmpdir(), 'bridge-rpc-'));
const secret = generateWorkspaceSecret();

const runtimeFor = async (peerId) => {
  const runtime = new BridgeRuntime({
    config: parseRuntimeConfig({
      dataDir: join(shared, `${peerId}-state`),
      logLevel: 'warn',
      workspaces: [
        {
          name: 'demo',
          peerId,
          secrets: [secret],
          transports: [{ use: 'filesystem', config: { root: join(shared, 'store') } }],
          polling: { minIntervalMs: 100, maxIntervalMs: 500 },
        },
      ],
    }),
  });
  await runtime.start();
  return runtime;
};

const provider = await runtimeFor('provider');
const consumer = await runtimeFor('consumer');

// A service is a plain object of functions. Arguments and results are JSON.
provider.defaultWorkspace().service('math', {
  add: ({ a, b }) => a + b,
  divide: ({ a, b }) => {
    if (b === 0) throw new Error('cannot divide by zero');
    return a / b;
  },
});

console.log(
  '10 + 20 =',
  await consumer.defaultWorkspace().call('provider', 'math.add', { a: 10, b: 20 }),
);

// Remote failures arrive as BridgeErrors with the remote code intact.
try {
  await consumer.defaultWorkspace().call('provider', 'math.divide', { a: 1, b: 0 });
} catch (error) {
  console.log('remote error:', error.code, '-', error.message);
}

// Broadcast: every subscriber sees it, nobody acknowledges it.
provider.defaultWorkspace().subscribe('events/orders', (payload) => {
  console.log('provider received event:', Buffer.from(payload).toString());
});
await consumer
  .defaultWorkspace()
  .publish('events/orders', Buffer.from(JSON.stringify({ type: 'order.created', id: 42 })));

await new Promise((resolve) => setTimeout(resolve, 1500));

await consumer.stop();
await provider.stop();
await rm(shared, { recursive: true, force: true });
