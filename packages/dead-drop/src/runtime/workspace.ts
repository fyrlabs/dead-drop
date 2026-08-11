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
  enrollmentProof,
  generateIdentity,
  idTime,
  isErrorPayload,
  senderIdentity,
  unwrapEraKey,
  verifyEnrollmentProof,
  JSON_CONTENT_TYPE,
  type Envelope,
  type PeerIdentity,
  type WrappedKey,
} from '../protocol/index.js';
import {
  DedupeStore,
  MailboxEngine,
  TransportManager,
  identityKey,
  identityPrefix,
  inboxRoot,
  parseIdentityKey,
  parseInboxKey,
  parsePeerKey,
  peersPrefix,
  peerKey,
  systemClock,
  wrappedKeyPrefix,
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
  /** Mailbox address of the caller. Reply routing only. */
  from: string;
  /** Who the caller is. Use this, not `from`, for any access decision. */
  identity: string;
  channel: string;
  headers: Record<string, string>;
  contentType: string;
  signal: AbortSignal;
}

export type EventHandler = (payload: Uint8Array, context: EventContext) => Promise<void> | void;

export interface EventContext {
  /** Mailbox address of the publisher. */
  from: string;
  /** Who the publisher is. Use this, not `from`, for any access decision. */
  identity: string;
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

export interface PeerReport {
  peers: PeerRecord[];
  /** Store transports that could not be listed. Peers they hold are missing. */
  unreadable: Array<{ transport: string; message: string }>;
  /** Store transports the peers were read from. Zero means the report says nothing. */
  read: number;
}

/** What is waiting in one peer's inbox, counted without decrypting anything. */
export interface QueueDepth {
  peerId: string;
  /** Frames waiting for this peer. Counted once even when several transports hold it. */
  count: number;
  /** Total size of those frames. Ciphertext, so a little larger than the payloads. */
  bytes: number;
  /** Id of the oldest waiting message: keys sort by creation time. */
  oldestId: string;
  /** Creation time of `oldestId`, or `undefined` if the id is not a dead-drop id. */
  oldestAt: number | undefined;
}

export interface QueueReport {
  workspace: string;
  /** This runtime's own mailbox address, so its own queue can be told apart. */
  peerId: string;
  /** Non-empty inboxes, deepest first. A peer with nothing waiting is absent. */
  queues: QueueDepth[];
  /** Store transports that could not be listed. The counts exclude what they hold. */
  unreadable: Array<{ transport: string; message: string }>;
  /** Store transports the counts were read from. Zero means the report says nothing. */
  read: number;
  /** A listing hit the scan cap, so every count is a lower bound. */
  truncated: boolean;
}

/** Entries per list call, and the most one `queues()` will walk per transport. */
const QUEUE_PAGE_SIZE = 1000;
const QUEUE_SCAN_LIMIT = 10_000;

/** Default window before an absent peer's inbox may be reaped. See ADR 0006. */
const DEFAULT_INBOX_ORPHAN_MS = 7 * 24 * 60 * 60_000;

/**
 * How often maintenance runs, and how stale a beacon gets before any peer may
 * delete it, both as multiples of `presenceTtlMs`.
 *
 * A beacon is self-healing: its owner rewrites it every `presenceIntervalMs`,
 * so deleting one wrongly costs a single interval of invisibility and repairs
 * itself. Ten expiry windows is thirty missed announcements at the defaults,
 * which is dead rather than slow. Messages get a horizon four orders of
 * magnitude longer, because deleting one wrongly is not recoverable.
 */
const STALE_BEACON_TTLS = 10;

/**
 * Longest gap between maintenance passes when deletes keep failing.
 *
 * A refused delete leaves the condition that triggered it true, so without a
 * floor the pass retries forever at full rate. Compaction shipped exactly that
 * bug once. Doubling to this cap turns a permanently unwritable store into a
 * few wasted listings a day instead of a few hundred.
 */
const REAP_BACKOFF_CAP = 32;

export interface WorkspaceOptions {
  config: WorkspaceConfig;
  registrations: ReadonlyArray<TransportRegistration<never>>;
  logger: Logger;
  metrics?: MetricsRegistry;
  tracer?: Tracer;
  clock?: Clock;
  /** File used to persist the deduplication set across restarts. */
  dedupePath?: string;
  /**
   * This peer's X25519 keypair, ADR 0007. Loading it is inherently async, so
   * `Runtime` resolves it before constructing a Workspace, the same way it
   * resolves `registrations` first. Callers that construct a Workspace directly
   * get a fresh in-memory keypair: a test should not need a data directory to
   * exchange traffic, and losing it on exit is fine for something that lives
   * only as long as the test.
   */
  identity?: PeerIdentity;
  /**
   * Marks this runtime as a short-lived session sharing a config with a
   * longer-lived peer. It takes its own mailbox address so the two do not fight
   * over one inbox, while keeping the configured peer id as its identity.
   */
  sessionId?: string;
  /** How often the presence beacon is rewritten. Default 30s. */
  presenceIntervalMs?: number;
  /** Beacons older than this are treated as gone. Default 3x the interval. */
  presenceTtlMs?: number;
  /** Orphaned inbox retention. Default 7 days, `0` disables reaping. */
  inboxOrphanMs?: number;
  version?: string;
}

interface Pending {
  resolve(envelope: Envelope): void;
  reject(error: DeadDropError): void;
  cancelTimeout(): void;
}

/**
 * Reads a wrapped era key object, or `undefined` if it is not one.
 *
 * Anything under this prefix came off a store that cannot be trusted to hold
 * only what dead-drop wrote, so a malformed object is a normal case to skip
 * rather than an error to raise.
 */
function decodeWrappedKey(raw: Uint8Array): WrappedKey | undefined {
  try {
    const body = decodeJson(raw) as Record<string, unknown>;
    const fields = ['eraId', 'ephemeralPublicKey', 'iv', 'ciphertext', 'tag'] as const;
    if (fields.some((field) => typeof body[field] !== 'string')) return undefined;
    return {
      eraId: body.eraId as string,
      ephemeralPublicKey: Buffer.from(body.ephemeralPublicKey as string, 'base64url'),
      iv: Buffer.from(body.iv as string, 'base64url'),
      ciphertext: Buffer.from(body.ciphertext as string, 'base64url'),
      tag: Buffer.from(body.tag as string, 'base64url'),
    };
  } catch {
    return undefined;
  }
}

/** The on-store form of a wrapped era key. Counterpart to `decodeWrappedKey`. */
export function encodeWrappedKey(wrapped: WrappedKey): Uint8Array {
  return encodeJson({
    eraId: wrapped.eraId,
    ephemeralPublicKey: wrapped.ephemeralPublicKey.toString('base64url'),
    iv: wrapped.iv.toString('base64url'),
    ciphertext: wrapped.ciphertext.toString('base64url'),
    tag: wrapped.tag.toString('base64url'),
  });
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class Workspace {
  readonly name: string;
  /**
   * This runtime's mailbox address. Replies come here, and it is unique per
   * running process so two runtimes never poll one inbox.
   */
  readonly peerId: string;
  /**
   * Who this runtime is, as configured. Equal to `peerId` for an ordinary peer,
   * and the un-suffixed configured id for a `ddrop connect` session. This is
   * what an exposure's `allowPeers` list is written against.
   */
  readonly identity: string;
  readonly manager: TransportManager;
  readonly mailbox: MailboxEngine;
  readonly metrics: MetricsRegistry;

  private readonly config: WorkspaceConfig;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly keys: KeyRing;
  /**
   * This peer's X25519 keypair, ADR 0007. Named apart from `identity` above,
   * which is the configured peer *name* and not key material.
   */
  private readonly keypair: PeerIdentity;
  private readonly tracer: Tracer | undefined;
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly eventHandlers = new Map<string, Set<EventHandler>>();
  private readonly pending = new Map<string, Pending>();
  private readonly controller = new AbortController();
  private readonly presenceIntervalMs: number;
  private readonly presenceTtlMs: number;
  private readonly inboxOrphanMs: number;
  private readonly version: string;
  private readonly exposureNames = new Set<string>();
  private readonly startedAt: number;
  private stopPresence: (() => void) | undefined;
  private announcing: Promise<void> | undefined;
  private reaping: Promise<void> | undefined;
  private enrolling: Promise<void> | undefined;
  /**
   * Set once this peer's identity object is on a transport. An identity never
   * changes, so republishing it every tick would be a commit and a push per tick
   * on a git or github transport for no new information. Retried while false so
   * a transport that was down at start-up still gets it.
   */
  private identityPublished = false;
  private nextReapAt = 0;
  private reapBackoff = 1;
  private started = false;

  constructor(options: WorkspaceOptions) {
    this.config = options.config;
    this.name = options.config.name;
    this.identity = options.config.peerId ?? defaultPeerId();
    this.peerId = options.sessionId ? `${this.identity}-c${options.sessionId}` : this.identity;
    this.logger = options.logger.child({ workspace: this.name, peer: this.peerId });
    this.clock = options.clock ?? systemClock;
    this.metrics = options.metrics ?? new Metrics();
    this.tracer = options.tracer;
    this.keys = KeyRing.fromSecrets(this.name, options.config.secrets);
    this.keypair = options.identity ?? generateIdentity();
    // The explicit option wins over the config field so a caller constructing a
    // Workspace directly, which is what the tests do, is not overridden by it.
    this.presenceIntervalMs =
      options.presenceIntervalMs ?? options.config.presenceIntervalMs ?? 30_000;
    this.presenceTtlMs = options.presenceTtlMs ?? this.presenceIntervalMs * 3;
    this.inboxOrphanMs =
      options.inboxOrphanMs ?? options.config.inboxOrphanMs ?? DEFAULT_INBOX_ORPHAN_MS;
    this.version = options.version ?? VERSION;
    this.startedAt = this.clock.now();

    this.manager = new TransportManager({
      workspace: this.name,
      peerId: this.peerId,
      registrations: options.registrations,
      ...(options.config.policy ? { policy: options.config.policy } : {}),
      ...(options.config.retry ? { retry: options.config.retry } : {}),
      ...(options.config.breaker ? { breaker: options.config.breaker } : {}),
      ...(options.config.healthIntervalMs !== undefined
        ? { healthIntervalMs: options.config.healthIntervalMs }
        : {}),
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
      ...(options.config.concurrency !== undefined
        ? { concurrency: options.config.concurrency }
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
    // Not awaited, and that is the whole point. A missing beacon costs
    // discoverability, not correctness, but awaiting it made the cost total:
    // with every transport unavailable the first announcement sits in a retry
    // ladder behind an open breaker, and `ddrop connect` binds its local port
    // only after `runtime.start()` resolves. So a caller got "connection
    // refused" on a port that was never opened, with nothing in the log saying
    // why. Peers join and quit whenever they like; a local server that waits
    // for one to be reachable is a server that is down for a reason of its own
    // making. The interval below re-announces every 30 seconds, so
    // discoverability recovers on its own once a transport does.
    this.beacon(true);
    // Not awaited, for the same reason as the beacon above: enrollment costs
    // discoverability of this peer as a wrapping target, never correctness of
    // what it can already do, and blocking start-up on a transport being
    // reachable is what once made `ddrop connect` refuse a port it never opened.
    this.enroll();
    // Maintenance rides the presence tick rather than owning a timer: it needs
    // the beacons anyway, and its own throttle is what actually decides how
    // often it runs. It is deliberately absent from the line above -- start-up
    // already moved the first beacon off its critical path for latency, and a
    // pass that lists every inbox on every transport is far heavier than one
    // put. A process too short-lived to reach the first tick contributes
    // nothing to the leak either way.
    this.stopPresence = this.clock.setInterval(this.presenceIntervalMs, () => {
      this.beacon(false);
      this.maintain();
      // Rides the same tick so a peer that enrolled after this one started is
      // picked up without a restart, and a rotated era arrives on its own. It is
      // separate from `maintain` on purpose: reaping is switched off entirely
      // when `inboxOrphanMs` is 0, and taking delivery of your own keys must not
      // depend on a retention setting.
      this.enroll();
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
    // A maintenance pass holds store references and deletes in a loop. Leaving
    // one running past `manager.stop()` means deletes firing at closed
    // transports, so let it finish first: it never rejects, and the throttle
    // means it is almost never in flight.
    await this.reaping;
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
      identity: this.identity,
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
      identity: this.identity,
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

    // The deadline covers the send as well as the wait for a reply, because a
    // caller cannot tell the two apart and never asked to. It used to guard
    // only the reply, so with transports failing the send sat in a retry loop
    // and a caller that asked for 15 seconds waited two minutes. Aborting is
    // better than racing: it stops the retries too, rather than leaving work
    // running for someone who has already gone.
    const deadline = new AbortController();
    const cancelDeadline = this.clock.setTimeout(timeoutMs, () => deadline.abort());
    const sendSignal = options.signal
      ? AbortSignal.any([options.signal, deadline.signal])
      : deadline.signal;

    try {
      const trace = traceContext(span);
      try {
        await this.mailbox.send(envelope, { signal: sendSignal, ...(trace ? { trace } : {}) });
      } catch (error) {
        // Our own deadline stopped the send, so report the timeout the caller
        // asked about rather than the cancellation it never requested. Any
        // other failure is the transport's and is reported as itself.
        if (deadline.signal.aborted && !options.signal?.aborted) await response;
        throw error;
      }
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
      cancelDeadline();
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

  /**
   * Peers that have published a beacon recently, with which stores answered.
   *
   * `read` exists for the same reason it does on `queues()`: an empty `peers`
   * means "nobody has announced" only when at least one store could be listed.
   * When every store fails this used to return an empty array and log the
   * reason at debug, so `ddrop discover` printed "No peers have announced
   * themselves yet" and exited 0 while the truth was that it could not look.
   */
  async discoverPeers(options: { includeStale?: boolean } = {}): Promise<PeerReport> {
    const { records, unreadable, read } = await this.listBeacons();
    const cutoff = this.clock.now() - this.presenceTtlMs;
    const peers = [...records.values()]
      .filter((record) => options.includeStale === true || record.announcedAt >= cutoff)
      .sort((a, b) => (a.peerId < b.peerId ? -1 : 1));
    return { peers, unreadable, read };
  }

  /**
   * Every beacon object in the workspace, decoded where possible.
   *
   * `found` carries the objects as they were listed, including ones that did
   * not decode, and `records` carries only the ones that did. The reaper needs
   * both: a beacon whose frame we cannot read belongs to a key era we do not
   * hold, and its owner may be perfectly alive, so its mere existence has to
   * count as liveness even though its contents tell us nothing.
   */
  private async listBeacons(): Promise<{
    records: Map<string, PeerRecord>;
    found: Array<{ store: StoreTransport; transport: string; peerId: string; key: string }>;
    unreadable: PeerReport['unreadable'];
    read: number;
  }> {
    const records = new Map<string, PeerRecord>();
    const found: Array<{ store: StoreTransport; transport: string; peerId: string; key: string }> =
      [];
    const unreadable: PeerReport['unreadable'] = [];
    let read = 0;

    for (const entry of this.manager.stores()) {
      const store = entry.transport as StoreTransport;
      let listed;
      try {
        listed = await store.list(peersPrefix(this.name), { limit: 500 });
      } catch (error) {
        const failure = DeadDropError.from(error);
        // Warn, not debug: this is the reason discovery looks empty, and it
        // reached no default log configuration where it was.
        this.logger.warn('peer listing failed', {
          transport: entry.name,
          error: failure.message,
        });
        unreadable.push({ transport: entry.name, message: failure.message });
        continue;
      }
      read += 1;
      for (const item of listed.entries) {
        const peerId = parsePeerKey(this.name, item.key);
        if (peerId === undefined) continue;
        found.push({ store, transport: entry.name, peerId, key: item.key });
        const raw = await store.get(item.key).catch(() => undefined);
        if (!raw) continue;
        const record = await this.decodePeerRecord(raw);
        if (!record) continue;
        const existing = records.get(record.peerId);
        if (!existing || existing.announcedAt < record.announcedAt) {
          records.set(record.peerId, record);
        }
      }
    }
    return { records, found, unreadable, read };
  }

  /** Peers that have published a beacon recently. Use `discoverPeers` to tell an
   * empty workspace from one that could not be read. */
  async discover(options: { includeStale?: boolean } = {}): Promise<PeerRecord[]> {
    return (await this.discoverPeers(options)).peers;
  }

  /**
   * How many messages are waiting in each peer's inbox, and how old the oldest
   * one is.
   *
   * Nothing is decrypted and nothing is consumed. Object keys carry the peer
   * name and a time-sortable message id in the clear on purpose (invariant 9),
   * so listing `ws/<workspace>/inbox` answers "what is pending, and for whom"
   * from the key layout alone. Frame contents stay sealed.
   *
   * Reading costs one listing per store transport, which on the git and github
   * transports means a fetch. Cheap enough to poll a dashboard with, not cheap
   * enough to call in a loop.
   */
  async queues(): Promise<QueueReport> {
    const root = inboxRoot(this.name);
    const buckets = new Map<string, QueueDepth>();
    const counted = new Set<string>();
    const unreadable: QueueReport['unreadable'] = [];
    let read = 0;
    let truncated = false;

    for (const entry of this.manager.stores()) {
      const store = entry.transport as StoreTransport;
      try {
        let cursor: string | undefined;
        let scanned = 0;
        do {
          const page = await store.list(root, {
            limit: QUEUE_PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
          });
          for (const item of page.entries) {
            const parsed = parseInboxKey(this.name, item.key);
            if (!parsed) continue;
            const bucket = buckets.get(parsed.peerId) ?? {
              peerId: parsed.peerId,
              count: 0,
              bytes: 0,
              oldestId: parsed.messageId,
              oldestAt: idTime(parsed.messageId),
            };
            buckets.set(parsed.peerId, bucket);
            // The same message can sit on two transports at once under the
            // parallel policy, and the mailbox deduplicates on delivery, so
            // counting it twice would report a backlog that does not exist.
            const identity = `${parsed.peerId}/${parsed.messageId}`;
            if (counted.has(identity)) continue;
            counted.add(identity);
            bucket.count += 1;
            bucket.bytes += item.size;
            if (parsed.messageId < bucket.oldestId) {
              bucket.oldestId = parsed.messageId;
              bucket.oldestAt = idTime(parsed.messageId);
            }
          }
          scanned += page.entries.length;
          cursor = page.cursor;
          if (cursor && scanned >= QUEUE_SCAN_LIMIT) {
            truncated = true;
            break;
          }
        } while (cursor);
        read += 1;
      } catch (error) {
        const failure = DeadDropError.from(error);
        this.logger.debug('inbox listing failed', {
          transport: entry.name,
          error: failure.message,
        });
        unreadable.push({ transport: entry.name, message: failure.message });
      }
    }

    return {
      workspace: this.name,
      peerId: this.peerId,
      queues: [...buckets.values()].sort(
        (a, b) => b.count - a.count || (a.peerId < b.peerId ? -1 : 1),
      ),
      unreadable,
      read,
      truncated,
    };
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
      identity: senderIdentity(envelope),
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
      identity: this.identity,
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
      identity: senderIdentity(envelope),
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
  /**
   * Publishes one presence beacon, never more than one at a time.
   *
   * Nothing upstream bounds a beacon: it is fire-and-forget, so a slow
   * transport keeps one alive for as long as its own deadline allows. Every
   * interval used to start another regardless, which is only safe while the
   * first one is guaranteed to have finished -- which is exactly what awaiting
   * it in `start` used to guarantee. Publishing in the background removed that
   * guarantee and left the interval unchanged, so on a cold transport, where
   * the first beacon still has a clone and an authentication round trip in
   * front of it, the second one starts on top of the first. Each is another
   * writer on the same backend, each makes the next one slower, and a transport
   * that was merely slow gets pushed into failing: the beacons become the load.
   *
   * One in flight is all discoverability needs. A stale record is replaced by
   * the next beacon that lands, not by the number of attempts made.
   */
  private beacon(first: boolean): void {
    if (this.announcing) return;
    this.announcing = this.announce()
      .catch((error: unknown) => {
        // Loud once, quiet after: a transport that is down would otherwise warn
        // every 30 seconds for as long as it stays down.
        const message = 'failed to publish presence beacon';
        if (first) this.logger.warn(message, { error: String(error) });
        else this.logger.debug(message, { error: String(error) });
      })
      .finally(() => {
        this.announcing = undefined;
      });
  }

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
      identity: this.identity,
      contentType: JSON_CONTENT_TYPE,
      ts: this.clock.now(),
      payload: encodeJson(record),
    });
    const frame = await encodeFrame(envelope, { key: this.keys.primary });
    const key = peerKey(this.name, this.peerId);
    // `runWrite`, so a `parallel` workspace announces on every transport. A
    // beacon written to one transport a peer cannot reach makes this peer
    // invisible to it, which is the asymmetry `parallel` exists to remove, and
    // discovery would have contradicted delivery. `withdraw` already deletes
    // from every store, so the two stay symmetric.
    await this.manager.runWrite(
      'put',
      (transport) =>
        (transport as StoreTransport).put(key, frame, { contentType: 'application/octet-stream' }),
      // The interval is the retry, and the expiry window is the deadline. A
      // retry ladder here would spend the transport's budget republishing a
      // record the next interval is about to supersede, and would hold the
      // in-flight slot above while doing it. Past `presenceTtlMs` nobody would
      // believe this beacon even if it landed, so there is nothing left to wait
      // for; a transport slower than that is not one peers can be found over.
      { timeoutMs: this.presenceTtlMs, retry: { maxAttempts: 1 } },
    );
  }

  private async withdraw(): Promise<void> {
    const key = peerKey(this.name, this.peerId);
    await Promise.allSettled(
      this.manager.stores().map((entry) => (entry.transport as StoreTransport).delete(key)),
    );
  }

  /**
   * One enrollment pass: publish this peer's public key if it is not out yet,
   * then take delivery of any era key wrapped for it. ADR 0007.
   *
   * Deliberately does **not** wrap the current era for other peers. In this
   * phase the primary era is still the key derived from the workspace secret
   * (`KeyRing.fromSecrets`), so every member already computes it and publishing
   * a wrapped copy would cost one object per peer per transport, a commit and a
   * push each on git and github, to hand over something the recipient already
   * has. Wrapping belongs where an era is genuinely undistributable otherwise,
   * which is a rotation minting a random era.
   */
  private enroll(): void {
    if (this.enrolling) return;
    this.enrolling = (async () => {
      if (!this.identityPublished) await this.publishIdentity();
      await this.loadWrappedKeys();
    })()
      .catch((error: unknown) => {
        this.logger.debug('enrollment pass failed', { error: String(error) });
      })
      .finally(() => {
        this.enrolling = undefined;
      });
  }

  /**
   * Publishes this peer's public key with a proof that its author holds the
   * workspace secret.
   *
   * Keyed by `identity`, the configured name, and never by `peerId`. A key
   * wrapped to a `ddrop connect` session's ephemeral `<identity>-c<pid>` address
   * would be useless the moment that process exited, and the session loads the
   * same identity file as the long-lived runtime anyway, so both publish
   * identical content to one key.
   *
   * The object is not a frame and is not encrypted. A public key is public, and
   * what it needs is authentication, which the proof provides: a transport
   * operator can copy or delete this object but cannot forge one, because the
   * proof key is derived from a secret the transport never sees.
   */
  private async publishIdentity(): Promise<void> {
    const secret = this.config.secrets[0];
    if (secret === undefined) return;
    const proof = enrollmentProof(secret, this.name, this.identity, this.keypair.publicKey);
    const body = encodeJson({
      publicKey: this.keypair.publicKey.toString('base64url'),
      proof: proof.toString('base64url'),
    });
    await this.manager.runWrite('put', (transport) =>
      (transport as StoreTransport).put(identityKey(this.name, this.identity), body, {
        contentType: JSON_CONTENT_TYPE,
      }),
    );
    this.identityPublished = true;
    this.logger.debug('published peer identity', { identity: this.identity });
  }

  /**
   * Ids of the era keys this peer can open frames with.
   *
   * Ids, never the keys: a key id is a non-secret label already carried in the
   * clear on every frame, so this is safe to report over the control socket and
   * is what tells "enrolled but nothing wrapped for me yet" apart from "wrong
   * secret", two states that otherwise look identical from the outside.
   */
  keyIds(): string[] {
    return this.keys.keyIds;
  }

  /**
   * Every peer whose published identity carries a valid enrollment proof.
   *
   * Verified against every configured secret, not only the first, so a workspace
   * mid-rotation still recognises peers that enrolled under the outgoing one.
   * An identity that fails is dropped and logged at warn: it is either a peer
   * using a different secret or someone who can write to the store trying to
   * enrol themselves, and both are worth seeing rather than swallowing.
   */
  async identities(): Promise<Array<{ peerId: string; publicKey: Buffer }>> {
    const accepted = new Map<string, Buffer>();
    for (const entry of this.manager.stores()) {
      const store = entry.transport as StoreTransport;
      let listed;
      try {
        listed = await store.list(identityPrefix(this.name), { limit: 500 });
      } catch (error) {
        this.logger.warn('identity listing failed', {
          transport: entry.name,
          error: DeadDropError.from(error).message,
        });
        continue;
      }
      for (const item of listed.entries) {
        const peerId = parseIdentityKey(this.name, item.key);
        if (peerId === undefined || accepted.has(peerId)) continue;
        const raw = await store.get(item.key).catch(() => undefined);
        if (!raw) continue;
        const publicKey = this.verifyIdentity(peerId, raw);
        if (publicKey) accepted.set(peerId, publicKey);
      }
    }
    return [...accepted].map(([peerId, publicKey]) => ({ peerId, publicKey }));
  }

  private verifyIdentity(peerId: string, raw: Uint8Array): Buffer | undefined {
    let publicKey: Buffer;
    let proof: Buffer;
    try {
      const body = decodeJson(raw) as { publicKey?: unknown; proof?: unknown };
      if (typeof body.publicKey !== 'string' || typeof body.proof !== 'string') return undefined;
      publicKey = Buffer.from(body.publicKey, 'base64url');
      proof = Buffer.from(body.proof, 'base64url');
    } catch {
      return undefined;
    }
    const valid = this.config.secrets.some((secret) =>
      verifyEnrollmentProof(secret, this.name, peerId, publicKey, proof),
    );
    if (!valid) {
      this.logger.warn('rejected a peer identity with an invalid enrollment proof', { peerId });
      return undefined;
    }
    return publicKey;
  }

  /**
   * Unwraps every era key addressed to this peer and adds it to the ring.
   *
   * One prefix listing, because wrapped keys are grouped by peer. Failures are
   * per object and never fatal: an object that does not unwrap is one this peer
   * was not the recipient of, or one a hostile writer planted, and neither is a
   * reason to stop taking delivery of the rest.
   */
  private async loadWrappedKeys(): Promise<void> {
    for (const entry of this.manager.stores()) {
      const store = entry.transport as StoreTransport;
      let listed;
      try {
        listed = await store.list(wrappedKeyPrefix(this.name, this.identity), { limit: 500 });
      } catch (error) {
        this.logger.debug('wrapped key listing failed', {
          transport: entry.name,
          error: DeadDropError.from(error).message,
        });
        continue;
      }
      for (const item of listed.entries) {
        const raw = await store.get(item.key).catch(() => undefined);
        if (!raw) continue;
        const wrapped = decodeWrappedKey(raw);
        if (!wrapped) continue;
        // Already held, so unwrapping again would be work for nothing. This is
        // what makes the pass cheap to repeat on every tick.
        if (this.keys.has(wrapped.eraId)) continue;
        try {
          this.keys.add(unwrapEraKey(wrapped, this.keypair.publicKey, this.keypair.privateKey));
          this.logger.info('accepted a wrapped era key', { eraId: wrapped.eraId });
        } catch (error) {
          this.logger.debug('a wrapped key did not unwrap', {
            key: item.key,
            error: DeadDropError.from(error).message,
          });
        }
      }
    }
  }

  /** Runs one maintenance pass, never more than one at a time. See `reap`. */
  private maintain(): void {
    if (this.reaping) return;
    this.reaping = this.reap()
      .catch((error: unknown) => {
        this.logger.debug('maintenance pass failed', { error: String(error) });
      })
      .finally(() => {
        this.reaping = undefined;
      });
  }

  /**
   * Deletes stale presence beacons and inbox objects addressed to peers that
   * are gone. [ADR 0006](../../docs/adr/0006-reaping-orphaned-inboxes.md).
   *
   * Nothing but a peer itself ever empties its own inbox, so without this a
   * message addressed to a peer that never returns is storage no process ever
   * reclaims. Reaping is not a new privilege: every member already holds the
   * workspace secret and already has unrestricted `delete` on the store, so a
   * hostile member could clear every inbox today. What changes is that
   * *correct* peers now delete data they did not author, which makes accidental
   * loss the risk to design against, and that is what sets the two horizons.
   *
   * Age comes from the message id in the key, never from the frame. The objects
   * worth reaping are the large ones, so deciding by download would mean
   * fetching the entire leak in order to decide to delete it, and `modifiedAt`
   * is optional in the store contract besides. This is emphatically **not** the
   * per-message TTL: that lives in the encrypted header and only the recipient
   * can read it, so a message that asked for no expiry is still subject to this.
   */
  private async reap(): Promise<void> {
    if (this.inboxOrphanMs <= 0) return;
    const now = this.clock.now();
    if (now < this.nextReapAt) return;

    const beacons = await this.listBeacons();
    // Absence of a beacon is the whole liveness signal, so a store that did not
    // answer is indistinguishable from a workspace where nobody is alive. Act
    // on a partial view and a transient outage becomes permanent data loss.
    if (beacons.read === 0 || beacons.unreadable.length > 0) {
      this.scheduleNextReap(now, false);
      return;
    }

    const present = new Set(beacons.found.map((beacon) => beacon.peerId));
    const orphanCutoff = now - this.inboxOrphanMs;
    const beaconCutoff = now - this.presenceTtlMs * STALE_BEACON_TTLS;
    let failed = false;
    // Set when the inbox view is incomplete, which makes `withMail` a subset of
    // the peers that really have a backlog. Reaping messages on a partial view
    // is safe -- every object considered was really seen -- but reaping beacons
    // is not, because a beacon is protected by mail we may not have looked at.
    let partial = false;

    const withMail = new Set<string>();
    for (const entry of this.manager.stores()) {
      const store = entry.transport as StoreTransport;
      let reaped = 0;
      let bytes = 0;
      const peers = new Set<string>();
      try {
        let cursor: string | undefined;
        let scanned = 0;
        do {
          const page = await store.list(inboxRoot(this.name), {
            limit: QUEUE_PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
          });
          for (const item of page.entries) {
            const parsed = parseInboxKey(this.name, item.key);
            if (!parsed) continue;
            // This peer's own inbox is reaped by delivering from it.
            if (parsed.peerId === this.peerId) continue;
            withMail.add(parsed.peerId);
            const announcedAt = present.has(parsed.peerId)
              ? (beacons.records.get(parsed.peerId)?.announcedAt ?? Number.POSITIVE_INFINITY)
              : undefined;
            // Offline is not orphaned. A peer with a fresh beacon and a backlog
            // is one that has not drained yet, and its mail is exactly what a
            // mailbox exists to hold. Both conditions have to hold.
            if (announcedAt !== undefined && announcedAt >= orphanCutoff) continue;
            const createdAt = idTime(parsed.messageId);
            if (createdAt === undefined || createdAt >= orphanCutoff) continue;
            try {
              await store.delete(item.key);
            } catch (error) {
              failed = true;
              this.logger.debug('failed to reap orphaned message', {
                key: item.key,
                error: String(error),
              });
              continue;
            }
            this.metrics.messagesDropped.inc({ reason: 'orphaned' });
            reaped += 1;
            bytes += item.size;
            peers.add(parsed.peerId);
          }
          scanned += page.entries.length;
          cursor = page.cursor;
          if (cursor && scanned >= QUEUE_SCAN_LIMIT) {
            // Whatever is left is reaped by a later pass. The cap exists so one
            // enormous inbox cannot hold the maintenance loop open forever.
            partial = true;
            break;
          }
        } while (cursor);
      } catch (error) {
        partial = true;
        this.logger.debug('inbox listing failed during reap', {
          transport: entry.name,
          error: String(error),
        });
      }
      if (reaped > 0) {
        // Warn, not info: this deletes another peer's data unattended, so it
        // has to be visible in `ddrop logs` without turning debug on.
        this.logger.warn('reaped orphaned inbox messages', {
          transport: entry.name,
          peers: [...peers].sort(),
          count: reaped,
          bytes,
        });
      }
    }

    for (const beacon of partial ? [] : beacons.found) {
      if (beacon.peerId === this.peerId) continue;
      // A beacon is the only evidence that its owner's backlog is worth
      // keeping, so leave it standing while there is a backlog to protect.
      // Once the mail is gone the beacon goes on a later pass.
      if (withMail.has(beacon.peerId)) continue;
      const record = beacons.records.get(beacon.peerId);
      // A beacon we cannot decode belongs to a key era we do not hold. Its
      // owner may be alive and republishing it; we simply cannot read it.
      if (!record || record.announcedAt >= beaconCutoff) continue;
      try {
        await beacon.store.delete(beacon.key);
        this.logger.warn('reaped stale presence beacon', {
          transport: beacon.transport,
          peer: beacon.peerId,
          announcedAt: record.announcedAt,
        });
      } catch (error) {
        failed = true;
        this.logger.debug('failed to reap stale beacon', {
          key: beacon.key,
          error: String(error),
        });
      }
    }

    this.scheduleNextReap(now, failed);
  }

  /**
   * Sets the earliest time the next pass may run.
   *
   * A refused delete leaves the condition that triggered it true, so a pass
   * that keeps failing would otherwise retry at full rate for the life of the
   * process. Backing off turns a permanently unwritable store into a handful of
   * wasted listings a day, and one clean pass restores the normal cadence.
   */
  private scheduleNextReap(now: number, failed: boolean): void {
    this.reapBackoff = failed ? Math.min(this.reapBackoff * 2, REAP_BACKOFF_CAP) : 1;
    this.nextReapAt = now + this.presenceTtlMs * STALE_BEACON_TTLS * this.reapBackoff;
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
