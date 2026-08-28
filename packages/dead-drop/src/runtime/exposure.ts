/**
 * Exposures: making an existing application reachable over dead-drop.
 *
 * This is the zero-code path from the blueprint. `ddrop expose --target
 * http://localhost:3000` registers a request handler on the channel
 * `http/<name>`; a remote peer sends an encoded HTTP request there and gets an
 * encoded HTTP response back. The target Express/Next/whatever app is never
 * told any of this happened.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';

import {
  DeadDropError,
  HTTP_RESPONSE_CONTENT_TYPE,
  decodeHttpRequest,
  encodeHttpResponse,
  sanitiseHeaders,
  type HttpRequestMessage,
  type HttpResponseMessage,
} from '../protocol/index.js';
import {
  HTTP_STREAM_OFFER_HEADER,
  HTTP_STREAM_PART_CONTENT_TYPE,
  encodeHttpStreamHead,
  encodeHttpStreamPart,
  httpStreamChannel,
  type HttpStreamHead,
} from '../protocol/stream.js';
import type { Logger } from '../core/index.js';

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
const DEFAULT_STREAM_THRESHOLD_BYTES = 1024 * 1024;

export function registerExposure(
  workspace: Workspace,
  config: ExposureConfig,
  options: ExposureOptions,
): ExposureHandle {
  const channel = httpChannel(config.name);
  const logger = options.logger.child({ exposure: config.name, type: config.type });
  const handler =
    config.type === 'http'
      ? httpProxyHandler(config, { ...options, logger, workspace })
      : staticHandler(config, { ...options, logger });

  const stop = workspace.handle(channel, async (payload, context) => {
    // `context.identity`, never `context.from`. A `ddrop connect` client runs
    // its own runtime with a per-process mailbox address, so matching on `from`
    // meant an `allowPeers` list could never name the one thing a user actually
    // has: the peer id in their config. The list denied everyone, which failed
    // safe and made the feature useless.
    if (config.allowPeers && !config.allowPeers.includes(context.identity)) {
      logger.warn('rejecting request from a peer that is not allowed', {
        identity: context.identity,
        from: context.from,
      });
      return encodeHttpResponse({
        status: 403,
        statusText: 'Forbidden',
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('This exposure does not accept requests from your peer.'),
      });
    }
    const request = decodeHttpRequest(payload);
    const reply = await handler(request, context);
    if (!('pump' in reply)) return encodeHttpResponse(reply);

    // The head is this handler's return value, so the workspace sends it once
    // we return. Pumping is therefore started and deliberately not awaited:
    // awaiting it would hold the head back until the last byte, which is the
    // thing streaming exists to avoid. Parts may still overtake the head on the
    // wire, which is why the caller names the stream id in its request and has
    // its reader listening before any of this runs.
    void reply.pump().catch((error: unknown) => {
      logger.warn('streamed response failed after the head was sent', {
        streamId: reply.head.streamId,
        error: String((error as Error)?.message ?? error),
      });
    });
    return encodeHttpStreamHead(reply.head);
  });

  workspace.registerExposure(config.name);
  logger.info('exposure registered', { channel });
  return { name: config.name, channel, stop };
}

/** Content type a caller should expect back from an exposure. */
export const EXPOSURE_RESPONSE_CONTENT_TYPE = HTTP_RESPONSE_CONTENT_TYPE;

/**
 * A response whose body follows the head as separate messages.
 *
 * `pump` is started by `registerExposure` after the head has been handed back,
 * never before, and it owns every part from the first chunk to the `end`.
 */
interface StreamedReply {
  head: HttpStreamHead;
  pump(): Promise<void>;
}

type Handler = (
  request: HttpRequestMessage,
  context: RequestContext,
) => Promise<HttpResponseMessage | StreamedReply>;

