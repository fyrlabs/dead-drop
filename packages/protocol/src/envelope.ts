/**
 * The Bridge envelope: the only thing that ever crosses a transport.
 *
 * Application semantics live in `payload`; everything a runtime needs to route,
 * correlate, deduplicate and expire a message lives in the header. Transports
 * never inspect either — they move opaque frames (see `frame.ts`).
 */

import { BridgeError } from './errors.js';
import { createMessageId, isValidId } from './ids.js';

export const PROTOCOL_VERSION = 1;

export type EnvelopeKind = 'request' | 'response' | 'event' | 'ack' | 'control';

export interface ChunkInfo {
  /** Shared id for every chunk of one logical message. */
  groupId: string;
  /** 0-based position. */
  index: number;
  /** Total number of chunks in the group. */
  count: number;
  /** Byte length of the reassembled payload, used to validate reassembly. */
  totalBytes: number;
}

export interface EnvelopeHeader {
  /** Protocol version. Receivers reject versions they do not implement. */
  v: number;
  id: string;
  /** Milliseconds since the Unix epoch, set by the sender. */
  ts: number;
  workspace: string;
  kind: EnvelopeKind;
  /**
   * Routing key within a workspace: a topic for events, `service.method` for
   * requests, an exposure name for HTTP proxying.
   */
  channel: string;
  /** Peer id of the sender. */
  from: string;
  /** Peer id of the intended recipient; omitted for broadcast events. */
  to?: string;
  /** Id of the message this one answers (responses and acks). */
  correlationId?: string;
  /** Sender-supplied key used to collapse duplicate deliveries. Defaults to `id`. */
  idempotencyKey?: string;
  /** Message is dead once `ts + ttlMs` has passed. */
  ttlMs?: number;
  /** 1-based delivery attempt, incremented by the sender on each retry. */
  attempt?: number;
  /** Media type of `payload`. */
  contentType: string;
  /** Free-form string metadata. Kept small: it is serialised on every hop. */
  headers?: Record<string, string>;
  chunk?: ChunkInfo;
}

export interface Envelope extends EnvelopeHeader {
  payload: Uint8Array;
}

export interface CreateEnvelopeInput extends Omit<
  EnvelopeHeader,
  'v' | 'id' | 'ts' | 'contentType'
> {
  id?: string;
  ts?: number;
  contentType?: string;
  payload?: Uint8Array;
}

const EMPTY = new Uint8Array(0);

export function createEnvelope(input: CreateEnvelopeInput): Envelope {
  const envelope: Envelope = {
    v: PROTOCOL_VERSION,
    id: input.id ?? createMessageId(),
    ts: input.ts ?? Date.now(),
    workspace: input.workspace,
    kind: input.kind,
    channel: input.channel,
    from: input.from,
    contentType: input.contentType ?? 'application/octet-stream',
    payload: input.payload ?? EMPTY,
  };
  if (input.to !== undefined) envelope.to = input.to;
  if (input.correlationId !== undefined) envelope.correlationId = input.correlationId;
  if (input.idempotencyKey !== undefined) envelope.idempotencyKey = input.idempotencyKey;
  if (input.ttlMs !== undefined) envelope.ttlMs = input.ttlMs;
  if (input.attempt !== undefined) envelope.attempt = input.attempt;
  if (input.headers !== undefined) envelope.headers = input.headers;
  if (input.chunk !== undefined) envelope.chunk = input.chunk;
  return envelope;
}

/** The key used for deduplication: explicit idempotency key, else the message id. */
export function dedupeKey(envelope: EnvelopeHeader): string {
  return envelope.idempotencyKey ?? envelope.id;
}

export function isExpired(envelope: EnvelopeHeader, now: number = Date.now()): boolean {
  return envelope.ttlMs !== undefined && envelope.ts + envelope.ttlMs <= now;
}

const KINDS = new Set<string>(['request', 'response', 'event', 'ack', 'control']);
/** Workspace, channel and peer names appear in transport keys, so keep them path-safe. */
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
/** Channels additionally allow `/` so HTTP-ish routing keys work. */
const CHANNEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/;

