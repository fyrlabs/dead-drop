/**
 * The consuming half of proxy mode.
 *
 * `bridge connect my-api` starts a local HTTP server; every request it receives
 * is packed into a Bridge request, carried by whatever transport is configured,
 * answered by the remote runtime's exposure, and unpacked back into an HTTP
 * response. A browser or curl on this machine sees an ordinary local server.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';

import {
  BridgeError,
  HTTP_REQUEST_CONTENT_TYPE,
  decodeHttpResponse,
  encodeHttpRequest,
  sanitiseHeaders,
} from '@dead-drop/protocol';
import type { Logger } from '@dead-drop/core';

import { httpChannel, statusForError } from './exposure.js';
import type { Workspace } from './workspace.js';

export interface ConnectOptions {
  workspace: Workspace;
  /** Peer that hosts the exposure. */
  target: string;
  /** Exposure name on the remote peer. */
  exposure: string;
  /** Local port. 0 asks the OS for a free one. */
  port?: number;
  host?: string;
  logger: Logger;
  /** Per-request timeout. Default 60s: a transport hop can be slow. */
  timeoutMs?: number;
  /** Largest request body accepted from a local client. Default 32 MiB. */
  maxBodyBytes?: number;
}

export interface ConnectHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

export async function connect(options: ConnectOptions): Promise<ConnectHandle> {
  const logger = options.logger.child({ connect: options.exposure, target: options.target });
  const channel = httpChannel(options.exposure);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      logger.error('failed to answer a local request', { error: String(error) });
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('Bridge failed to answer this request.');
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request, maxBodyBytes);
    if (body === undefined) {
      response.writeHead(413, { 'content-type': 'text/plain' });
      response.end('Request body is too large.');
      return;
    }

    const payload = encodeHttpRequest({
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      headers: sanitiseHeaders(request.headers as Record<string, string | string[] | undefined>),
      body,
    });

    try {
      const envelope = await options.workspace.request(options.target, channel, payload, {
        timeoutMs,
        contentType: HTTP_REQUEST_CONTENT_TYPE,
      });
      const remote = decodeHttpResponse(envelope.payload);
      response.writeHead(remote.status, remote.statusText, remote.headers);
      response.end(Buffer.from(remote.body));
    } catch (error) {
      const bridgeError = BridgeError.from(error);
      logger.warn('remote request failed', {
        method: request.method,
        path: request.url,
        code: bridgeError.code,
        error: bridgeError.message,
      });
      // Surfacing the Bridge error code as an HTTP status keeps the failure
      // legible to a browser without leaking transport detail into the body.
      response.writeHead(statusForError(bridgeError), { 'content-type': 'text/plain' });
      response.end(
        `Bridge could not reach ${options.target}/${options.exposure}: ${bridgeError.code}`,
      );
    }
  }

  const host = options.host ?? '127.0.0.1';
  server.listen(options.port ?? 0, host);
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);
  const url = `http://${host}:${port}`;
  logger.info('local endpoint ready', { url });

  return {
    url,
    port,
    close: () => closeServer(server),
  };
}

async function readBody(request: IncomingMessage, limit: number): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).length;
    if (total > limit) {
      request.destroy();
      return undefined;
    }
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    // Idle keep-alive sockets would otherwise hold the process open.
    server.closeIdleConnections?.();
  });
}
