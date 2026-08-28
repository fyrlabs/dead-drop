/**
 * Streamed HTTP responses.
 *
 * `http.ts` carries a response as one payload, which is right until the body is
 * large or never ends. This module is the wire format for the other case: the
 * head travels as the ordinary reply to the request, naming a `streamId`, and
 * the body follows as separate messages on `httpstream/<streamId>`.
 *
 * Every part carries its own sequence number rather than trusting the order it
 * arrives in. `docs/guarantees.md` states that ordering is best-effort, because
 * a failed handler is retried with backoff while the poller moves on, and that
 * anything needing strict order should number its payloads and reorder on
 * receipt. This does exactly that instead of quietly assuming FIFO.
 */

import { DeadDropError } from './errors.js';
import { decodePart, encodePart, sanitiseHeaders, type HttpResponseHead } from './http.js';
import { createPrefixedId } from './ids.js';

export const HTTP_STREAM_HEAD_CONTENT_TYPE = 'application/vnd.deaddrop.http-stream-head';
export const HTTP_STREAM_PART_CONTENT_TYPE = 'application/vnd.deaddrop.http-stream-part';

/**
 * Request header by which a caller offers to receive a streamed response, and
 * names the id it will listen on.
 *
 * The caller picks the id, not the sender, so that it can register its handler
 * before the request goes out. If the sender picked it, the id would only reach
 * the caller in the response head, and any part that overtook the head would
 * arrive for a stream nobody was listening to yet. It doubles as capability
 * negotiation: a caller that does not send this header cannot be sent a stream.
 */
export const HTTP_STREAM_OFFER_HEADER = 'x-deaddrop-stream';

/** Channel the body parts of one stream travel on. */
export const httpStreamChannel = (streamId: string): string => `httpstream/${streamId}`;

/**
 * Channel a caller uses to tell the sender it has stopped reading.
 *
 * Without it a browser tab closing leaves the exposure pumping a body nobody
 * will ever read, which on the git transport is a push per chunk. Channels are
 * matched exactly, so this never collides with the body channel above.
 */
export const httpStreamCancelChannel = (streamId: string): string =>
  `httpstream/${streamId}/cancel`;

/** A fresh stream id in the accepted alphabet. */
export const createStreamId = (): string => createPrefixedId('str');

export interface HttpStreamHead extends HttpResponseHead {
  /** Names the channel the body will arrive on. */
  streamId: string;
}

/**
 * One part of a body.
 *
 * `end` occupies a sequence number of its own, so its `seq` is also the number
 * of chunks that came before it. A reader therefore knows a stream is complete
 * without a separate count that could disagree with what it received.
 */
export type HttpStreamPart =
  | { kind: 'chunk'; seq: number; body: Uint8Array }
  | { kind: 'end'; seq: number }
  | { kind: 'error'; seq: number; code: string; message: string };

/** Stream ids appear in a channel name, so they are constrained like one. */
const STREAM_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function encodeHttpStreamHead(head: HttpStreamHead): Uint8Array {
  if (!STREAM_ID.test(head.streamId)) {
    throw new DeadDropError('BAD_REQUEST', 'stream id is not in the accepted alphabet');
  }
  const out: Record<string, unknown> = {
    status: head.status,
    streamId: head.streamId,
    headers: sanitiseHeaders(head.headers),
  };
  if (head.statusText) out.statusText = head.statusText;
  return encodePart(out, new Uint8Array(0));
}

export function decodeHttpStreamHead(payload: Uint8Array): HttpStreamHead {
  const { head } = decodePart(payload);
  const status = head.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    throw new DeadDropError('DECODE_FAILED', 'http stream status is out of range');
  }
  const streamId = head.streamId;
  if (typeof streamId !== 'string' || !STREAM_ID.test(streamId)) {
    throw new DeadDropError('DECODE_FAILED', 'http stream head has no usable stream id');
  }
  const result: HttpStreamHead = { status, streamId, headers: readHeaders(head.headers) };
  if (typeof head.statusText === 'string') result.statusText = head.statusText;
  return result;
}

/**
 * Whether a reply is a stream head rather than a whole response.
 *
 * A handler cannot label its own reply: the workspace sets the response content
 * type from the caller's `accept` header, so a stream head and an ordinary
 * response come back wearing the same one. The discriminator is therefore the
 * payload itself, and `streamId` is a field an ordinary response never carries.
 */
export function isHttpStreamHead(payload: Uint8Array): boolean {
  try {
    const { head } = decodePart(payload);
    return typeof head.streamId === 'string' && STREAM_ID.test(head.streamId);
  } catch {
    return false;
  }
}

export function encodeHttpStreamPart(part: HttpStreamPart): Uint8Array {
  if (!Number.isInteger(part.seq) || part.seq < 0) {
    throw new DeadDropError('BAD_REQUEST', 'stream sequence must be a non-negative integer');
  }
  if (part.kind === 'chunk') return encodePart({ kind: 'chunk', seq: part.seq }, part.body);
  if (part.kind === 'end') return encodePart({ kind: 'end', seq: part.seq }, new Uint8Array(0));
  return encodePart(
    { kind: 'error', seq: part.seq, code: part.code, message: part.message },
    new Uint8Array(0),
  );
}

export function decodeHttpStreamPart(payload: Uint8Array): HttpStreamPart {
  const { head, body } = decodePart(payload);
  const seq = head.seq;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
    throw new DeadDropError('DECODE_FAILED', 'stream part sequence is not a non-negative integer');
  }
  switch (head.kind) {
    case 'chunk':
      return { kind: 'chunk', seq, body };
    case 'end':
      return { kind: 'end', seq };
    case 'error':
      // A remote failure has to survive the trip legibly, so both fields are
      // required rather than defaulted: an error part that says nothing is
      // worse than a decode failure, because it looks like a clean end.
      if (typeof head.code !== 'string' || typeof head.message !== 'string') {
        throw new DeadDropError('DECODE_FAILED', 'stream error part is missing code or message');
      }
      return { kind: 'error', seq, code: head.code, message: head.message };
    default:
      throw new DeadDropError('DECODE_FAILED', `unknown stream part kind ${String(head.kind)}`);
  }
}

function readHeaders(value: unknown): Record<string, string | string[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeadDropError('DECODE_FAILED', 'http stream headers must be an object');
  }
  const out: Record<string, string | string[]> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') out[name] = raw;
    else if (Array.isArray(raw) && raw.every((item) => typeof item === 'string')) {
      out[name] = raw as string[];
    } else {
      throw new DeadDropError('DECODE_FAILED', `http stream header ${name} is not a string`);
    }
  }
  return out;
}
