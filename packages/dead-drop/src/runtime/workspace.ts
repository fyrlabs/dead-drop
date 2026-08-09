/**
 * A running workspace: the thing an application actually talks to.
 *
 * It owns one transport manager and one mailbox, and turns the mailbox's flat
 * "here is an envelope" stream into the four interactions applications want:
 * request/response, service handlers, publish, and subscribe. Correlation,
 * timeouts and error marshalling live here so neither the mailbox below nor the
 * application above has to think about them.
 */

import { hostname } from 'node:os';

import {
  DeadDropError,
  KeyRing,
  createEnvelope,
  decodeFrame,
  decodeJson,
  encodeFrame,
  encodeJson,
  isErrorPayload,
  JSON_CONTENT_TYPE,
  type Envelope,
} from '../protocol/index.js';
import {
  DedupeStore,
  MailboxEngine,
  TransportManager,
  peersPrefix,
  peerKey,
  systemClock,
  type Clock,
  type Logger,
  type MailboxStats,
  type MetricsRegistry,
  type Tracer,
  type TransportInfo,
} from '../core/index.js';
import { MetricsRegistry as Metrics, traceContext } from '../core/index.js';
import type { StoreTransport, TransportRegistration } from '@fyrlabs/dead-drop-transport-sdk';

import type { WorkspaceConfig } from './config.js';
import { VERSION } from '../version.js';

/** A handler for inbound requests on one channel. */
export type RequestHandler = (
  payload: Uint8Array,
  context: RequestContext,
) => Promise<Uint8Array | undefined> | Uint8Array | undefined;

export interface RequestContext {
  from: string;
  channel: string;
  headers: Record<string, string>;
  contentType: string;
  signal: AbortSignal;
}

export type EventHandler = (payload: Uint8Array, context: EventContext) => Promise<void> | void;

export interface EventContext {
  from: string;
  channel: string;
  headers: Record<string, string>;
}

export interface PeerRecord {
  peerId: string;
  /** Channels this peer answers requests on. */
  services: string[];
  /** Named HTTP/static exposures this peer offers. */
  exposures: string[];
  /** When the beacon was written, in epoch milliseconds. */
  announcedAt: number;
  startedAt: number;
  version: string;
}

export interface WorkspaceOptions {
  config: WorkspaceConfig;
  registrations: ReadonlyArray<TransportRegistration<never>>;
  logger: Logger;
  metrics?: MetricsRegistry;
  tracer?: Tracer;
  clock?: Clock;
  /** File used to persist the deduplication set across restarts. */
  dedupePath?: string;
  /** How often the presence beacon is rewritten. Default 30s. */
  presenceIntervalMs?: number;
  /** Beacons older than this are treated as gone. Default 3x the interval. */
  presenceTtlMs?: number;
  version?: string;
}

