/**
 * The server behind `ddrop dashboard`: a read-only web view of a running runtime.
 *
 * It binds an HTTP port because a browser cannot open a Unix socket, and it
 * reaches the runtime the same way `ddrop status` does — as a client of the
 * control socket. It constructs no `DeadDropRuntime`, so it clones no working
 * directory, claims no peer id and writes no presence beacon. Why that matters,
 * and why a TCP listener here does not relax the control plane's "never TCP"
 * rule, is [ADR 0004](../../../../docs/adr/0004-dashboard-binds-tcp-and-holds-no-runtime.md).
 *
 * Three properties in here are load-bearing rather than stylistic, and each has
 * its reason at the field: the API is an allowlist of the control plane's *read*
 * routes, assets are an explicit filename map rather than a path join, and the
 * `Host` header must name the loopback interface.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';

import { DeadDropError } from '../protocol/index.js';
import { ControlPlaneClient, closeServer, statusForError } from '../runtime/index.js';

/**
 * Below the ephemeral range on every supported platform (Linux starts at 32768,
 * macOS at 49152), so `ddrop connect` asking the OS for a port can never be
 * handed this one. Fixed rather than hunted for: a dashboard that silently moves
 * is a dashboard nobody can bookmark.
 */
export const DEFAULT_DASHBOARD_PORT = 7373;

export interface DashboardOptions {
  /** Control socket of the runtime to read. Same path `ddrop status` uses. */
  socketPath: string;
  /** TCP port. 0 asks the OS for a free one. */
  port: number;
  /** Loopback by design. Present for tests, not exposed as a flag. */
  host?: string;
}

export interface DashboardHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Static assets, addressed by an exact request path.
 *
 * A map rather than `join(assetDir, url.pathname)`: nothing here concatenates a
 * request path onto a directory, so `..` traversal is impossible by construction
 * instead of being filtered out correctly today and incorrectly after the next
 * edit.
 */
const ASSETS: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/lume.min.mjs': { file: 'lume.min.mjs', type: 'text/javascript; charset=utf-8' },
};

/**
 * The control plane routes this proxies. Every one is a GET that only reads.
 *
 * `/publish`, `/call` and `/expose` are deliberately absent and must stay
 * absent: they are the capability ADR 0004 refuses to put on a browser-reachable
 * port. Adding one here is not an extension of that decision, it reopens it.
 */
const API_ROUTES: Record<string, string> = {
  '/api/status': '/status',
  '/api/workspaces': '/workspaces',
  '/api/peers': '/peers',
  '/api/queues': '/queues',
  '/api/transports': '/transports',
  '/api/logs': '/logs',
  '/api/traces': '/traces',
  '/api/metrics': '/metrics',
};

/** Query parameters passed through to the control plane. Everything else is dropped. */
const FORWARDED_PARAMS = ['workspace', 'stale', 'limit', 'level', 'id'];

const ASSET_DIR = new URL('../../static/', import.meta.url);

export async function startDashboard(options: DashboardOptions): Promise<DashboardHandle> {
  const host = options.host ?? '127.0.0.1';
  const control = new ControlPlaneClient(options.socketPath);

  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      const failure = DeadDropError.from(error);
      sendJson(response, statusForError(failure), { error: failure.toJSON() });
    });
  });

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // A browser will not send Host for HTTP/1.0, and nothing else this serves
    // is reachable without it. Rejecting a foreign Host is what stops a page the
    // user happens to be visiting from resolving its own name to 127.0.0.1 and
    // reading workspace metadata off this port. Read-only keeps the damage to
    // disclosure; this keeps the disclosure to processes on this machine.
    if (!isLoopbackHost(request.headers.host)) {
      sendJson(response, 403, {
        error: { code: 'UNAUTHORIZED', message: 'the dashboard answers loopback hosts only' },
      });
      return;
    }
    // The dashboard reads. A write verb is not a route that is missing, it is a
    // route that will not exist.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain' });
      response.end('The dashboard is read-only.\n');
      return;
    }

    const url = new URL(request.url ?? '/', 'http://dashboard.local');
    const asset = ASSETS[url.pathname];
    if (asset) {
      const body = await readFile(new URL(asset.file, ASSET_DIR));
      response.writeHead(200, {
        'content-type': asset.type,
        'content-length': body.byteLength,
        // The page is a view of live state; a cached copy is a lie with a
        // timestamp on it.
        'cache-control': 'no-store',
        // The page loads only its own scripts and stylesheet and talks only to
        // its own origin, so it can say so. Nothing is inline, which is why
        // 'self' is enough and no 'unsafe-inline' appears here.
        'content-security-policy':
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'",
        'x-content-type-options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }

    const target = API_ROUTES[url.pathname];
    if (target === undefined) {
      throw new DeadDropError('NOT_FOUND', `no dashboard route for ${url.pathname}`);
    }
    const body = await control.request<unknown>('GET', target + forwardedQuery(url));
    if (typeof body === 'string') {
      // `/metrics` answers Prometheus text, not JSON.
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(body);
      return;
    }
    sendJson(response, 200, body);
  }

  server.listen(options.port, host);
  try {
    await once(server, 'listening');
  } catch (error) {
    // Loudly, and named. Hunting for a free port would move the dashboard out
    // from under whatever the operator bookmarked, and hide that something else
    // already owns the port they asked for.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      throw new DeadDropError(
        'CONFIG_INVALID',
        `port ${options.port} is already in use on ${host}. Pass --port with a free one, or --port 0 to let the OS choose.`,
        { cause: error },
      );
    }
    if (code === 'EACCES') {
      throw new DeadDropError(
        'CONFIG_INVALID',
        `not allowed to bind port ${options.port} on ${host}. Ports below 1024 need privileges; pass --port with a higher one.`,
        { cause: error },
      );
    }
    throw DeadDropError.from(error);
  }

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  return {
    url: `http://${host}:${port}`,
    port,
    close: () => closeServer(server),
  };
}

/**
 * Whether a `Host` header names this machine's loopback interface.
 *
 * The port is bound to 127.0.0.1, so any other name in the header arrived by DNS
 * pointing somewhere at this address rather than by the user typing it.
 */
export function isLoopbackHost(header: string | undefined): boolean {
  if (header === undefined) return false;
  const name = header.startsWith('[')
    ? header.slice(0, header.indexOf(']') + 1)
    : (header.split(':')[0] ?? '');
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

function forwardedQuery(url: URL): string {
  const params = new URLSearchParams();
  for (const name of FORWARDED_PARAMS) {
    const value = url.searchParams.get(name);
    if (value !== null) params.set(name, value);
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

/**
 * How to hand a URL to the desktop's browser, per platform.
 *
 * Split out from the spawning so the platform branch is testable without
 * launching anything: the Windows case in particular is easy to get wrong, and
 * only CI would ever see it. `start` is a `cmd` builtin, and its first quoted
 * argument is the window title, which is why the empty string is there — without
 * it a quoted URL becomes the title and nothing opens.
 */
export function browserOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: [url] };
}
