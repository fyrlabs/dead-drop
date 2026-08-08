/**
 * HTTP <-> Bridge mapping.
 *
 * This is the payload shape used by proxy mode (`bridge expose --target`). The
 * body travels as raw bytes appended after a JSON head rather than base64
 * inside it, so proxying a 10 MB response does not cost 13 MB on the wire.
 *
 * ```text
 *   u32be(headLen) || headJson || bodyBytes
 * ```
 */

import { BridgeError } from './errors.js';

/** Header names Bridge strips: they describe the hop, not the message. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

export interface HttpRequestHead {
  method: string;
  /** Path plus query string, always starting with `/`. */
  path: string;
  headers: Record<string, string | string[]>;
}

export interface HttpResponseHead {
  status: number;
  statusText?: string;
  headers: Record<string, string | string[]>;
}

export interface HttpRequestMessage extends HttpRequestHead {
  body: Uint8Array;
}

export interface HttpResponseMessage extends HttpResponseHead {
  body: Uint8Array;
}

export const HTTP_REQUEST_CONTENT_TYPE = 'application/vnd.bridge.http-request';
export const HTTP_RESPONSE_CONTENT_TYPE = 'application/vnd.bridge.http-response';

export function encodeHttpRequest(message: HttpRequestMessage): Uint8Array {
  return encodePart(
    { method: message.method, path: message.path, headers: sanitiseHeaders(message.headers) },
    message.body,
  );
}

export function decodeHttpRequest(payload: Uint8Array): HttpRequestMessage {
  const { head, body } = decodePart(payload);
  if (typeof head.method !== 'string' || !/^[A-Z]{3,20}$/.test(head.method)) {
    throw new BridgeError('BAD_REQUEST', 'http request method is invalid');
  }
  if (typeof head.path !== 'string' || !head.path.startsWith('/')) {
    throw new BridgeError('BAD_REQUEST', 'http request path must start with /');
  }
  return { method: head.method, path: head.path, headers: readHeaders(head.headers), body };
}

export function encodeHttpResponse(message: HttpResponseMessage): Uint8Array {
  const head: HttpResponseHead = {
    status: message.status,
    headers: sanitiseHeaders(message.headers),
  };
  if (message.statusText) head.statusText = message.statusText;
  return encodePart(head, message.body);
}

export function decodeHttpResponse(payload: Uint8Array): HttpResponseMessage {
  const { head, body } = decodePart(payload);
  const status = head.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    throw new BridgeError('DECODE_FAILED', 'http response status is out of range');
  }
  const message: HttpResponseMessage = { status, headers: readHeaders(head.headers), body };
  if (typeof head.statusText === 'string') message.statusText = head.statusText;
  return message;
}

/** Drops hop-by-hop headers and normalises names to lower case. */
export function sanitiseHeaders(
  headers: Record<string, string | string[] | number | undefined>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name)) continue;
    out[name] = typeof value === 'number' ? String(value) : value;
  }
  return out;
}

function encodePart(head: unknown, body: Uint8Array): Uint8Array {
  const json = Buffer.from(JSON.stringify(head), 'utf8');
  const out = Buffer.allocUnsafe(4 + json.length + body.length);
  out.writeUInt32BE(json.length, 0);
  json.copy(out, 4);
  out.set(body, 4 + json.length);
  return out;
}

function decodePart(payload: Uint8Array): { head: Record<string, unknown>; body: Uint8Array } {
  const buf = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (buf.length < 4) throw new BridgeError('DECODE_FAILED', 'truncated http message');
  const headLen = buf.readUInt32BE(0);
  if (headLen > buf.length - 4) {
    throw new BridgeError('DECODE_FAILED', 'http message head length out of range');
  }
  let head: unknown;
  try {
    head = JSON.parse(buf.subarray(4, 4 + headLen).toString('utf8'));
  } catch (cause) {
    throw new BridgeError('DECODE_FAILED', 'http message head is not valid JSON', { cause });
  }
  if (typeof head !== 'object' || head === null || Array.isArray(head)) {
    throw new BridgeError('DECODE_FAILED', 'http message head is not an object');
  }
  return { head: head as Record<string, unknown>, body: new Uint8Array(buf.subarray(4 + headLen)) };
}

function readHeaders(value: unknown): Record<string, string | string[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BridgeError('DECODE_FAILED', 'http headers must be an object');
  }
  const out: Record<string, string | string[]> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') {
      out[name] = raw;
    } else if (Array.isArray(raw) && raw.every((item) => typeof item === 'string')) {
      out[name] = raw as string[];
    } else {
      throw new BridgeError('DECODE_FAILED', `http header ${name} must be a string or string[]`);
    }
  }
  return out;
}