interface Pending {
  resolve(envelope: Envelope): void;
  reject(error: DeadDropError): void;
  cancelTimeout(): void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class Workspace {
  readonly name: string;
  readonly peerId: string;
  readonly manager: TransportManager;
  readonly mailbox: MailboxEngine;
  readonly metrics: MetricsRegistry;

  private readonly config: WorkspaceConfig;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly keys: KeyRing;
  private readonly tracer: Tracer | undefined;
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly eventHandlers = new Map<string, Set<EventHandler>>();
  private readonly pending = new Map<string, Pending>();
  private readonly controller = new AbortController();
  private readonly presenceIntervalMs: number;
  private readonly presenceTtlMs: number;
  private readonly version: string;
  private readonly exposureNames = new Set<string>();
  private readonly startedAt: number;
  private stopPresence: (() => void) | undefined;
  private started = false;

  constructor(options: WorkspaceOptions) {
    this.config = options.config;
    this.name = options.config.name;
    this.peerId = options.config.peerId ?? defaultPeerId();
    this.logger = options.logger.child({ workspace: this.name, peer: this.peerId });
    this.clock = options.clock ?? systemClock;
    this.metrics = options.metrics ?? new Metrics();
    this.tracer = options.tracer;
    this.keys = KeyRing.fromSecrets(this.name, options.config.secrets);
    this.presenceIntervalMs = options.presenceIntervalMs ?? 30_000;
    this.presenceTtlMs = options.presenceTtlMs ?? this.presenceIntervalMs * 3;
    this.version = options.version ?? VERSION;
    this.startedAt = this.clock.now();

    this.manager = new TransportManager({
      workspace: this.name,
      peerId: this.peerId,
      registrations: options.registrations,
      ...(options.config.policy ? { policy: options.config.policy } : {}),
      logger: this.logger,
      metrics: this.metrics,
      clock: this.clock,
      ...(this.tracer ? { tracer: this.tracer } : {}),
      signal: this.controller.signal,
    });

    this.mailbox = new MailboxEngine({
      workspace: this.name,
      peerId: this.peerId,
      manager: this.manager,
      keys: this.keys,
      clock: this.clock,
      logger: this.logger,
      metrics: this.metrics,
      ...(this.tracer ? { tracer: this.tracer } : {}),
      ...(options.dedupePath
        ? { dedupe: new DedupeStore({ clock: this.clock, persistPath: options.dedupePath }) }
        : {}),
      ...(options.config.polling?.minIntervalMs !== undefined
        ? { minPollIntervalMs: options.config.polling.minIntervalMs }
        : {}),
      ...(options.config.polling?.maxIntervalMs !== undefined
        ? { maxPollIntervalMs: options.config.polling.maxIntervalMs }
        : {}),
    });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.manager.start();
    for (const channel of this.config.subscribe ?? []) this.mailbox.subscribeTopic(channel);
    await this.mailbox.start((envelope) => this.dispatch(envelope));
    await this.announce().catch((error: unknown) => {
      // A missing beacon costs discoverability, not correctness.
      this.logger.warn('failed to publish presence beacon', { error: String(error) });
    });
    this.stopPresence = this.clock.setInterval(this.presenceIntervalMs, () => {
      void this.announce().catch(() => undefined);
    });
    this.logger.info('workspace started', {
      transports: this.manager.list().map((info) => info.name),
      exposures: [...this.exposureNames],
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.stopPresence?.();
    this.stopPresence = undefined;
    for (const [, pending] of this.pending) {
      pending.cancelTimeout();
      pending.reject(new DeadDropError('CANCELLED', 'workspace is shutting down'));
    }
    this.pending.clear();
    await this.withdraw().catch(() => undefined);
    await this.mailbox.stop();
    await this.manager.stop();
    this.controller.abort();
    this.logger.info('workspace stopped');
  }

  // ------------------------------------------------------------- application

  /** Registers a handler for `channel`. One handler per channel; last wins. */
  handle(channel: string, handler: RequestHandler): () => void {
    this.requestHandlers.set(channel, handler);
    return () => {
      if (this.requestHandlers.get(channel) === handler) this.requestHandlers.delete(channel);
    };
  }

  /** Registers `service.method` handlers from a plain object of functions. */
  service(
    name: string,
    methods: Record<string, (input: unknown, context: RequestContext) => unknown>,
  ): () => void {
    const unregister = Object.entries(methods).map(([method, implementation]) =>
      this.handle(`${name}.${method}`, async (payload, context) => {
        const result = await implementation(decodeJson(payload), context);
        return encodeJson(result ?? null);
      }),
    );
    return () => unregister.forEach((off) => off());
  }

  /** Marks a channel as an exposure so it shows up in discovery. */
  registerExposure(name: string): void {
    this.exposureNames.add(name);
  }

  subscribe(channel: string, handler: EventHandler): () => void {
    let handlers = this.eventHandlers.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(channel, handlers);
      this.mailbox.subscribeTopic(channel);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.eventHandlers.delete(channel);
        this.mailbox.unsubscribeTopic(channel);
      }
    };
  }

  /** Broadcasts an event to every subscriber of `channel`. */
  async publish(
    channel: string,
    payload: Uint8Array,
    options: { headers?: Record<string, string>; contentType?: string; ttlMs?: number } = {},
  ): Promise<string> {
    const envelope = createEnvelope({
      workspace: this.name,
      kind: 'event',
      channel,
      from: this.peerId,
      contentType: options.contentType ?? JSON_CONTENT_TYPE,
      ts: this.clock.now(),
      payload,
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    });
    await this.mailbox.send(envelope);
    return envelope.id;
  }

  /**
   * Sends a request to `target` and waits for its response.
   *
   * The timeout is the caller's only guarantee: the transport may be a git push
   * that takes ten seconds, and the remote peer may be asleep. A timed-out
   * request is not cancelled remotely, it is simply abandoned.
   */
  async request(
    target: string,
    channel: string,
    payload: Uint8Array,
    options: {
      timeoutMs?: number;
      headers?: Record<string, string>;
      contentType?: string;
      signal?: AbortSignal;
      idempotencyKey?: string;
    } = {},
  ): Promise<Envelope> {
    const timeoutMs =
      options.timeoutMs ?? this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const envelope = createEnvelope({
      workspace: this.name,
      kind: 'request',
      channel,
      from: this.peerId,
      to: target,
      contentType: options.contentType ?? JSON_CONTENT_TYPE,
      ts: this.clock.now(),
      // A request that outlives its own timeout is garbage on the transport.
      ttlMs: timeoutMs,
      payload,
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    });

    // Keyed by the envelope id so `ddrop trace <requestId>` works with the id
    // a timeout error already hands the caller in `details.requestId`.
    const span = this.tracer?.startSpan('workspace.request', {
      traceId: envelope.id,
      attributes: { channel, target, requestId: envelope.id },
    });
    const startedAt = this.clock.now();
    this.metrics.inflightRequests.add(1, { workspace: this.name });

    const response = new Promise<Envelope>((resolve, reject) => {
      const cancelTimeout = this.clock.setTimeout(timeoutMs, () => {
        this.pending.delete(envelope.id);
        reject(
          new DeadDropError('TIMEOUT', `request to ${target} on ${channel} timed out`, {
            details: { channel, target, timeoutMs, requestId: envelope.id },
          }),
        );
      });
      const onAbort = (): void => {
        cancelTimeout();
        this.pending.delete(envelope.id);
        reject(new DeadDropError('CANCELLED', 'request aborted by caller'));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(envelope.id, {
        resolve: (value) => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          options.signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
        cancelTimeout,
      });
    });

    // Nothing awaits `response` until the send below returns, and the timeout
    // does not wait for that: a transport that is retrying behind an open
    // breaker keeps `mailbox.send` pending for far longer than the caller's
    // deadline. The rejection then lands with no handler attached, and an
    // unhandled rejection in Node terminates the process — a `ddrop connect`
    // proxy died outright the first time a request timed out during a transport
    // outage. Claiming the rejection here costs nothing: `await response` below
    // still receives it, and the caller still gets its TIMEOUT.
    response.catch(() => undefined);

    try {
      const trace = traceContext(span);
      await this.mailbox.send(envelope, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(trace ? { trace } : {}),
      });
      const result = await response;
      this.metrics.requestsTotal.inc({ channel, outcome: 'success' });
      this.metrics.requestLatency.observe(this.clock.now() - startedAt, { channel });
      span?.end('ok');
      return result;
    } catch (error) {
      const deadDropError = DeadDropError.from(error);
      this.pending.get(envelope.id)?.cancelTimeout();
      this.pending.delete(envelope.id);
      this.metrics.requestsTotal.inc({ channel, outcome: deadDropError.code });
      span?.setAttribute('error', deadDropError.message);
      span?.end(deadDropError.code === 'CANCELLED' ? 'cancelled' : 'error');
      throw deadDropError;
    } finally {
      this.metrics.inflightRequests.add(-1, { workspace: this.name });
    }
  }

  /** JSON convenience wrapper over `request`. */
  async call<T = unknown>(
    target: string,
    channel: string,
    input: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const response = await this.request(target, channel, encodeJson(input), options);
    const decoded = decodeJson(response.payload);
    if (isErrorPayload(decoded)) throw DeadDropError.fromJSON(decoded.error);
    return decoded as T;
  }

  // -------------------------------------------------------------- discovery

  /** Peers that have published a beacon recently. */
  async discover(options: { includeStale?: boolean } = {}): Promise<PeerRecord[]> {
    const stores = this.manager.stores();
    const seen = new Map<string, PeerRecord>();
    const cutoff = this.clock.now() - this.presenceTtlMs;

    for (const entry of stores) {
      const store = entry.transport as StoreTransport;
      let listed;
      try {
        listed = await store.list(peersPrefix(this.name), { limit: 500 });
      } catch (error) {
        this.logger.debug('peer listing failed', { transport: entry.name, error: String(error) });
        continue;
      }
      for (const item of listed.entries) {
        const raw = await store.get(item.key).catch(() => undefined);
        if (!raw) continue;
        const record = await this.decodePeerRecord(raw);
        if (!record) continue;
        if (!options.includeStale && record.announcedAt < cutoff) continue;
        const existing = seen.get(record.peerId);
        if (!existing || existing.announcedAt < record.announcedAt) seen.set(record.peerId, record);
      }
    }
    return [...seen.values()].sort((a, b) => (a.peerId < b.peerId ? -1 : 1));
  }

  transports(): TransportInfo[] {
    return this.manager.list();
  }

  stats(): { name: string; peerId: string; mailbox: MailboxStats; handlers: string[] } {
    return {
      name: this.name,
      peerId: this.peerId,
      mailbox: this.mailbox.stats(),
      handlers: [...this.requestHandlers.keys()],
    };
  }

  // ---------------------------------------------------------------- internals

  private async dispatch(envelope: Envelope): Promise<void> {
    switch (envelope.kind) {
      case 'response':
      case 'ack':
        this.resolvePending(envelope);
        return;
      case 'request':
        await this.handleRequest(envelope);
        return;
      case 'event':
        await this.handleEvent(envelope);
        return;
      case 'control':
        // Presence beacons arrive as control frames when a peer writes into an
        // inbox; discovery reads them from the store instead, so nothing to do.
        return;
      default:
        this.logger.warn('ignoring envelope of unknown kind', { kind: envelope.kind });
    }
  }

  private resolvePending(envelope: Envelope): void {
    const correlationId = envelope.correlationId;
    if (!correlationId) {
      this.logger.warn('response arrived without a correlation id', { messageId: envelope.id });
      return;
    }
    const pending = this.pending.get(correlationId);
    if (!pending) {
      // Late response to a request that already timed out. Expected, not an error.
      this.logger.debug('response has no waiting caller', { correlationId });
      return;
    }
    this.pending.delete(correlationId);
    pending.cancelTimeout();
    pending.resolve(envelope);
  }

  private async handleRequest(envelope: Envelope): Promise<void> {
    const handler = this.requestHandlers.get(envelope.channel);
    const context: RequestContext = {
      from: envelope.from,
      channel: envelope.channel,
      headers: envelope.headers ?? {},
      contentType: envelope.contentType,
      signal: this.controller.signal,
    };

    let payload: Uint8Array;
    let contentType = JSON_CONTENT_TYPE;
    if (!handler) {
      payload = encodeJson({
        error: new DeadDropError(
          'NOT_FOUND',
          `no handler for channel ${envelope.channel}`,
        ).toJSON(),
      });
    } else {
      try {
        const result = await handler(envelope.payload, context);
        payload = result ?? new Uint8Array(0);
        contentType = envelope.headers?.['accept'] ?? JSON_CONTENT_TYPE;
      } catch (error) {
        const deadDropError = DeadDropError.from(error, 'SERVICE_ERROR');
        this.logger.warn('request handler failed', {
          channel: envelope.channel,
          from: envelope.from,
          error: deadDropError.message,
        });
        payload = encodeJson({ error: deadDropError.toJSON() });
      }
    }

    const response = createEnvelope({
      workspace: this.name,
      kind: 'response',
      channel: envelope.channel,
      from: this.peerId,
      to: envelope.from,
      correlationId: envelope.id,
      contentType,
      ts: this.clock.now(),
      // Outliving the caller's patience serves nobody.
      ttlMs: envelope.ttlMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      payload,
    });
    await this.mailbox.send(response);
  }

  private async handleEvent(envelope: Envelope): Promise<void> {
    const handlers = this.eventHandlers.get(envelope.channel);
    if (!handlers || handlers.size === 0) return;
    const context: EventContext = {
      from: envelope.from,
      channel: envelope.channel,
      headers: envelope.headers ?? {},
    };
    // One misbehaving subscriber must not stop the others.
    const results = await Promise.allSettled(
      [...handlers].map(async (handler) => handler(envelope.payload, context)),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn('event subscriber threw', {
          channel: envelope.channel,
          error: String(result.reason),
        });
      }
    }
  }

