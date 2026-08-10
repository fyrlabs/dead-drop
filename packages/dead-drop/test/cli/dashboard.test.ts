import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DeadDropError } from '#dead-drop/protocol/index.js';

import {
  DEFAULT_DASHBOARD_PORT,
  browserOpenCommand,
  isLoopbackHost,
  startDashboard,
  type DashboardHandle,
} from '#dead-drop/cli/dashboard.js';

const dirs: string[] = [];
const servers: Server[] = [];
const dashboards: DashboardHandle[] = [];
/** Keeps each named pipe unique within the process. */
let planes = 0;

interface Recorded {
  method: string;
  url: string;
}

/**
 * A control plane that answers a canned body per path and records what it was
 * asked for, so the proxy can be driven without a runtime.
 *
 * The Windows branch is not decoration: `listen` on a socket path there fails
 * with a bare `EACCES`, which took a whole CI job to diagnose the last time a
 * test helper bound one unconditionally.
 */
async function fakeControlPlane(
  bodies: Record<string, unknown>,
): Promise<{ socketPath: string; seen: Recorded[] }> {
  const seen: Recorded[] = [];
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\deaddrop-dash-${process.pid.toString(16)}-${planes++}`
      : join(await temp(), 'control.sock');
  const server = createServer((request, response) => {
    seen.push({ method: request.method ?? '', url: request.url ?? '' });
    const path = (request.url ?? '').split('?')[0] ?? '';
    const body = bodies[path];
    if (body === undefined) {
      const error = new DeadDropError('NOT_FOUND', `no route for ${path}`);
      const payload = JSON.stringify({ error: error.toJSON() });
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(payload);
      return;
    }
    if (typeof body === 'string') {
      response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      response.end(body);
      return;
    }
    const payload = JSON.stringify(body);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(payload);
  });
  server.listen(socketPath);
  await once(server, 'listening');
  servers.push(server);
  return { socketPath, seen };
}

/** A GET with a chosen Host header, which `fetch` will not send. */
async function statusWithHost(port: number, host: string): Promise<number> {
  const { request } = await import('node:http');
  return new Promise<number>((resolve, reject) => {
    const call = request(
      { host: '127.0.0.1', port, path: '/api/status', headers: { host } },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    call.on('error', reject);
    call.end();
  });
}

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'deaddrop-dash-'));
  dirs.push(dir);
  return dir;
}

/** Port 0 throughout: a fixed port would collide with whatever else CI is running. */
async function dashboard(socketPath: string): Promise<DashboardHandle> {
  const handle = await startDashboard({ socketPath, port: 0 });
  dashboards.push(handle);
  return handle;
}

afterEach(async () => {
  await Promise.all(dashboards.splice(0).map((handle) => handle.close()));
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ddrop dashboard server', () => {
  it('serves the page and the vendored library from the package, not a CDN', async () => {
    const { socketPath } = await fakeControlPlane({});
    const handle = await dashboard(socketPath);

    const page = await fetch(handle.url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('/app.js');
    expect(html).toContain('/app.css');

    const app = await fetch(`${handle.url}/app.js`);
    expect(app.status).toBe(200);
    const script = await app.text();
    expect(script).toContain("from '/lume.min.mjs'");

    const library = await fetch(`${handle.url}/lume.min.mjs`);
    expect(library.status).toBe(200);
    expect(await library.text()).toContain('export{');

    expect((await fetch(`${handle.url}/app.css`)).status).toBe(200);

    // The whole point of vendoring: nothing the page loads comes off the
    // network. A CDN import would render an offline machine's dashboard blank,
    // which is the opposite of what this product is for.
    for (const source of [html, script]) {
      expect(source).not.toMatch(/(src|href|from)\s*=?\s*["']https?:\/\//);
    }
  });

  it('proxies the read routes of the control plane and forwards the workspace', async () => {
    const { socketPath, seen } = await fakeControlPlane({
      '/status': { version: '9.9.9', workspaces: [] },
      '/queues': { queues: [], read: 1, unreadable: [], truncated: false },
      '/metrics': 'deaddrop_up 1\n',
    });
    const handle = await dashboard(socketPath);

    expect(await (await fetch(`${handle.url}/api/status`)).json()).toEqual({
      version: '9.9.9',
      workspaces: [],
    });
    await fetch(`${handle.url}/api/queues?workspace=demo&nonsense=1`);
    const metrics = await fetch(`${handle.url}/api/metrics`);
    expect(metrics.headers.get('content-type')).toContain('text/plain');
    expect(await metrics.text()).toBe('deaddrop_up 1\n');

    expect(seen.map((entry) => entry.url)).toEqual([
      '/status',
      '/queues?workspace=demo',
      '/metrics',
    ]);
  });

  it('exposes no route that publishes, calls or exposes', async () => {
    // ADR 0004 keeps the dashboard read-only, and that is what lets it bind a
    // port at all. A write route appearing here reopens the decision.
    const { socketPath, seen } = await fakeControlPlane({ '/status': { workspaces: [] } });
    const handle = await dashboard(socketPath);

    for (const path of ['/api/publish', '/api/call', '/api/expose']) {
      expect((await fetch(`${handle.url}${path}`)).status).toBe(404);
    }
    const posted = await fetch(`${handle.url}/api/status`, { method: 'POST' });
    expect(posted.status).toBe(405);
    expect(posted.headers.get('allow')).toBe('GET, HEAD');
    // Nothing reached the runtime: the refusal happens here, not there.
    expect(seen).toEqual([]);
  });

  it('answers loopback hosts only, so a rebound name cannot read the workspace', async () => {
    const { socketPath, seen } = await fakeControlPlane({ '/status': { workspaces: [] } });
    const handle = await dashboard(socketPath);

    // `fetch` refuses to set Host, so this one goes through node:http. A page
    // resolving its own name to 127.0.0.1 is exactly how a browser is made to
    // send a foreign Host to a local port.
    expect(await statusWithHost(handle.port, 'evil.example')).toBe(403);
    expect(seen).toEqual([]);
    expect(await statusWithHost(handle.port, `localhost:${handle.port}`)).toBe(200);
  });

  it('passes a control plane failure through with its code', async () => {
    const { socketPath } = await fakeControlPlane({});
    const handle = await dashboard(socketPath);

    const response = await fetch(`${handle.url}/api/peers`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('reports an unreachable runtime rather than an empty page', async () => {
    const missing =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\deaddrop-dash-absent-${process.pid.toString(16)}`
        : join(await temp(), 'not-a-socket.sock');
    const handle = await dashboard(missing);

    // The page still serves: a dashboard opened before `ddrop start`, or held
    // across a restart, is a reasonable thing to do.
    expect((await fetch(handle.url)).status).toBe(200);
    const response = await fetch(`${handle.url}/api/status`);
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'NO_TRANSPORT_AVAILABLE',
    );
  });

  it('fails loudly when the port is taken instead of moving to another one', async () => {
    const { socketPath } = await fakeControlPlane({});
    const first = await dashboard(socketPath);

    await expect(startDashboard({ socketPath, port: first.port })).rejects.toThrow(
      new RegExp(`port ${first.port} is already in use`),
    );
  });

  it('defaults to a port outside the ephemeral range', () => {
    // `ddrop connect --port 0` takes an ephemeral port, and Linux starts that
    // range at 32768. A default inside it could be handed to a proxy session.
    expect(DEFAULT_DASHBOARD_PORT).toBeLessThan(32768);
  });

  it('knows which hosts are the loopback interface', () => {
    expect(isLoopbackHost('127.0.0.1:7373')).toBe(true);
    expect(isLoopbackHost('localhost:7373')).toBe(true);
    expect(isLoopbackHost('[::1]:7373')).toBe(true);
    expect(isLoopbackHost('deaddrop.internal:7373')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.evil.example')).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });

  it('opens a browser the way each platform expects', () => {
    expect(browserOpenCommand('darwin', 'http://127.0.0.1:7373')).toEqual({
      command: 'open',
      args: ['http://127.0.0.1:7373'],
    });
    expect(browserOpenCommand('linux', 'http://127.0.0.1:7373').command).toBe('xdg-open');
    // `start` is a cmd builtin whose first quoted argument is the window title,
    // so the empty string is load-bearing: without it the URL becomes the title.
    expect(browserOpenCommand('win32', 'http://127.0.0.1:7373')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '', 'http://127.0.0.1:7373'],
    });
  });
});