function httpProxyHandler(
  config: ExposureConfig,
  options: ExposureOptions & { logger: Logger; workspace: Workspace },
): Handler {
  const target = new URL(config.target as string);
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const streaming = config.streaming?.enabled === true;
  const thresholdBytes = config.streaming?.thresholdBytes ?? DEFAULT_STREAM_THRESHOLD_BYTES;

  return async (request, context) => {
    // Ask the target for identity, whatever the browser asked us for. `fetch`
    // decodes a compressed response before `arrayBuffer` sees it but leaves
    // `content-encoding` on the headers, so proxying both through means a
    // browser is handed plaintext labelled gzip and fails the page with
    // ERR_CONTENT_DECODING_FAILED. Nothing is lost on the wire: `frame.ts`
    // already gzips any payload over 1 KiB where that shrinks it, so the bytes
    // are compressed for the hop that is actually slow.
    const headers = toFetchHeaders(request.headers);
    headers.set('accept-encoding', 'identity');

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
    // The timeout bounds how long the target may take to answer, not how long
    // its body may take to arrive. Once we have decided to stream, the whole
    // point is a response that outlives this deadline, so the timeout stops
    // being allowed to abort it. Bounding an open stream belongs to the
    // cancellation slice, not here.
    let handedOff = false;
    timeout.addEventListener(
      'abort',
      () => {
        if (!handedOff) controller.abort();
      },
      { once: true },
    );
    try {
      const upstream = await fetchImpl(url, {
        method: request.method,
        headers,
        ...(request.body.length > 0 ? { body: Buffer.from(request.body) } : {}),
        signal: controller.signal,
        redirect: 'manual',
      });

      const streamId = streamIdOffered(request.headers);
      if (streaming && streamId && upstream.body && shouldStream(upstream, thresholdBytes)) {
        handedOff = true;
        const head: HttpStreamHead = {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: withoutContentEncoding(Object.fromEntries(upstream.headers.entries())),
          streamId,
        };
        const body = upstream.body;
        options.logger.debug('streaming the response body', {
          streamId,
          path: request.path,
          status: upstream.status,
        });
        return {
          head,
          pump: () =>
            pumpBody(body, async (payload) => {
              await options.workspace.sendTo(context.from, httpStreamChannel(streamId), payload, {
                contentType: HTTP_STREAM_PART_CONTENT_TYPE,
              });
            }),
        };
      }

      const buffer = new Uint8Array(await upstream.arrayBuffer());
      if (buffer.length > maxBodyBytes) {
        return textResponse(502, `upstream response exceeds ${maxBodyBytes} bytes`);
      }
      return {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: withoutContentEncoding(Object.fromEntries(upstream.headers.entries())),
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
        : textResponse(502, 'The exposed target is not reachable from the dead-drop runtime.');
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

/**
 * Response headers with `content-encoding` dropped, on top of the usual
 * hop-by-hop strip.
 *
 * A belt to the `accept-encoding: identity` braces above: a target that
 * compresses anyway, or serves a pre-compressed asset regardless of what was
 * asked for, would still hand back a header describing an encoding that `fetch`
 * has already undone. This is deliberately not folded into `sanitiseHeaders`,
 * which also runs over *requests* in `connect.ts`, where a client's gzipped
 * body makes `content-encoding` true and load-bearing.
 */
function withoutContentEncoding(
  headers: Record<string, string | string[] | number | undefined>,
): Record<string, string | string[]> {
  const out = sanitiseHeaders(headers);
  delete out['content-encoding'];
  return out;
}

function toFetchHeaders(headers: Record<string, string | string[]>): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const item of value) out.append(name, item);
    else out.set(name, value);
  }
  return out;
}

/** The stream id a caller offered, if it offered one and it is usable. */
function streamIdOffered(headers: Record<string, string | string[]>): string | undefined {
  const raw = headers[HTTP_STREAM_OFFER_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  // The id ends up in a channel name, so anything outside the alphabet is
  // dropped rather than sanitised: a caller that sent a bad id is not listening
  // on whatever we would have corrected it to, and gets a buffered reply.
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : undefined;
}

/**
 * Whether this response is worth streaming.
 *
 * An event stream never ends, and a body with no declared length may not
 * either, so both stream regardless of size. A declared length is compared
 * against the threshold, which keeps small responses on the single-message path
 * they already work well on.
 */
function shouldStream(upstream: Response, thresholdBytes: number): boolean {
  const contentType = upstream.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) return true;
  const declared = upstream.headers.get('content-length');
  if (declared === null) return true;
  const length = Number(declared);
  return Number.isFinite(length) && length >= thresholdBytes;
}

/**
 * Reads a body and sends it as numbered parts, ending with `end` or `error`.
 *
 * `end` carries the sequence number after the last chunk, so a reader knows the
 * stream is complete without a separate count that could disagree with what it
 * received. A failure mid-body is reported as an `error` part, because a caller
 * that is handed a truncated body with no explanation cannot tell it from a
 * short one. If even that send fails there is nothing left to try, and the
 * reader's gap timeout is what ends the stream.
 */
async function pumpBody(
  body: ReadableStream<Uint8Array>,
  send: (payload: Uint8Array) => Promise<void>,
): Promise<void> {
  const reader = body.getReader();
  let seq = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        await send(encodeHttpStreamPart({ kind: 'chunk', seq, body: value }));
        seq += 1;
      }
    }
    await send(encodeHttpStreamPart({ kind: 'end', seq }));
  } catch (error) {
    const failure = DeadDropError.from(error, 'TRANSPORT_ERROR');
    await send(
      encodeHttpStreamPart({
        kind: 'error',
        seq,
        code: failure.code,
        message: failure.message,
      }),
    );
  } finally {
    reader.releaseLock();
  }
}

function textResponse(status: number, message: string): HttpResponseMessage {
  return {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: new Uint8Array(Buffer.from(message, 'utf8')),
  };
}

/** Turns a dead-drop error into the HTTP status a caller should see. */
export function statusForError(error: DeadDropError): number {
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
