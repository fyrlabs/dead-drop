/**
 * JSON payload helpers.
 *
 * Bridge payloads are bytes. Requests, responses and events raised through the
 * SDK are JSON by default, so encoding lives here rather than being repeated in
 * every caller.
 */

import { BridgeError } from './errors.js';

export const JSON_CONTENT_TYPE = 'application/json';

export function encodeJson(value: unknown): Uint8Array {
  let text: string;
  try {
    text = JSON.stringify(value ?? null);
  } catch (cause) {
    throw new BridgeError('BAD_REQUEST', 'value is not JSON-serialisable', { cause });
  }
  if (text === undefined) {
    throw new BridgeError('BAD_REQUEST', 'value is not JSON-serialisable');
  }
  return Buffer.from(text, 'utf8');
}

export function decodeJson<T = unknown>(payload: Uint8Array): T {
  if (payload.length === 0) return null as T;
  try {
    return JSON.parse(Buffer.from(payload).toString('utf8')) as T;
  } catch (cause) {
    throw new BridgeError('DECODE_FAILED', 'payload is not valid JSON', { cause });
  }
}

/** Wire shape of an RPC or HTTP failure carried in a `response` envelope. */
export interface ErrorPayload {
  error: {
    code: string;
    message: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
    retryAfterMs?: number;
  };
}

export function isErrorPayload(value: unknown): value is ErrorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ErrorPayload).error === 'object' &&
    (value as ErrorPayload).error !== null &&
    typeof (value as ErrorPayload).error.code === 'string'
  );
}