export function isValidName(value: string): boolean {
  return NAME_PATTERN.test(value) && !value.includes('..');
}

export function isValidChannel(value: string): boolean {
  return CHANNEL_PATTERN.test(value) && !value.includes('..');
}

/**
 * Validates a decoded header. Called on every inbound message, so it must reject
 * anything that could later be interpolated into a transport key or a log line.
 */
export function assertValidHeader(header: unknown): asserts header is EnvelopeHeader {
  if (typeof header !== 'object' || header === null) {
    throw new BridgeError('DECODE_FAILED', 'envelope header is not an object');
  }
  const h = header as Record<string, unknown>;
  const fail = (message: string, details?: Record<string, unknown>): never => {
    throw new BridgeError('DECODE_FAILED', `invalid envelope: ${message}`, { details });
  };

  if (h.v !== PROTOCOL_VERSION) {
    fail(`unsupported protocol version ${String(h.v)}`, { version: h.v });
  }
  if (typeof h.id !== 'string' || !isValidId(h.id.replace(/^[a-z]+_/, ''))) {
    fail('id must be a Bridge identifier');
  }
  if (typeof h.ts !== 'number' || !Number.isFinite(h.ts) || h.ts < 0) {
    fail('ts must be a non-negative finite number');
  }
  if (typeof h.workspace !== 'string' || !isValidName(h.workspace)) fail('workspace name');
  if (typeof h.kind !== 'string' || !KINDS.has(h.kind)) fail(`kind ${String(h.kind)}`);
  if (typeof h.channel !== 'string' || !isValidChannel(h.channel)) fail('channel name');
  if (typeof h.from !== 'string' || !isValidName(h.from)) fail('from peer name');
  if (h.to !== undefined && (typeof h.to !== 'string' || !isValidName(h.to))) fail('to peer name');
  if (h.correlationId !== undefined && typeof h.correlationId !== 'string') fail('correlationId');
  if (h.idempotencyKey !== undefined && typeof h.idempotencyKey !== 'string') {
    fail('idempotencyKey');
  }
  if (h.ttlMs !== undefined && (typeof h.ttlMs !== 'number' || h.ttlMs < 0)) fail('ttlMs');
  if (h.attempt !== undefined && (typeof h.attempt !== 'number' || h.attempt < 1)) fail('attempt');
  if (typeof h.contentType !== 'string' || h.contentType.length > 255) fail('contentType');
  if (h.headers !== undefined) {
    if (typeof h.headers !== 'object' || h.headers === null || Array.isArray(h.headers)) {
      fail('headers must be a string map');
    }
    for (const [key, value] of Object.entries(h.headers as Record<string, unknown>)) {
      if (typeof value !== 'string') fail(`header ${key} must be a string`);
    }
  }
  if (h.chunk !== undefined) assertValidChunk(h.chunk, fail);
}

function assertValidChunk(
  chunk: unknown,
  fail: (message: string, details?: Record<string, unknown>) => never,
): void {
  if (typeof chunk !== 'object' || chunk === null) fail('chunk must be an object');
  const c = chunk as Record<string, unknown>;
  if (typeof c.groupId !== 'string' || c.groupId.length === 0) fail('chunk.groupId');
  if (typeof c.count !== 'number' || !Number.isInteger(c.count) || c.count < 1) fail('chunk.count');
  if (
    typeof c.index !== 'number' ||
    !Number.isInteger(c.index) ||
    c.index < 0 ||
    c.index >= (c.count as number)
  ) {
    fail('chunk.index out of range');
  }
  if (typeof c.totalBytes !== 'number' || !Number.isInteger(c.totalBytes) || c.totalBytes < 0) {
    fail('chunk.totalBytes');
  }
}

/** Splits an envelope into header (JSON-serialisable) and payload. */
export function splitEnvelope(envelope: Envelope): { header: EnvelopeHeader; payload: Uint8Array } {
  const { payload, ...header } = envelope;
  return { header, payload };
}
