/**
 * End-to-end tests: two independent Bridge runtimes, a real transport, real
 * HTTP servers, no mocks below the test boundary.
 *
 * This is the suite that actually answers "does the thing work". Everything
 * else checks a component in isolation; this checks that an unmodified HTTP
 * server on one runtime is reachable from a plain `fetch` on the other, with
 * bytes crossing an encrypted frame in a shared directory in between.
 */

import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateWorkspaceSecret } from '@dead-drop/protocol';
import {
  BridgeRuntime,
  ControlPlaneClient,
  connect,
  defaultSocketPath,
  parseRuntimeConfig,
  startControlPlane,
  type ConnectHandle,
} from '@dead-drop/runtime';
import { filesystemTransport } from '@dead-drop/transport-filesystem';
import { memoryTransport, resetMemoryTransports } from '@dead-drop/transport-memory';

const SECRET = generateWorkspaceSecret();

/** Resolves built-in transport specifiers to the in-repo sources. */
const loader = async (specifier: string): Promise<unknown> => {
  if (specifier.includes('transport-filesystem')) return { filesystemTransport };
  if (specifier.includes('transport-memory')) return { memoryTransport };
  throw new Error(`unexpected transport specifier ${specifier}`);
};

const cleanups: Array<() => Promise<void>> = [];
let sharedDir: string;

async function makeRuntime(options: {
  peerId: string;
  store: string;
  exposures?: Array<Record<string, unknown>>;
  subscribe?: string[];
}): Promise<BridgeRuntime> {
  const dataDir = await mkdtemp(join(tmpdir(), `bridge-${options.peerId}-`));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));

  const config = parseRuntimeConfig({
    dataDir,
    logLevel: 'silent',
    workspaces: [
      {
        name: 'demo',
        peerId: options.peerId,
        secrets: [SECRET],
        transports: [{ use: 'filesystem', config: { root: options.store } }],
        exposures: options.exposures ?? [],
        subscribe: options.subscribe ?? [],
        // Keep the poll tight: these tests wait on real wall-clock time.
        polling: { minIntervalMs: 50, maxIntervalMs: 200 },
        requestTimeoutMs: 15_000,
      },
    ],
  });

  const runtime = new BridgeRuntime({ config, loader });
  await runtime.start();
  cleanups.push(() => runtime.stop());
  return runtime;
}

async function startTargetServer(
  handler: (
    path: string,
    method: string,
    body: Buffer,
  ) => { status: number; body: string; type?: string },
): Promise<{ origin: string; server: Server }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const result = handler(request.url ?? '/', request.method ?? 'GET', Buffer.concat(chunks));
      response.writeHead(result.status, { 'content-type': result.type ?? 'application/json' });
      response.end(result.body);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  cleanups.push(
    () =>
      new Promise<void>((resolveClose) => {
        server.closeIdleConnections?.();
        server.close(() => resolveClose());
      }),
  );
  return { origin: `http://127.0.0.1:${port}`, server };
}

beforeEach(async () => {
  sharedDir = await mkdtemp(join(tmpdir(), 'bridge-shared-'));
  cleanups.push(() => rm(sharedDir, { recursive: true, force: true }));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
  resetMemoryTransports();
});

