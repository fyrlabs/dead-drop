/**
 * The local control plane.
 *
 * Applications and the CLI talk to a running runtime over a Unix domain socket
 * (a named pipe on Windows), never over TCP. That is a security decision, not a
 * style one: the runtime holds workspace secrets and transport credentials, and
 * a localhost TCP port is reachable by every process *and* every container that
 * shares the network namespace, whereas a socket file is governed by filesystem
 * permissions.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { platform, tmpdir } from 'node:os';

import { DeadDropError, decodeJson, encodeJson } from '../protocol/index.js';
import type { Logger } from '../core/index.js';

import { closeServer } from './connect.js';
import { statusForError } from './exposure.js';
import type { DeadDropRuntime } from './runtime.js';

export interface ControlPlaneOptions {
  runtime: DeadDropRuntime;
  /** Socket path, or a `\\.\pipe\...` name on Windows. */
  socketPath: string;
  logger: Logger;
  /** Largest control request body. Default 1 MiB. */
  maxBodyBytes?: number;
}

export interface ControlPlaneHandle {
  socketPath: string;
  close(): Promise<void>;
}

/**
 * Longest usable Unix socket path. macOS caps `sockaddr_un.sun_path` at 104
 * bytes, Linux at 108; past it `bind` fails with a bare `EINVAL` that names
 * neither the limit nor a fix. The lower cap applies on every POSIX platform so
 * that a given data directory behaves the same everywhere, rather than working
 * on Linux and failing on a Mac.
 */
const MAX_UNIX_SOCKET_PATH_BYTES = 104;

/** Default socket location for a data directory. */
export function defaultSocketPath(dataDir: string): string {
  if (platform() === 'win32') return `\\\\.\\pipe\\deaddrop-${hash(dataDir)}`;

  const natural = join(dataDir, 'deaddrop.sock');
  if (Buffer.byteLength(natural) <= MAX_UNIX_SOCKET_PATH_BYTES) return natural;

  // The data directory is nested too deep to hold its own socket, which is
  // reachable straight from the quick start: `ddrop init` writes a relative
  // `.deaddrop` that resolves against the working directory. Fall back to a
  // short path keyed by a hash of the data directory, the same shape as the
  // Windows pipe name above. Deterministic, so the runtime and every client
  // command derive it identically and discovery keeps working unchanged.
  const short = join(tmpdir(), `deaddrop-${hash(dataDir)}.sock`);
  if (Buffer.byteLength(short) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new DeadDropError(
      'CONFIG_INVALID',
      `no usable control socket path: "${natural}" exceeds the ${MAX_UNIX_SOCKET_PATH_BYTES}-byte limit and the fallback under ${tmpdir()} does too. Pass --socket with a shorter path, or set TMPDIR to a shorter directory.`,
    );
  }
  return short;
}

