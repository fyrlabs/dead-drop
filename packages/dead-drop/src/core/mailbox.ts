/**
 * Mailbox engine: at-least-once messaging over a plain object store.
 *
 * This is the layer the transport SDK deliberately does not make adapters
 * implement. Given only put/get/list/delete it provides:
 *
 *   - framing and encryption (via `@fyrlabs/dead-drop/protocol`)
 *   - chunking for transports with object size limits, and reassembly
 *   - delivery: poll the inbox, hand the envelope to a handler, delete on
 *     success (delete *is* the acknowledgement)
 *   - redelivery with backoff, and a dead-letter prefix once attempts run out
 *   - deduplication, so at-least-once behaves like effectively-once
 *   - broadcast topics with a resume cursor and retention reaping
 *   - adaptive polling that speeds up under traffic and backs off when idle
 *
 * Delivery guarantee is at-least-once. Ordering is best-effort per recipient:
 * messages are processed in key order, but a message whose handler fails is
 * retried later and therefore out of order. Blocking the queue head instead
 * would turn one poisoned message into a total outage, which is worse.
 */

import {
  DeadDropError,
  ChunkAssembler,
  chunkEnvelope,
  CHUNK_HEADER_ALLOWANCE_BYTES,
  dedupeKey,
  decodeFrame,
  encodeFrame,
  idTime,
  isExpired,
  type Envelope,
  type KeyRing,
} from '../protocol/index.js';
import type { ListOptions, StoreTransport } from '@fyrlabs/dead-drop-transport-sdk';

import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import {
  deadLetterKey,
  inboxKey,
  inboxPrefix,
  messageIdFromKey,
  topicKey,
  topicPrefix,
} from './keys.js';
import type { Logger } from './observability/logger.js';
import { silentLogger } from './observability/logger.js';
import type { MetricsRegistry } from './observability/metrics.js';
import { MetricsRegistry as Metrics } from './observability/metrics.js';
import { traceContext, type TraceContext, type Tracer } from './observability/tracer.js';
import { DedupeStore } from './reliability/dedupe.js';
import { backoffDelay, DEFAULT_RETRY_POLICY, type RetryPolicy } from './reliability/retry.js';
import type { ManagedTransport, TransportManager } from './transport-manager.js';

const DEFAULT_LANE = 'default';
// Delivered straight from the receive slot; see `consume`.
const INLINE_KINDS: ReadonlySet<Envelope['kind']> = new Set(['response', 'ack', 'control']);

export type MessageHandler = (envelope: Envelope) => Promise<void>;

/** A named limit on how many handlers of some group of messages run at once. */
export interface LaneSpec {
  name: string;
  limit: number;
}

export interface LaneStats {
  name: string;
  limit: number;
  running: number;
  queued: number;
  parked: number;
}

export interface MailboxOptions {
  workspace: string;
  peerId: string;
  manager: TransportManager;
  keys?: KeyRing;
  clock?: Clock;
  logger?: Logger;
  metrics?: MetricsRegistry;
  tracer?: Tracer;
  dedupe?: DedupeStore;
  /** Fastest poll interval, used while messages keep arriving. Default 250ms. */
  minPollIntervalMs?: number;
  /** Slowest poll interval, reached after a quiet spell. Default 15s. */
  maxPollIntervalMs?: number;
  /** Multiplier applied to the interval on an empty poll. Default 1.6. */
  pollBackoffFactor?: number;
  /** Messages fetched per poll. Default 32. */
  batchSize?: number;
  /**
   * Request and event handlers running at once in the default lane, and the
   * messages fetched and decoded at once. Default 1.
   *
   * Responses and acks never wait for a handler, so a handler may call another
   * peer even at 1. Channels that declare their own lane (see `lane`) do not
   * count against this limit.
   *
   * The trade is ordering. At 1 messages are handled in key order, which is id
   * order, which is roughly send order. Above 1 handlers run interleaved and
   * finish in whatever order they finish, so a peer can see two messages
   * answered out of the order they were sent. Invariant 4 only promises
   * best-effort ordering per recipient, so this is allowed, but it is a real
   * change for a handler that quietly relied on the stricter behaviour. That
   * is why the default stays 1 and raising it is opt-in.
   *
   * What it does *not* trade is correctness of the shared state `consume`
   * touches. `dedupe.claim` is a synchronous check-and-set and `delivery` is
   * keyed by object key, which is unique among the keys in flight, so no two
   * parallel consumes read or write the same entry. Keep both properties if
   * you change this: an `await` inserted between the dedupe check and its
   * record would make duplicates deliverable twice.
   *
   * Cost to expect: up to twice a lane's limit in payloads sit in memory, the
   * running ones and the ones queued behind them.
   */
  concurrency?: number;
  /**
   * Picks the lane a request or event runs in. Returning undefined selects the
   * default lane, whose limit is `concurrency`. Responses and acks never ask:
   * they are delivered as soon as they are received.
   */
  lane?: (kind: Envelope['kind'], channel: string) => LaneSpec | undefined;
  /** Handler attempts before a message is dead-lettered. Default 5. */
  maxDeliveryAttempts?: number;
  /** Backoff between redeliveries. */
  redeliveryPolicy?: Partial<RetryPolicy>;
  /** How long broadcast messages are retained before reaping. Default 1 hour. */
  topicRetentionMs?: number;
  /** Refuse to send frames larger than this even after chunking. Default 64 MiB. */
  maxMessageBytes?: number;
  /** Sets the TTL on outbound messages that do not carry one. */
  defaultTtlMs?: number;
}