describe('two runtimes over a shared directory', () => {
  it('proxies a full HTTP round trip through the transport', async () => {
    const target = await startTargetServer((path, method, body) => ({
      status: 200,
      body: JSON.stringify({ path, method, received: body.toString('utf8') }),
    }));

    const server = await makeRuntime({
      peerId: 'server-peer',
      store: sharedDir,
      exposures: [{ name: 'my-api', type: 'http', target: target.origin }],
    });
    const clientRuntime = await makeRuntime({ peerId: 'client-peer', store: sharedDir });

    const handle: ConnectHandle = await connect({
      workspace: clientRuntime.defaultWorkspace(),
      target: 'server-peer',
      exposure: 'my-api',
      logger: clientRuntime.logger,
      timeoutMs: 20_000,
    });
    cleanups.push(() => handle.close());

    const response = await fetch(`${handle.url}/users?active=1`, {
      method: 'POST',
      body: 'hello from the other side',
      headers: { 'content-type': 'text/plain' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: '/users?active=1',
      method: 'POST',
      received: 'hello from the other side',
    });
    // The exposed server never learned Bridge exists.
    expect(server.status().workspaces[0]?.exposures).toEqual(['my-api']);
  }, 30_000);

  it('never writes readable application data into the shared directory', async () => {
    const target = await startTargetServer(() => ({
      status: 200,
      body: JSON.stringify({ secret: 'TOP-SECRET-RESPONSE-BODY' }),
    }));
    await makeRuntime({
      peerId: 'server-peer',
      store: sharedDir,
      exposures: [{ name: 'my-api', type: 'http', target: target.origin }],
    });
    const clientRuntime = await makeRuntime({ peerId: 'client-peer', store: sharedDir });
    const handle = await connect({
      workspace: clientRuntime.defaultWorkspace(),
      target: 'server-peer',
      exposure: 'my-api',
      logger: clientRuntime.logger,
    });
    cleanups.push(() => handle.close());

    await fetch(`${handle.url}/anything?q=TOP-SECRET-QUERY`);

    // Everything the transport ever held must be ciphertext.
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(sharedDir, { recursive: true, withFileTypes: true });
    let inspected = 0;
    for (const entry of files) {
      if (!entry.isFile()) continue;
      inspected += 1;
      const contents = await readFile(join(entry.parentPath ?? entry.path, entry.name));
      expect(contents.includes('TOP-SECRET-RESPONSE-BODY')).toBe(false);
      expect(contents.includes('TOP-SECRET-QUERY')).toBe(false);
      expect(contents.includes('my-api')).toBe(false);
    }
    expect(inspected).toBeGreaterThan(0);
  }, 30_000);

  it('serves static files and blocks path traversal', async () => {
    const siteDir = join(sharedDir, '..', `bridge-site-${Date.now()}`);
    await mkdir(join(siteDir, 'assets'), { recursive: true });
    cleanups.push(() => rm(siteDir, { recursive: true, force: true }));
    await writeFile(join(siteDir, 'index.html'), '<h1>Bridge</h1>');
    await writeFile(join(siteDir, 'assets', 'app.js'), 'console.log(1)');
    await writeFile(join(siteDir, '..', 'outside.txt'), 'must not be served');

    await makeRuntime({
      peerId: 'site-peer',
      store: sharedDir,
      exposures: [{ name: 'site', type: 'static', directory: siteDir }],
    });
    const clientRuntime = await makeRuntime({ peerId: 'browser-peer', store: sharedDir });
    const handle = await connect({
      workspace: clientRuntime.defaultWorkspace(),
      target: 'site-peer',
      exposure: 'site',
      logger: clientRuntime.logger,
    });
    cleanups.push(() => handle.close());

    const index = await fetch(`${handle.url}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(await index.text()).toContain('<h1>Bridge</h1>');

    const asset = await fetch(`${handle.url}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('javascript');

    const missing = await fetch(`${handle.url}/nope.html`);
    expect(missing.status).toBe(404);

    const traversal = await fetch(`${handle.url}/..%2Foutside.txt`);
    expect([403, 404]).toContain(traversal.status);
    expect(await traversal.text()).not.toContain('must not be served');

    const method = await fetch(`${handle.url}/index.html`, { method: 'DELETE' });
    expect(method.status).toBe(405);
  }, 30_000);

  it('carries an RPC call and a service error', async () => {
    const server = await makeRuntime({ peerId: 'rpc-server', store: sharedDir });
    server.defaultWorkspace().service('math', {
      add: (input) => {
        const { a, b } = input as { a: number; b: number };
        return a + b;
      },
      boom: () => {
        throw new Error('handler exploded');
      },
    });
    const clientRuntime = await makeRuntime({ peerId: 'rpc-client', store: sharedDir });
    const workspace = clientRuntime.defaultWorkspace();

    expect(await workspace.call('rpc-server', 'math.add', { a: 10, b: 20 })).toBe(30);
    await expect(workspace.call('rpc-server', 'math.boom', {})).rejects.toMatchObject({
      code: 'SERVICE_ERROR',
    });
    await expect(workspace.call('rpc-server', 'math.missing', {})).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  }, 30_000);

  it('delivers a published event to a subscriber', async () => {
    const publisher = await makeRuntime({ peerId: 'publisher', store: sharedDir });
    const subscriber = await makeRuntime({ peerId: 'subscriber', store: sharedDir });

    const received: string[] = [];
    subscriber.defaultWorkspace().subscribe('events/orders', (payload) => {
      received.push(Buffer.from(payload).toString('utf8'));
    });

    await publisher
      .defaultWorkspace()
      .publish('events/orders', Buffer.from('{"type":"user.created"}'));

    await waitFor(() => received.length > 0, 15_000);
    expect(received[0]).toBe('{"type":"user.created"}');
  }, 30_000);

  it('discovers peers and their exposures', async () => {
    const target = await startTargetServer(() => ({ status: 200, body: '{}' }));
    await makeRuntime({
      peerId: 'discoverable',
      store: sharedDir,
      exposures: [{ name: 'api', type: 'http', target: target.origin }],
    });
    const observer = await makeRuntime({ peerId: 'observer', store: sharedDir });

    await waitFor(async () => (await observer.defaultWorkspace().discover()).length >= 2, 15_000);
    const peers = await observer.defaultWorkspace().discover();
    const found = peers.find((peer) => peer.peerId === 'discoverable');
    expect(found?.exposures).toContain('api');
    expect(peers.map((peer) => peer.peerId)).toContain('observer');
  }, 30_000);

  it('moves a payload larger than the transport chunk size', async () => {
    const big = 'x'.repeat(300_000);
    const target = await startTargetServer(() => ({ status: 200, body: big, type: 'text/plain' }));
    await makeRuntime({
      peerId: 'bulk-server',
      store: sharedDir,
      exposures: [{ name: 'bulk', type: 'http', target: target.origin }],
    });
    const clientRuntime = await makeRuntime({ peerId: 'bulk-client', store: sharedDir });
    const handle = await connect({
      workspace: clientRuntime.defaultWorkspace(),
      target: 'bulk-server',
      exposure: 'bulk',
      logger: clientRuntime.logger,
      timeoutMs: 25_000,
    });
    cleanups.push(() => handle.close());

    const response = await fetch(`${handle.url}/big`);
    expect(await response.text()).toHaveLength(big.length);
  }, 40_000);

  it('reports a clear error when the exposed target is down', async () => {
    await makeRuntime({
      peerId: 'broken-server',
      store: sharedDir,
      // Nothing is listening on this port.
      exposures: [{ name: 'dead', type: 'http', target: 'http://127.0.0.1:1', timeoutMs: 2000 }],
    });
    const clientRuntime = await makeRuntime({ peerId: 'hopeful-client', store: sharedDir });
    const handle = await connect({
      workspace: clientRuntime.defaultWorkspace(),
      target: 'broken-server',
      exposure: 'dead',
      logger: clientRuntime.logger,
      timeoutMs: 15_000,
    });
    cleanups.push(() => handle.close());

    const response = await fetch(`${handle.url}/`);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('not reachable');
  }, 30_000);

  it('times out a request to a peer that is not running', async () => {
    const clientRuntime = await makeRuntime({ peerId: 'lonely', store: sharedDir });
    await expect(
      clientRuntime
        .defaultWorkspace()
        .call('ghost-peer', 'anything.at.all', {}, { timeoutMs: 800 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  }, 20_000);
});

describe('control plane', () => {
  it('answers status, metrics, expose and call over the socket', async () => {
    const target = await startTargetServer(() => ({ status: 200, body: '{"ok":true}' }));
    const runtime = await makeRuntime({ peerId: 'control-peer', store: sharedDir });
    runtime.defaultWorkspace().service('echo', { say: (input) => input });

    const dataDir = await mkdtemp(join(tmpdir(), 'bridge-control-'));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    const socketPath = defaultSocketPath(dataDir);
    const control = await startControlPlane({ runtime, socketPath, logger: runtime.logger });
    cleanups.push(() => control.close());

    const client = new ControlPlaneClient(socketPath);
    expect(await client.request('GET', '/health')).toMatchObject({ ok: true });

    const status = await client.request<{ workspaces: Array<{ peerId: string }> }>(
      'GET',
      '/status',
    );
    expect(status.workspaces[0]?.peerId).toBe('control-peer');

    const exposed = await client.request<{ channel: string }>('POST', '/expose', {
      name: 'via-control',
      type: 'http',
      target: target.origin,
    });
    expect(exposed.channel).toBe('http/via-control');

    const called = await client.request<{ result: unknown }>('POST', '/call', {
      target: 'control-peer',
      channel: 'echo.say',
      input: { hello: 'world' },
    });
    expect(called.result).toEqual({ hello: 'world' });

    const metrics = await client.request<string>('GET', '/metrics');
    expect(metrics).toContain('bridge_messages_sent_total');

    const logs = await client.request<{ records: unknown[] }>('GET', '/logs?limit=5');
    expect(Array.isArray(logs.records)).toBe(true);

    await expect(client.request('GET', '/nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 30_000);

  it('reports an actionable error when no runtime is listening', async () => {
    const client = new ControlPlaneClient(join(tmpdir(), 'bridge-missing.sock'));
    await expect(client.request('GET', '/health')).rejects.toThrowError(/bridge start/);
  });
});

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}
