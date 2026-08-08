/**
 * Proxy mode: an ordinary HTTP server on one runtime, reachable from another.
 *
 * The "application" here is a plain node:http server with no idea Bridge
 * exists. That is the whole point of proxy mode: nothing about it changes.
 *
 *   node examples/express-proxy/index.js
 */

import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateWorkspaceSecret } from '@dead-drop/protocol';
import { BridgeRuntime, connect, parseRuntimeConfig } from '@dead-drop/runtime';

const shared = await mkdtemp(join(tmpdir(), 'bridge-example-'));
const secret = generateWorkspaceSecret();

// ---------------------------------------------------------------------------
// 1. An application. Completely unaware of Bridge.
// ---------------------------------------------------------------------------
const app = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ hello: 'world', youAsked: request.url }));
});
await new Promise((resolve) => app.listen(3000, '127.0.0.1', resolve));
console.log('app listening on http://127.0.0.1:3000');

// ---------------------------------------------------------------------------
// 2. The runtime on the serving machine, exposing it.
// ---------------------------------------------------------------------------
const makeConfig = (peerId, exposures = []) =>
  parseRuntimeConfig({
    dataDir: join(shared, `${peerId}-state`),
    logLevel: 'warn',
    workspaces: [
      {
        name: 'demo',
        peerId,
        secrets: [secret],
        transports: [{ use: 'filesystem', config: { root: join(shared, 'store') } }],
        exposures,
        polling: { minIntervalMs: 100, maxIntervalMs: 500 },
      },
    ],
  });

const server = new BridgeRuntime({
  config: makeConfig('machine-a', [
    { name: 'my-api', type: 'http', target: 'http://127.0.0.1:3000' },
  ]),
});
await server.start();

// ---------------------------------------------------------------------------
// 3. A second runtime, on what would be another machine, consuming it.
// ---------------------------------------------------------------------------
const client = new BridgeRuntime({ config: makeConfig('machine-b') });
await client.start();

const handle = await connect({
  workspace: client.defaultWorkspace(),
  target: 'machine-a',
  exposure: 'my-api',
  logger: client.logger,
});
console.log(`bridge endpoint: ${handle.url}  ->  machine-a/my-api`);

const response = await fetch(`${handle.url}/users?active=1`);
console.log('response:', await response.json());
console.log('\nThose bytes crossed an encrypted frame in', join(shared, 'store'));

await handle.close();
await client.stop();
await server.stop();
app.close();
await rm(shared, { recursive: true, force: true });