export interface SendOptions {
  signal?: AbortSignal;
  /** Parents the send span to a caller span already covering this envelope. */
  trace?: TraceContext;
  /** Restrict to these transport instance names. */
  only?: string[];
}

interface Lane {
  name: string;
  limit: number;
  running: number;
  queue: QueuedJob[];
}

interface QueuedJob {
  start: () => void;
  cancel: () => void;
}

interface DeliveryState {
  attempts: number;
  nextAttemptAt: number;
}

export interface MailboxStats {
  running: boolean;
  pollIntervalMs: number;
  /** Messages handled at once. Reported so a config value can be seen to have taken effect. */
  concurrency: number;
  lanes: LaneStats[];
  inflight: number;
  retrying: number;
  pendingChunkGroups: number;
  subscribedTopics: string[];
  dedupeSize: number;
}

export class MailboxEngine {
  private readonly workspace: string;
  private readonly peerId: string;
  private readonly manager: TransportManager;
  private readonly keys: KeyRing | undefined;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly metrics: MetricsRegistry;
  private readonly tracer: Tracer | undefined;
  private readonly dedupe: DedupeStore;
  private readonly assembler: ChunkAssembler;
  private readonly minPollIntervalMs: number;
  private readonly maxPollIntervalMs: number;
  private readonly pollBackoffFactor: number;
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly laneFor: NonNullable<MailboxOptions['lane']>;
  private readonly maxDeliveryAttempts: number;
  private readonly redeliveryPolicy: RetryPolicy;
  private readonly topicRetentionMs: number;
  private readonly maxMessageBytes: number;
  private readonly defaultTtlMs: number | undefined;

  private readonly delivery = new Map<string, DeliveryState>();
  private readonly topicCursors = new Map<string, string>();
  private readonly topics = new Set<string>();
  private readonly stopWatchers: Array<() => Promise<void>> = [];
  private handler: MessageHandler | undefined;
  private running = false;
  private pollIntervalMs: number;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  // Keys are `<transport>:<store key>` throughout. A key is listed again by
  // every poll until its message is acknowledged, so each of the three maps
  // below exists to make the poll skip a key it already has.
  //
  // `active`: being fetched and decoded. Resolves when the message is handed
  // to a lane (or dropped), which is when its receive slot frees up.
  private readonly active = new Map<string, Promise<void>>();
  // Handed to a lane: queued behind a running handler, or running.
  private readonly held = new Set<string>();
  // Refused because its lane had no room. Not fetched again until a place in
  // that lane opens; the value is the lane name.
  private readonly parked = new Map<string, string>();
  private readonly lanes = new Map<string, Lane>();
  private readonly laneTasks = new Set<Promise<boolean>>();
  private stopping = false;
  private inflight = 0;
  private lastReapAt = 0;
  private awaitingReplies = 0;