  /** Writes this peer's beacon so other peers can discover it. */
  private async announce(): Promise<void> {
    const record: PeerRecord = {
      peerId: this.peerId,
      services: [...this.requestHandlers.keys()],
      exposures: [...this.exposureNames],
      announcedAt: this.clock.now(),
      startedAt: this.startedAt,
      version: this.version,
    };
    const envelope = createEnvelope({
      workspace: this.name,
      kind: 'control',
      channel: 'presence',
      from: this.peerId,
      contentType: JSON_CONTENT_TYPE,
      ts: this.clock.now(),
      payload: encodeJson(record),
    });
    const frame = await encodeFrame(envelope, { key: this.keys.primary });
    const key = peerKey(this.name, this.peerId);
    await this.manager.run('put', (transport) =>
      (transport as StoreTransport).put(key, frame, { contentType: 'application/octet-stream' }),
    );
  }

  private async withdraw(): Promise<void> {
    const key = peerKey(this.name, this.peerId);
    await Promise.allSettled(
      this.manager.stores().map((entry) => (entry.transport as StoreTransport).delete(key)),
    );
  }

  private async decodePeerRecord(raw: Uint8Array): Promise<PeerRecord | undefined> {
    try {
      const { envelope } = await decodeFrame(raw, { keys: this.keys });
      if (envelope.kind !== 'control' || envelope.channel !== 'presence') return undefined;
      const record = decodeJson<PeerRecord>(envelope.payload);
      if (!record || typeof record.peerId !== 'string') return undefined;
      return {
        peerId: record.peerId,
        services: Array.isArray(record.services) ? record.services : [],
        exposures: Array.isArray(record.exposures) ? record.exposures : [],
        announcedAt: typeof record.announcedAt === 'number' ? record.announcedAt : envelope.ts,
        startedAt: typeof record.startedAt === 'number' ? record.startedAt : envelope.ts,
        version: typeof record.version === 'string' ? record.version : 'unknown',
      };
    } catch {
      // A beacon we cannot read belongs to another workspace or another key era.
      return undefined;
    }
  }
}

/**
 * Default identity is the machine's hostname, sanitised into a valid peer name.
 * It is stable across restarts, which matters: a peer id is a mailbox address,
 * and a random one on every start would strand undelivered messages.
 */
function defaultPeerId(): string {
  return process.env.DEADDROP_PEER_ID ?? sanitise(hostname());
}

function sanitise(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 64) : 'peer';
}
