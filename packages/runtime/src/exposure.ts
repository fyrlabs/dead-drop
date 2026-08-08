/**
 * Exposures: making an existing application reachable over Bridge.
 *
 * This is the zero-code path from the blueprint. `bridge expose --target
 * http://localhost:3000` registers a request handler on the channel
 * `http/<name>`; a remote peer sends an encoded HTTP request there and gets an
 * encoded HTTP response back. The target Express/Next/whatever app is never
 * told any of this happened.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';

import {
  HTTP_RESPONSE_CONTENT_TYPE,
  decodeHttpRequest,
  encodeHttpResponse,
  sanitiseHeaders,
  type HttpRequestMessage,
  type HttpResponseMessage,
} from '@fyrlabs/dead-drop-protocol';
import type { BridgeError } from '@fyrlabs/dead-drop-protocol';
import type { Logger } from '@fyrlabs/dead-drop-core';

import type { ExposureConfig } from './config.js';
import type { RequestContext, Workspace } from './workspace.js';

export const httpChannel = (name: string): string => `http/${name}`;

export interface ExposureHandle {
  name: string;
  channel: string;
  stop(): void;
}

export interface ExposureOptions {
  logger: Logger;
  /** Injected so tests do not need a live server. */
  fetchImpl?: typeof fetch;
  /** Largest response body proxied back. Default 32 MiB. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export function registerExposure(
  workspace: Workspace,
  config: ExposureConfig,
  options: ExposureOptions,
): ExposureHandle {
  const channel = httpChannel(config.name);
  const logger = options.logger.child({ exposure: config.name, type: config.type });
  const handler =
    config.type === 'http'
      ? httpProxyHandler(config, { ...options, logger })
      : staticHandler(config, { ...options, logger });

  const stop = workspace.handle(channel, async (payload, context) => {
    if (config.allowPeers && !config.allowPeers.includes(context.from)) {
      logger.warn('rejecting request from a peer that is not allowed', { from: context.from });
      return encodeHttpResponse({
        status: 403,
        statusText: 'Forbidden',
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('This exposure does not accept requests from your peer.'),
      });
    }
    const request = decodeHttpRequest(payload);
    const response = await handler(request, context);
    return encodeHttpResponse(response);
  });

  workspace.registerExposure(config.name);
  logger.info('exposure registered', { channel });
  return { name: config.name, channel, stop };
}

/** Content type a caller should expect back from an exposure. */
export const EXPOSURE_RESPONSE_CONTENT_TYPE = HTTP_RESPONSE_CONTENT_TYPE;

type Handler = (
  request: HttpRequestMessage,
  context: RequestContext,
) => Promise<HttpResponseMessage>;

function httpProxyHandler(
  config: ExposureConfig,
  options: ExposureOptions & { logger: Logger },
): Handler {
  const target = new URL(config.target as string);
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (request) => {
    // Build the upstream URL from the origin plus the requested path. Using the
    // URL constructor with the path as-is means a path like `//evil.com` cannot
    // redirect the request to another host.
    const url = new URL(target.toString());
    const [pathname, search = ''] = splitPath(request.path);
    url.pathname = joinPath(target.pathname, pathname);
    url.search = search;

    // AbortSignal.timeout rather than a manual timer: no handle to leak and no
    // lint exception for a bare global timer in runtime code.
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(timeoutMs);
    timeout.addEventListener('abort', () => controller.abort(), { once: true });
    try {
      const upstream = await fetchImpl(url, {
        method: request.method,
        headers: toFetchHeaders(request.headers),
        ...(request.body.length > 0 ? { body: Buffer.from(request.body) } : {}),
        signal: controller.signal,
        redirect: 'manual',
      });

      const buffer = new Uint8Array(await upstream.arrayBuffer());
      if (buffer.length > maxBodyBytes) {
        return textResponse(502, `upstream response exceeds ${maxBodyBytes} bytes`);
      }
      return {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: sanitiseHeaders(Object.fromEntries(upstream.headers.entries())),
        body: buffer,
      };
    } catch (error) {
      const aborted = (error as Error)?.name === 'AbortError';
      options.logger.warn('proxy request to the local target failed', {
        method: request.method,
        path: request.path,
        error: String((error as Error)?.message ?? error),
      });
      return aborted
        ? textResponse(504, `The exposed target did not respond within ${timeoutMs}ms.`)
        : textResponse(502, 'The exposed target is not reachable from the Bridge runtime.');
    }
  };
}

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
};