function hash(value: string): string {
  let out = 0;
  for (let i = 0; i < value.length; i++) out = (out * 31 + value.charCodeAt(i)) >>> 0;
  return out.toString(16);
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export async function startControlPlane(options: ControlPlaneOptions): Promise<ControlPlaneHandle> {
  const { runtime, socketPath, logger } = options;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      const deadDropError = DeadDropError.from(error);
      send(response, statusForError(deadDropError), { error: deadDropError.toJSON() });
    });
  });

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://deaddrop.local');
    const path = url.pathname;
    const method = request.method ?? 'GET';

    if (method === 'GET' && path === '/health') {
      send(response, 200, { ok: true, version: runtime.status().version });
      return;
    }
    if (method === 'GET' && path === '/status') {
      send(response, 200, runtime.status());
      return;
    }
    if (method === 'GET' && path === '/metrics') {
      response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      response.end(runtime.metrics.toPrometheus());
      return;
    }
    if (method === 'GET' && path === '/logs') {
      const limit = Number(url.searchParams.get('limit') ?? '100');
      const level = url.searchParams.get('level') ?? undefined;
      send(response, 200, {
        records: runtime.logs({
          limit: Number.isFinite(limit) ? limit : 100,
          ...(level ? { level: level as 'info' } : {}),
        }),
      });
      return;
    }
    if (method === 'GET' && path === '/workspaces') {
      send(response, 200, { workspaces: runtime.list() });
      return;
    }
    if (method === 'GET' && path === '/transports') {
      const workspace = resolveWorkspace(runtime, url);
      send(response, 200, { transports: workspace.transports() });
      return;
    }
    if (method === 'GET' && path === '/peers') {
      const workspace = resolveWorkspace(runtime, url);
      const includeStale = url.searchParams.get('stale') === 'true';
      // `peers` keeps its shape; `read` and `unreadable` are additive, so an
      // older client reading only `peers` is unaffected.
      send(response, 200, await workspace.discoverPeers({ includeStale }));
      return;
    }
    if (method === 'GET' && path === '/queues') {
      const workspace = resolveWorkspace(runtime, url);
      send(response, 200, await workspace.queues());
      return;
    }
    if (method === 'GET' && path === '/traces') {
      const traceId = url.searchParams.get('id');
      send(response, 200, {
        spans: traceId ? runtime.tracer.trace(traceId) : runtime.tracer.spans().slice(-100),
      });
      return;
    }
    if (method === 'POST' && path === '/expose') {
      const body = await readJson(request, maxBodyBytes);
      const workspace = resolveWorkspace(runtime, url);
      const handle = runtime.addExposure(workspace.name, body as never);
      // `peerId` so the caller can print the command the other side runs.
      // Finding it used to mean a second command, and it is the address peers
      // actually write to, which is the same string `ddrop discover` lists.
      send(response, 201, { name: handle.name, channel: handle.channel, peerId: workspace.peerId });
      return;
    }
    if (method === 'GET' && path === '/enrollment') {
      const workspace = resolveWorkspace(runtime, url);
      send(response, 200, await workspace.enrollment());
      return;
    }
    if (method === 'POST' && path === '/enrollment/approve') {
      const body = (await readJson(request, maxBodyBytes)) as {
        peerId?: string;
        fingerprint?: string;
      };
      if (typeof body.peerId !== 'string' || typeof body.fingerprint !== 'string') {
        throw new DeadDropError('BAD_REQUEST', 'approving requires peerId and fingerprint');
      }
      const workspace = resolveWorkspace(runtime, url);
      send(response, 200, await workspace.approve(body.peerId, body.fingerprint));
      return;
    }
    if (method === 'POST' && path === '/enrollment/revoke') {
      const body = (await readJson(request, maxBodyBytes)) as { peerId?: string };
      if (typeof body.peerId !== 'string') {
        throw new DeadDropError('BAD_REQUEST', 'revoking requires peerId');
      }
      const workspace = resolveWorkspace(runtime, url);
      send(response, 200, await workspace.revoke(body.peerId));
      return;
    }
    if (method === 'POST' && path === '/rotate') {
      const workspace = resolveWorkspace(runtime, url);
      send(response, 200, await workspace.rotate());
      return;
    }
    if (method === 'POST' && path === '/publish') {
      const body = (await readJson(request, maxBodyBytes)) as {
        channel?: string;
        payload?: unknown;
      };
      if (typeof body.channel !== 'string') {
        throw new DeadDropError('BAD_REQUEST', 'publish requires a channel');
      }
      const workspace = resolveWorkspace(runtime, url);
      const id = await workspace.publish(body.channel, encodeJson(body.payload ?? null));
      send(response, 202, { id });
      return;
    }
    if (method === 'POST' && path === '/call') {
      const body = (await readJson(request, maxBodyBytes)) as {
        target?: string;
        channel?: string;
        input?: unknown;
        timeoutMs?: number;
      };
      if (typeof body.target !== 'string' || typeof body.channel !== 'string') {
        throw new DeadDropError('BAD_REQUEST', 'call requires target and channel');
      }
      const workspace = resolveWorkspace(runtime, url);
      const result = await workspace.call(body.target, body.channel, body.input ?? null, {
        ...(typeof body.timeoutMs === 'number' ? { timeoutMs: body.timeoutMs } : {}),
      });
      send(response, 200, { result });
      return;
    }

    throw new DeadDropError('NOT_FOUND', `no control plane route for ${method} ${path}`);
  }

  if (!socketPath.startsWith('\\\\')) {
    await mkdir(dirname(socketPath), { recursive: true });
    // A stale socket from a killed process would make listen fail with EADDRINUSE.
    await rm(socketPath, { force: true });
  }
  server.listen(socketPath);
  await once(server, 'listening');
  if (!socketPath.startsWith('\\\\')) {
    // Owner-only: the socket is the door to every workspace secret.
    await chmod(socketPath, 0o600).catch(() => undefined);
  }
  logger.info('control plane listening', { socketPath });

  return {
    socketPath,
    close: async () => {
      await closeServer(server as Server);
      if (!socketPath.startsWith('\\\\')) await rm(socketPath, { force: true });
    },
  };
}

function resolveWorkspace(runtime: DeadDropRuntime, url: URL) {
  const name = url.searchParams.get('workspace');
  return name ? runtime.workspace(name) : runtime.defaultWorkspace();
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).length;
    if (total > limit) {
      request.destroy();
      throw new DeadDropError('PAYLOAD_TOO_LARGE', `control request exceeds ${limit} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return decodeJson(new Uint8Array(Buffer.concat(chunks)));
}

/** Minimal client for the control plane, used by the CLI and the SDK. */
export class ControlPlaneClient {
  constructor(private readonly socketPath: string) {}

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    const { request: httpRequest } = await import('node:http');
    return new Promise<T>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const clientRequest = httpRequest(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {},
          timeout: options.timeoutMs ?? 120_000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const contentType = response.headers['content-type'] ?? '';
            if (!contentType.includes('json')) {
              if ((response.statusCode ?? 500) >= 400) {
                reject(new DeadDropError('INTERNAL', text.slice(0, 500)));
                return;
              }
              resolve(text as T);
              return;
            }
            let parsed: unknown;
            try {
              parsed = text.length > 0 ? JSON.parse(text) : {};
            } catch (cause) {
              reject(
                new DeadDropError('DECODE_FAILED', 'control plane returned invalid JSON', {
                  cause,
                }),
              );
              return;
            }
            if ((response.statusCode ?? 500) >= 400) {
              const error = (parsed as { error?: unknown }).error;
              reject(DeadDropError.fromJSON(error));
              return;
            }
            resolve(parsed as T);
          });
        },
      );
      clientRequest.on('timeout', () => {
        clientRequest.destroy();
        reject(new DeadDropError('TIMEOUT', `control plane did not answer ${method} ${path}`));
      });
      clientRequest.on('error', (error) => {
        reject(
          new DeadDropError(
            'NO_TRANSPORT_AVAILABLE',
            `cannot reach the dead-drop runtime at ${this.socketPath}. Is "ddrop start" running?`,
            { cause: error },
          ),
        );
      });
      if (payload) clientRequest.write(payload);
      clientRequest.end();
    });
  }
}
