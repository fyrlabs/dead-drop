/**
 * The transport plugin contract.
 *
 * Deviation from the original design sketch, on purpose: adapters do not
 * implement `send`/`receive`/ack. Nearly every transport people actually want
 * (GitHub, GitLab, OneDrive, SharePoint, S3, Dropbox, a synced folder) is an
 * object store with no delivery semantics of its own, so an adapter-level
 * `send`/`receive` API forces every third-party author to reimplement polling,
 * acknowledgement, deduplication and at-least-once delivery — and to get all of
 * it right.
 *
 * Instead there are two kinds of transport:
 *
 *   - `store`  — put / get / list / delete, optionally watch. Roughly 50 lines
 *     for a typical backend. The Bridge mailbox engine layers framing, ordering,
 *     acknowledgement, retry and deduplication on top.
 *   - `native` — the backend already is a message system with its own delivery
 *     semantics (AMQP, MQTT, a websocket relay). It sends and subscribes
 *     directly and Bridge stays out of the way.
 *
 * Most authors want `store`.
 */

import type { BridgeError } from '@dead-drop/protocol';

export type TransportKind = 'store' | 'native';

export type TransportOrdering = 'none' | 'partition' | 'global';

export interface TransportCapabilities {
  kind: TransportKind;
  /**
   * Ordering the backend guarantees for messages addressed to one recipient.
   * `partition` means per-recipient ordering, which is what key-sorted object
   * stores give you; `none` means the runtime must not assume any.
   */
  ordering: TransportOrdering;
  /** Payloads survive a byte-for-byte round trip. Text-only backends set false. */
  binaryPayloads: boolean;
  /** Largest single object or message the backend accepts. Drives chunking. */
  maxPayloadBytes?: number;
  /** Objects/messages can be removed. Without it the runtime keeps a tombstone log. */
  delete: boolean;
  /** A push notification path exists, so the runtime can skip or slow polling. */
  watch: boolean;
  /** `list` returns entries in lexicographic key order. Enables FIFO-ish delivery. */
  orderedList: boolean;
  /**
   * `native` only: the backend acknowledges delivery itself, so Bridge should
   * not synthesise acks.
   */
  acknowledgements?: boolean;
  /** Advertised for routing decisions; the runtime measures the real thing. */
  expectedLatencyMs?: number;
}

export interface TransportLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Everything the runtime hands an adapter at construction time. */
export interface TransportContext {
  /** Workspace this instance serves. Adapters should namespace by it. */
  workspace: string;
  /** This machine's peer id. */
  peerId: string;
  /** Instance name, which is the transport id unless the user configured several. */
  instance: string;
  logger: TransportLogger;
  /** Aborted when the runtime shuts down. Adapters should abort in-flight I/O. */
  signal: AbortSignal;
  /** Injected so tests can drive time. Adapters must not call `Date.now` directly. */
  now(): number;
}

export type TransportStatus = 'healthy' | 'degraded' | 'unavailable';

export interface TransportHealth {
  status: TransportStatus;
  /** Round-trip time of the health probe itself. */
  latencyMs?: number;
  rateLimit?: {
    limit?: number;
    remaining?: number;
    /** Epoch milliseconds. */
    resetAt?: number;
  };
  lastSuccessAt?: number;
  /** 0..1 over the adapter's own recent window, if it tracks one. */
  errorRate?: number;
  /** Human-readable detail for `bridge transport health`. */
  message?: string;
}

export interface ObjectEntry {
  key: string;
  size: number;
  /** Epoch milliseconds, when the backend exposes it. */
  modifiedAt?: number;
  /** Version marker for conditional operations, when the backend has one. */
  etag?: string;
}

export interface ListOptions {
  /** Continuation token returned by a previous call. */
  cursor?: string;
  /**
   * Return only keys strictly greater than this one.
   *
   * Message ids sort by creation time, so a subscriber that remembers the last
   * key it consumed can ask for "what is new" instead of listing the whole
   * prefix on every poll. On a remote transport that is the difference between
   * one cheap call and one that grows with retention.
   */
  startAfter?: string;
  /** Upper bound on entries returned. Adapters may return fewer. */
  limit?: number;
  signal?: AbortSignal;
}

export interface ListResult {
  entries: ObjectEntry[];
  /** Present when more entries remain. */
  cursor?: string;
}

export interface PutOptions {
  /** Fail with `TRANSPORT_ERROR` if the key already exists. Used for claim markers. */
  ifAbsent?: boolean;
  /** Fail unless the current object matches this etag. */
  ifMatch?: string;
  signal?: AbortSignal;
  /** Advisory content type for backends that store one. */
  contentType?: string;
}

export interface PutResult {
  key: string;
  etag?: string;
}

/**
 * A store transport. Implementations must be safe to call concurrently and
 * `delete` must be idempotent: deleting a missing key succeeds.
 */
export interface StoreTransport {
  readonly kind: 'store';
  put(key: string, data: Uint8Array, options?: PutOptions): Promise<PutResult>;
  /** Resolves `undefined` when the key does not exist. Never throws for absence. */
  get(key: string, options?: { signal?: AbortSignal }): Promise<Uint8Array | undefined>;
  list(prefix: string, options?: ListOptions): Promise<ListResult>;
  delete(key: string, options?: { signal?: AbortSignal }): Promise<void>;
  /** Optional push path. Returns a function that stops watching. */
  watch?(prefix: string, onChange: () => void): Promise<() => Promise<void>>;
  health(): Promise<TransportHealth>;
  close(): Promise<void>;
}

export interface NativeMessage {
  frame: Uint8Array;
  /** Opaque handle the runtime passes back to `ack`. */
  receipt?: string;
}

/** A transport whose backend already provides delivery semantics. */
export interface NativeTransport {
  readonly kind: 'native';
  /** `target` is the recipient peer id, or `undefined` to broadcast. */
  send(
    target: string | undefined,
    frame: Uint8Array,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  subscribe(handler: (message: NativeMessage) => Promise<void>): Promise<() => Promise<void>>;
  /** Only called when `capabilities.acknowledgements` is true. */
  ack?(receipt: string): Promise<void>;
  health(): Promise<TransportHealth>;
  close(): Promise<void>;
}

export type Transport = StoreTransport | NativeTransport;

export interface TransportDefinition<Config = unknown> {
  /** Stable identifier, e.g. `github`. Lower-case, used in config and metrics. */
  id: string;
  capabilities: TransportCapabilities;
  /**
   * Validates and normalises configuration loaded from a file or the CLI.
   * Throw a `BridgeError('CONFIG_INVALID', ...)` on bad input. Optional: skip it
   * when the transport is only ever constructed from typed code.
   */
  parseConfig?(raw: unknown): Config;
  create(config: Config, context: TransportContext): Transport | Promise<Transport>;
}

/** What a configured transport looks like before the runtime instantiates it. */
export interface TransportRegistration<Config = unknown> {
  definition: TransportDefinition<Config>;
  config: Config;
  /** Distinguishes two instances of the same transport. Defaults to the id. */
  name?: string;
}

export type TransportFactory<Config = unknown> = (
  config: Config,
  options?: { name?: string },
) => TransportRegistration<Config>;

/** Thrown by adapters through the shared error type. Re-exported for convenience. */
export type { BridgeError };