function staticHandler(
  config: ExposureConfig,
  options: ExposureOptions & { logger: Logger },
): Handler {
  const root = resolve(config.directory as string);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return textResponse(405, 'Only GET and HEAD are supported for static exposures.');
    }
    const [rawPath] = splitPath(request.path);
    const decoded = safeDecode(rawPath);
    if (decoded === undefined) return textResponse(400, 'Malformed path.');

    const candidate = resolveWithinRoot(root, decoded);
    if (!candidate) {
      // Traversal attempt, or a path that normalises outside the root.
      options.logger.warn('rejected static path outside the exposure root', { path: request.path });
      return textResponse(403, 'Forbidden.');
    }

    let filePath = candidate;
    let info = await stat(filePath).catch(() => undefined);
    if (info?.isDirectory()) {
      filePath = join(filePath, 'index.html');
      info = await stat(filePath).catch(() => undefined);
    }
    if (!info?.isFile()) return textResponse(404, 'Not found.');
    if (info.size > maxBodyBytes) return textResponse(413, 'File is too large to serve.');

    const extension = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    const headers: Record<string, string> = {
      'content-type': MIME_TYPES[extension] ?? 'application/octet-stream',
      'content-length': String(info.size),
      'last-modified': new Date(info.mtimeMs).toUTCString(),
      etag: `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`,
    };
    if (request.method === 'HEAD') return { status: 200, headers, body: new Uint8Array(0) };

    const chunks: Buffer[] = [];
    for await (const chunk of createReadStream(filePath)) chunks.push(chunk as Buffer);
    return { status: 200, headers, body: new Uint8Array(Buffer.concat(chunks)) };
  };
}

/** Resolves `path` under `root`, returning undefined if it would escape. */
export function resolveWithinRoot(root: string, path: string): string | undefined {
  // The containment check compares two absolute paths, so the root has to be
  // resolved here rather than trusted from the caller: a relative root, a
  // trailing separator, or a Windows path without its drive letter would all
  // make the comparison below reject paths that are genuinely inside it.
  const base = resolve(root);
  const normalised = normalize(path).replace(/^([/\\])+/, '');
  if (normalised.split(/[/\\]/).includes('..')) return undefined;
  const candidate = resolve(base, normalised);
  if (candidate !== base && !candidate.startsWith(base + sep)) return undefined;
  return candidate;
}

function safeDecode(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.includes('\0') ? undefined : decoded;
  } catch {
    return undefined;
  }
}

function splitPath(path: string): [string, string?] {
  const index = path.indexOf('?');
  return index < 0 ? [path] : [path.slice(0, index), path.slice(index)];
}

function joinPath(base: string, path: string): string {
  const left = base.endsWith('/') ? base.slice(0, -1) : base;
  const right = path.startsWith('/') ? path : `/${path}`;
  return `${left}${right}` || '/';
}

function toFetchHeaders(headers: Record<string, string | string[]>): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const item of value) out.append(name, item);
    else out.set(name, value);
  }
  return out;
}

function textResponse(status: number, message: string): HttpResponseMessage {
  return {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: new Uint8Array(Buffer.from(message, 'utf8')),
  };
}

/** Turns a Bridge error into the HTTP status a caller should see. */
export function statusForError(error: BridgeError): number {
  switch (error.code) {
    case 'BAD_REQUEST':
      return 400;
    case 'UNAUTHORIZED':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'TIMEOUT':
      return 504;
    case 'PAYLOAD_TOO_LARGE':
      return 413;
    case 'RATE_LIMITED':
      return 429;
    case 'NO_TRANSPORT_AVAILABLE':
    case 'TRANSPORT_ERROR':
      return 502;
    default:
      return 500;
  }
}