  constructor(options: MailboxOptions) {
    this.workspace = options.workspace;
    this.peerId = options.peerId;
    this.manager = options.manager;
    this.keys = options.keys;
    this.clock = options.clock ?? systemClock;
    this.logger = (options.logger ?? silentLogger).child({ component: 'mailbox' });
    this.metrics = options.metrics ?? new Metrics();
    this.tracer = options.tracer;
    this.dedupe = options.dedupe ?? new DedupeStore({ clock: this.clock });
    this.minPollIntervalMs = options.minPollIntervalMs ?? 250;
    this.maxPollIntervalMs = options.maxPollIntervalMs ?? 15_000;
    this.pollBackoffFactor = options.pollBackoffFactor ?? 1.6;
    this.batchSize = options.batchSize ?? 32;
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.laneFor = options.lane ?? (() => undefined);
    this.maxDeliveryAttempts = options.maxDeliveryAttempts ?? 5;
    this.redeliveryPolicy = {
      ...DEFAULT_RETRY_POLICY,
      initialDelayMs: 1000,
      maxDelayMs: 60_000,
      ...options.redeliveryPolicy,
    };
    this.topicRetentionMs = options.topicRetentionMs ?? 60 * 60_000;
    this.maxMessageBytes = options.maxMessageBytes ?? 64 * 1024 * 1024;
    this.defaultTtlMs = options.defaultTtlMs;
    this.pollIntervalMs = this.minPollIntervalMs;
    this.assembler = new ChunkAssembler({
      now: () => this.clock.now(),
      maxMessageBytes: this.maxMessageBytes,
    });
  }

  // ---------------------------------------------------------------- sending

  /**
   * Encodes, chunks and writes an envelope.
   *
   * A message with `to` set lands in that peer's inbox; without it, it lands in
   * the topic prefix for its channel and every subscriber reads it.
   */
  async send(envelope: Envelope, options: SendOptions = {}): Promise<void> {
    const outbound =
      this.defaultTtlMs !== undefined && envelope.ttlMs === undefined
        ? { ...envelope, ttlMs: this.defaultTtlMs }
        : envelope;

    // The envelope id is the trace id. It is already unique, it is what a
    // caller holds after a timeout (`details.requestId`), and using it means
    // every layer can join the same trace without threading a context object
    // through signatures that do not otherwise need one.
    const span = this.tracer?.startSpan('mailbox.send', {
      traceId: outbound.id,
      ...(options.trace?.parentSpanId ? { parentSpanId: options.trace.parentSpanId } : {}),
      attributes: {
        channel: outbound.channel,
        kind: outbound.kind,
        to: outbound.to ?? '(broadcast)',
      },
    });
    const trace = traceContext(span);

    try {
      if (outbound.payload.length > this.maxMessageBytes) {
        throw new DeadDropError(
          'PAYLOAD_TOO_LARGE',
          `payload is ${outbound.payload.length} bytes, limit is ${this.maxMessageBytes}`,
        );
      }
      const chunkLimit = this.chunkLimit(options.only);
      const parts = chunkLimit === undefined ? [outbound] : chunkEnvelope(outbound, chunkLimit);
      if (parts.length > 1) {
        this.logger.debug('splitting message into chunks', {
          messageId: outbound.id,
          chunks: parts.length,
          bytes: outbound.payload.length,
        });
      }

      for (const part of parts) {
        const frame = await encodeFrame(part, this.keys ? { key: this.keys.primary } : {});
        const key = part.to
          ? inboxKey(this.workspace, part.to, part.id)
          : topicKey(this.workspace, part.channel, part.id);

        const write = async (transport: StoreTransport): Promise<void> => {
          await transport.put(key, frame, {
            contentType: 'application/octet-stream',
            ...(options.signal ? { signal: options.signal } : {}),
          });
        };
        const requirements = {
          binaryPayloads: true,
          minPayloadBytes: frame.length,
          ...(options.only ? { only: options.only } : {}),
        };

        await this.manager.runWrite('put', (transport) => write(transport as StoreTransport), {
          requirements,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(trace ? { trace } : {}),
        });
        this.metrics.payloadBytes.observe(frame.length, { direction: 'out' });
      }

      this.metrics.messagesSent.inc({ kind: outbound.kind, channel: outbound.channel });
      span?.end('ok');
    } catch (error) {
      span?.setAttribute('error', String((error as Error).message));
      span?.end('error');
      this.metrics.messagesDropped.inc({ reason: 'send-failed' });
      throw error;
    }
  }

  // -------------------------------------------------------------- receiving

  /** Subscribes to a broadcast channel. Safe to call before or after `start`. */
  subscribeTopic(channel: string): void {
    this.topics.add(channel);
    this.nudge();
  }

  unsubscribeTopic(channel: string): void {
    this.topics.delete(channel);
  }

  /**
   * Installs the message handler without starting the poll loop. `start` calls
   * this; it is separate so a caller can wire the handler up front and drive
   * delivery manually with `pollOnce`.
   */
  setHandler(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Begins polling. `handler` receives every reassembled, deduplicated message. */
  async start(handler: MessageHandler): Promise<void> {
    if (this.running) throw new DeadDropError('INTERNAL', 'mailbox already started');
    this.setHandler(handler);
    this.running = true;
    this.stopping = false;
    await this.dedupe.load();
    await this.attachWatchers();
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.nudge();
    for (const stop of this.stopWatchers.splice(0)) {
      await stop().catch(() => undefined);
    }
    await this.loop?.catch(() => undefined);
    this.loop = undefined;
    // Messages still being received finish, then whatever is queued behind a
    // running handler is dropped unacknowledged (and its dedupe claim
    // released) so it is redelivered after a restart. Running handlers finish.
    this.stopping = true;
    await Promise.allSettled([...this.active.values()]);
    for (const lane of this.lanes.values()) {
      for (const job of lane.queue.splice(0)) job.cancel();
    }
    await Promise.allSettled([...this.laneTasks]);
    await this.dedupe.flush(true);
  }

  stats(): MailboxStats {
    return {
      running: this.running,
      pollIntervalMs: this.pollIntervalMs,
      concurrency: this.concurrency,
      lanes: [...this.lanes.entries()].map(([name, lane]) => ({
        name,
        limit: lane.limit,
        running: lane.running,
        queued: lane.queue.length,
        parked: [...this.parked.values()].filter((parkedLane) => parkedLane === name).length,
      })),
      inflight: this.inflight,
      retrying: this.delivery.size,
      pendingChunkGroups: this.assembler.pendingGroups,
      subscribedTopics: [...this.topics],
      dedupeSize: this.dedupe.size,
    };
  }

  /**
   * Runs one poll cycle and waits for every handler it started. Exposed so
   * tests do not have to wait on a timer. Returns how many messages were
   * delivered.
   */
  async pollOnce(): Promise<number> {
    const started = await this.poll(/* bounded */ false);
    const results = await Promise.all(started);
    return results.filter(Boolean).length;
  }

  /**
   * Lists every source and hands each ready message to a receive slot,
   * returning the handlers it started without waiting for them.
   *
   * `bounded` (the background loop) turns away a message whose lane is full and
   * leaves it in the inbox, parked until the lane has room, so a slow handler
   * never stops the loop and later messages for other lanes still start. A
   * manual `pollOnce` is not bounded: it queues everything it listed and
   * returns once all of it has been handled.
   */
  private async poll(bounded: boolean): Promise<Array<Promise<boolean>>> {
    if (!this.handler) {
      // Silently acknowledging messages with nowhere to deliver them would look
      // like successful delivery and lose the data.
      throw new DeadDropError('INTERNAL', 'mailbox has no message handler; call setHandler first');
    }
    const started: Array<Promise<boolean>> = [];
    for (const entry of this.manager.stores()) {
      await this.pollInbox(entry, bounded, started);
      for (const channel of this.topics) {
        await this.pollTopic(entry, channel, bounded, started);
      }
    }
    await this.reapTopics();
    await this.dedupe.flush();
    return started;
  }

  /**
   * Starts `consume` for one key once a receive slot is free. Receive slots are
   * held only while a message is fetched and decoded, never while application
   * code runs, so waiting for one is short. The promise pushed to `started`
   * settles when the handler has finished, not when the slot frees.
   */
  private async dispatch(
    entry: ManagedTransport,
    key: string,
    acknowledge: boolean,
    bounded: boolean,
    started: Array<Promise<boolean>>,
  ): Promise<void> {
    while (this.active.size >= this.concurrency) {
      await Promise.race(this.active.values());
    }
    const slot = `${entry.name}:${key}`;
    let release!: () => void;
    const received = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.active.set(slot, received);
    void received.then(() => this.active.delete(slot));
    const task = this.consume(
      entry,
      entry.transport as StoreTransport,
      key,
      acknowledge,
      bounded,
      release,
    )
      .catch((error: unknown) => {
        this.logger.warn('message consumption failed', { key, error: String(error) });
        return false;
      })
      .finally(() => {
        release();
        // A finished handler frees a place in its lane: the next message may
        // already be waiting in the listing this cycle had to leave behind.
        if (this.running) this.nudge();
      });
    started.push(task);
  }

  private laneOf(kind: Envelope['kind'], channel: string): Lane {
    const spec = this.laneFor(kind, channel) ?? { name: DEFAULT_LANE, limit: this.concurrency };
    let lane = this.lanes.get(spec.name);
    if (!lane) {
      lane = { name: spec.name, limit: spec.limit, running: 0, queue: [] };
      this.lanes.set(spec.name, lane);
    }
    lane.limit = Math.max(1, spec.limit);
    return lane;
  }

  /** A lane takes one queued message per running slot, so memory stays bounded. */
  private hasRoom(lane: Lane): boolean {
    return lane.queue.length < lane.limit;
  }

  /**
   * Runs `job` in `lane` once a place is free, in arrival order. Resolves with
   * the job's result, or false if the mailbox stops while it is still queued.
   */
  private submit(
    lane: Lane,
    slot: string,
    job: () => Promise<boolean>,
    onCancel: () => void,
  ): Promise<boolean> {
    this.held.add(slot);
    return new Promise<boolean>((resolve) => {
      const start = (): void => {
        lane.running += 1;
        const task: Promise<boolean> = job()
          .catch((error: unknown) => {
            this.logger.warn('message handler crashed', { slot, error: String(error) });
            return false;
          })
          .finally(() => {
            lane.running -= 1;
            this.held.delete(slot);
            this.laneTasks.delete(task);
            this.drain(lane);
          });
        this.laneTasks.add(task);
        void task.then(resolve);
      };
      const cancel = (): void => {
        this.held.delete(slot);
        onCancel();
        resolve(false);
      };
      lane.queue.push({ start, cancel });
      this.drain(lane);
    });
  }

  private drain(lane: Lane): void {
    let opened = 0;
    while (!this.stopping && lane.running < lane.limit) {
      const next = lane.queue.shift();
      if (!next) break;
      opened += 1;
      next.start();
    }
    // A place in the queue opened for each message that moved up, so that many
    // turned-away messages, oldest first, may be fetched again. Releasing all
    // of them would refetch the whole backlog to park most of it once more.
    for (const [slot, parkedLane] of this.parked) {
      if (opened === 0) break;
      if (parkedLane !== lane.name) continue;
      this.parked.delete(slot);
      opened -= 1;
    }
  }

  private async run(): Promise<void> {
    while (this.running) {
      let delivered = 0;
      try {
        // Started, not finished: a message being handled is traffic too.
        delivered = (await this.poll(/* bounded */ true)).length;
      } catch (error) {
        const deadDropError = DeadDropError.from(error);
        if (deadDropError.code !== 'CANCELLED') {
          this.logger.warn('poll cycle failed', { error: deadDropError.message });
        }
      }
      // Speed up while traffic flows, back off when idle. Polling a rate-limited
      // API every 250ms forever is how a transport gets throttled.
      //
      // An outstanding request counts as traffic even though nothing arrived
      // yet, because a reply is known to be coming and the backoff is what
      // decides how late it is noticed. Without this a `ddrop connect` proxy
      // that had been quiet paid the full idle interval on every request: it
      // sent, then slept 15s before looking, on a transport that cannot watch.
      this.pollIntervalMs =
        delivered > 0 || this.awaitingReplies > 0
          ? this.minPollIntervalMs
          : Math.min(
              this.maxPollIntervalMs,
              Math.ceil(this.pollIntervalMs * this.pollBackoffFactor),
            );
      this.metrics.pollIntervalMs.set(this.pollIntervalMs, { workspace: this.workspace });
      if (!this.running) break;
      await this.waitForNextPoll();
    }
  }

  private waitForNextPoll(): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        cancel();
        this.wake = undefined;
        resolve();
      };
      const cancel = this.clock.setTimeout(this.pollIntervalMs, finish);
      this.wake = finish;
    });
  }

  /**
   * Declares that a reply is expected, and holds the poll at its minimum
   * interval until the returned function is called.
   *
   * Idempotent per handle and safe to call before `start`, so a caller can pair
   * it with a request in a `finally` without checking whether the loop is
   * running. The count is what makes it safe under concurrency: six parallel
   * requests take six handles, and the backoff resumes when the last one is
   * released rather than the first.
   */
  expectReply(): () => void {
    this.awaitingReplies += 1;
    this.nudge();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.awaitingReplies -= 1;
    };
  }

  /** Interrupts the poll delay, e.g. because a transport watcher fired. */
  private nudge(): void {
    this.pollIntervalMs = this.minPollIntervalMs;
    this.wake?.();
  }

  private async attachWatchers(): Promise<void> {
    for (const entry of this.manager.stores()) {
      const store = entry.transport as StoreTransport;
      if (!entry.capabilities.watch || typeof store.watch !== 'function') continue;
      try {
        const stop = await store.watch(inboxPrefix(this.workspace, this.peerId), () =>
          this.nudge(),
        );
        this.stopWatchers.push(stop);
      } catch (error) {
        this.logger.debug('transport watch unavailable, polling instead', {
          transport: entry.name,
          error: String(error),
        });
      }
    }
  }

  private async pollInbox(
    entry: ManagedTransport,
    bounded: boolean,
    started: Array<Promise<boolean>>,
  ): Promise<void> {
    const prefix = inboxPrefix(this.workspace, this.peerId);
    // Keys still being handled come back in the listing until they are
    // acknowledged, so they must not eat the batch meant for new messages.
    const listed = await this.safeList(entry, prefix, {
      limit: this.batchSize + this.active.size + this.held.size + this.parked.size,
    });
    // A parked message removed behind our back (expired, reaped) never comes
    // back in a listing; forget it or the listing limit grows without end.
    const listedSlots = new Set(listed.map((key) => `${entry.name}:${key}`));
    for (const slot of this.parked.keys()) {
      if (slot.startsWith(`${entry.name}:`) && !listedSlots.has(slot)) this.parked.delete(slot);
    }
    if (listed.length === 0) return;

    const now = this.clock.now();
    const ready = listed.filter((key) => {
      const slot = `${entry.name}:${key}`;
      if (this.active.has(slot) || this.held.has(slot) || this.parked.has(slot)) return false;
      const state = this.delivery.get(key);
      return !state || state.nextAttemptAt <= now;
    });

    for (const key of ready.slice(0, this.batchSize)) {
      await this.dispatch(entry, key, /* acknowledge */ true, bounded, started);
    }
  }

  private async pollTopic(
    entry: ManagedTransport,
    channel: string,
    bounded: boolean,
    started: Array<Promise<boolean>>,
  ): Promise<void> {
    const prefix = topicPrefix(this.workspace, channel);
    const cursorKey = `${entry.name}:${channel}`;
    const startAfter = this.topicCursors.get(cursorKey);
    const options: ListOptions = { limit: this.batchSize };
    if (startAfter) options.startAfter = startAfter;

    const listed = await this.safeList(entry, prefix, options);
    for (const key of listed) {
      // Broadcast messages belong to every subscriber, so they are never
      // deleted on consumption; the cursor is what stops redelivery here and
      // retention reaping is what eventually removes them. It only moves past
      // a key once that key has a slot and its lane has room, so a full pool
      // or lane leaves the rest for the next cycle.
      if (bounded && !this.hasRoom(this.laneOf('event', channel))) return;
      await this.dispatch(entry, key, /* acknowledge */ false, bounded, started);
      this.topicCursors.set(cursorKey, key);
    }
  }

  private async safeList(
    entry: ManagedTransport,
    prefix: string,
    options: ListOptions,
  ): Promise<string[]> {
    try {
      const result = await this.manager.run(
        'list',
        (transport) => (transport as StoreTransport).list(prefix, options),
        { requirements: { only: [entry.name] } },
      );
      return result.entries
        .map((item) => item.key)
        .filter((key) => messageIdFromKey(key) !== undefined)
        .sort();
    } catch (error) {
      const deadDropError = DeadDropError.from(error);
      if (deadDropError.code !== 'CANCELLED') {
        this.logger.debug('list failed', {
          transport: entry.name,
          prefix,
          error: deadDropError.message,
        });
      }
      return [];
    }
  }

  /** Fetches, decodes and dispatches one object. Returns true if a message was delivered. */
  private async consume(
    entry: ManagedTransport,
    store: StoreTransport,
    key: string,
    acknowledge: boolean,
    bounded: boolean,
    handOff: () => void,
  ): Promise<boolean> {
    const handler = this.handler;
    if (!handler) return false;
    const slot = `${entry.name}:${key}`;
    this.inflight += 1;
    try {
      const raw = await store.get(key).catch((error: unknown) => {
        this.logger.debug('failed to fetch message', { key, error: String(error) });
        return undefined;
      });
      // Absent means another consumer (or a reaper) got there first.
      if (!raw) return false;

      this.metrics.payloadBytes.observe(raw.length, { direction: 'in' });

      let envelope: Envelope;
      try {
        const decoded = await decodeFrame(raw, {
          ...(this.keys ? { keys: this.keys } : {}),
          maxFrameBytes: this.maxMessageBytes,
        });
        envelope = decoded.envelope;
      } catch (error) {
        // Undecodable objects never become decodable. Removing them stops the
        // poller from re-reading the same broken bytes forever.
        this.metrics.messagesDropped.inc({ reason: 'undecodable' });
        this.logger.warn('discarding undecodable object', {
          key,
          transport: entry.name,
          error: DeadDropError.from(error).message,
        });
        if (acknowledge) await this.remove(store, key);
        return false;
      }

      if (envelope.workspace !== this.workspace) {
        this.metrics.messagesDropped.inc({ reason: 'wrong-workspace' });
        return false;
      }
      if (isExpired(envelope, this.clock.now())) {
        this.metrics.messagesDropped.inc({ reason: 'expired' });
        if (acknowledge) await this.remove(store, key);
        this.delivery.delete(key);
        return false;
      }

      // Responses and acks are delivered from the receive slot: they only
      // resolve a waiting caller, and a handler that is itself waiting on one
      // must never be what keeps it out. Everything else runs in a lane.
      const inline = INLINE_KINDS.has(envelope.kind);
      const lane = inline ? undefined : this.laneOf(envelope.kind, envelope.channel);
      // Checked before the chunk is assembled or the message claimed, because
      // both are irreversible: an assembled group's other chunks are already
      // acknowledged. `bounded` is false for a manual `pollOnce` and for
      // topics, whose cursor has already moved past the key. Nothing awaits
      // between this check and `submit`.
      if (lane && bounded && acknowledge && !this.hasRoom(lane)) {
        this.parked.set(slot, lane.name);
        return false;
      }

      const assembled = this.assembleOrHold(envelope, key, store, acknowledge);
      if (!assembled) return false;

      if (!this.dedupe.claim(dedupeKey(assembled))) {
        this.metrics.messagesDropped.inc({ reason: 'duplicate' });
        if (acknowledge) await this.remove(store, key);
        this.delivery.delete(key);
        return false;
      }

      const deliver = async (): Promise<boolean> => {
        // A response joins the trace of the request it answers, so one trace id
        // covers the whole round trip as this peer saw it.
        const span = this.tracer?.startSpan('mailbox.deliver', {
          traceId: assembled.correlationId ?? assembled.id,
          attributes: {
            channel: assembled.channel,
            kind: assembled.kind,
            transport: entry.name,
            messageId: assembled.id,
          },
        });
        try {
          await handler(assembled);
          span?.end('ok');
        } catch (error) {
          // The dedupe claim has to be released, otherwise the redelivery we are
          // about to schedule would be swallowed as a duplicate.
          this.dedupe.delete(dedupeKey(assembled));
          span?.setAttribute('error', String((error as Error).message));
          span?.end('error');
          await this.handleDeliveryFailure(store, key, assembled, error, acknowledge);
          return false;
        }

        this.metrics.messagesReceived.inc({ kind: assembled.kind, channel: assembled.channel });
        this.delivery.delete(key);
        if (acknowledge) await this.remove(store, key);
        return true;
      };

      if (!lane) return await deliver();
      // The key stays listed until `deliver` acknowledges it, so `held` (set by
      // `submit`, synchronously) is what keeps the poll from starting it again.
      // Free the receive slot only after that, so the key is never in neither.
      const result = this.submit(lane, slot, deliver, () =>
        this.dedupe.delete(dedupeKey(assembled)),
      );
      handOff();
      return await result;
    } finally {
      handOff();
      this.inflight -= 1;
    }
  }

  /**
   * Feeds chunks into the assembler. A chunk that completes a group returns the
   * whole message; an intermediate chunk is acknowledged immediately so it is
   * not redelivered while the rest of the group arrives.
   */
  private assembleOrHold(
    envelope: Envelope,
    key: string,
    store: StoreTransport,
    acknowledge: boolean,
  ): Envelope | undefined {
    if (!envelope.chunk) return envelope;
    let assembled: Envelope | undefined;
    try {
      assembled = this.assembler.add(envelope);
    } catch (error) {
      this.metrics.messagesDropped.inc({ reason: 'chunk-error' });
      this.logger.warn('chunk group failed', {
        key,
        groupId: envelope.chunk.groupId,
        error: DeadDropError.from(error).message,
      });
      if (acknowledge) void this.remove(store, key);
      return undefined;
    }
    if (!assembled && acknowledge) void this.remove(store, key);
    return assembled;
  }

  private async handleDeliveryFailure(
    store: StoreTransport,
    key: string,
    envelope: Envelope,
    error: unknown,
    acknowledge: boolean,
  ): Promise<void> {
    const state = this.delivery.get(key) ?? { attempts: 0, nextAttemptAt: 0 };
    state.attempts += 1;
    const deadDropError = DeadDropError.from(error, 'SERVICE_ERROR');

    if (!acknowledge || state.attempts >= this.maxDeliveryAttempts) {
      // Broadcast messages cannot be retried from the store (the cursor has
      // already moved past them), so they fail once and are recorded.
      this.metrics.messagesDropped.inc({
        reason: acknowledge ? 'dead-letter' : 'topic-handler-error',
      });
      this.logger.error('message could not be delivered', {
        messageId: envelope.id,
        channel: envelope.channel,
        attempts: state.attempts,
        error: deadDropError.message,
      });
      if (acknowledge) {
        await this.deadLetter(store, key, envelope, deadDropError);
        await this.remove(store, key);
      }
      this.delivery.delete(key);
      return;
    }

    state.nextAttemptAt = this.clock.now() + backoffDelay(state.attempts, this.redeliveryPolicy);
    this.delivery.set(key, state);
    this.logger.warn('message handler failed, scheduling redelivery', {
      messageId: envelope.id,
      channel: envelope.channel,
      attempt: state.attempts,
      retryInMs: state.nextAttemptAt - this.clock.now(),
      error: deadDropError.message,
    });
  }

  private async deadLetter(
    store: StoreTransport,
    key: string,
    envelope: Envelope,
    error: DeadDropError,
  ): Promise<void> {
    try {
      const raw = await store.get(key);
      if (!raw) return;
      await store.put(deadLetterKey(this.workspace, this.peerId, envelope.id), raw, {
        contentType: 'application/octet-stream',
      });
    } catch (cause) {
      this.logger.error('failed to write dead letter', {
        messageId: envelope.id,
        reason: error.message,
        error: String(cause),
      });
    }
  }

  private async remove(store: StoreTransport, key: string): Promise<void> {
    try {
      await store.delete(key);
    } catch (error) {
      // A failed delete means redelivery, which dedupe already covers.
      this.logger.debug('failed to delete consumed message', { key, error: String(error) });
    }
  }

  /** Deletes broadcast messages older than the retention window. */
  private async reapTopics(): Promise<void> {
    if (this.topics.size === 0) return;
    const now = this.clock.now();
    if (now - this.lastReapAt < this.topicRetentionMs / 4) return;
    this.lastReapAt = now;
    const cutoff = now - this.topicRetentionMs;

    for (const entry of this.manager.stores()) {
      const store = entry.transport as StoreTransport;
      for (const channel of this.topics) {
        const prefix = topicPrefix(this.workspace, channel);
        try {
          const listed = await store.list(prefix, { limit: 200 });
          for (const item of listed.entries) {
            const id = messageIdFromKey(item.key);
            if (!id) continue;
            // Age comes from the message id first: it is the sender's own
            // timestamp and always present, whereas `modifiedAt` is optional and
            // is whatever the backend felt like reporting. Treating "age
            // unknown" as "old enough to delete" would destroy broadcast
            // messages before other subscribers ever saw them.
            const createdAt = idTime(id) ?? item.modifiedAt;
            if (createdAt === undefined || createdAt > cutoff) continue;
            await store.delete(item.key);
          }
        } catch (error) {
          this.logger.debug('topic reap failed', { channel, error: String(error) });
        }
      }
    }
  }

  /**
   * Largest payload we may put in one frame, from the tightest limit among the
   * transports that could carry it. `undefined` means no transport has a limit.
   */
  private chunkLimit(only?: string[]): number | undefined {
    const limits = this.manager
      .stores()
      .filter((entry) => !only || only.includes(entry.name))
      .map((entry) => entry.capabilities.maxPayloadBytes)
      .filter((limit): limit is number => typeof limit === 'number');
    if (limits.length === 0) return undefined;
    const smallest = Math.min(...limits);
    return Math.max(1024, smallest - CHUNK_HEADER_ALLOWANCE_BYTES);
  }
}
