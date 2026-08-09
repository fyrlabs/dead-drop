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

export type MessageHandler = (envelope: Envelope) => Promise<void>;

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
   * Messages processed concurrently within one poll. Default 1.
   *
   * The trade is ordering. At 1 a batch is delivered in key order, which is id
   * order, which is roughly send order. Above 1 the handlers of one batch run
   * interleaved and finish in whatever order they finish, so a peer can see
   * two messages answered out of the order they were sent. Invariant 4 only
   * promises best-effort ordering per recipient, so this is allowed, but it is
   * a real change for a handler that quietly relied on the stricter behaviour.
   * That is why the default stays 1 and raising it is opt-in.
   *
   * What it does *not* trade is correctness of the shared state `consume`
   * touches. `dedupe.claim` is a synchronous check-and-set and `delivery` is
   * keyed by object key, which is unique within a batch, so no two parallel
   * consumes read or write the same entry. Keep both properties if you change
   * this: an `await` inserted between the dedupe check and its record would
   * make duplicates deliverable twice.
   *
   * Cost to expect: a batch holds up to `concurrency` payloads in memory at
   * once instead of one.
   */
  concurrency?: number;
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
  /** Write through every healthy transport instead of just the best one. */
  broadcastTransports?: boolean;
  /** Restrict to these transport instance names. */
  only?: string[];
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
  private inflight = 0;
  private lastReapAt = 0;

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

        if (options.broadcastTransports) {
          await this.manager.runAll('put', (transport) => write(transport as StoreTransport), {
            requirements,
            ...(options.signal ? { signal: options.signal } : {}),
            ...(trace ? { trace } : {}),
          });
        } else {
          await this.manager.run('put', (transport) => write(transport as StoreTransport), {
            requirements,
            ...(options.signal ? { signal: options.signal } : {}),
            ...(trace ? { trace } : {}),
          });
        }
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
    await this.dedupe.flush(true);
  }

  stats(): MailboxStats {
    return {
      running: this.running,
      pollIntervalMs: this.pollIntervalMs,
      concurrency: this.concurrency,
      inflight: this.inflight,
      retrying: this.delivery.size,
      pendingChunkGroups: this.assembler.pendingGroups,
      subscribedTopics: [...this.topics],
      dedupeSize: this.dedupe.size,
    };
  }

  /** Runs one poll cycle. Exposed so tests do not have to wait on a timer. */
  async pollOnce(): Promise<number> {
    if (!this.handler) {
      // Silently acknowledging messages with nowhere to deliver them would look
      // like successful delivery and lose the data.
      throw new DeadDropError('INTERNAL', 'mailbox has no message handler; call setHandler first');
    }
    let delivered = 0;
    for (const entry of this.manager.stores()) {
      delivered += await this.pollInbox(entry);
      for (const channel of this.topics) {
        delivered += await this.pollTopic(entry, channel);
      }
    }
    await this.reapTopics();
    await this.dedupe.flush();
    return delivered;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let delivered = 0;
      try {
        delivered = await this.pollOnce();
      } catch (error) {
        const deadDropError = DeadDropError.from(error);
        if (deadDropError.code !== 'CANCELLED') {
          this.logger.warn('poll cycle failed', { error: deadDropError.message });
        }
      }
      // Speed up while traffic flows, back off when idle. Polling a rate-limited
      // API every 250ms forever is how a transport gets throttled.
      this.pollIntervalMs =
        delivered > 0
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

  private async pollInbox(entry: ManagedTransport): Promise<number> {
    const store = entry.transport as StoreTransport;
    const prefix = inboxPrefix(this.workspace, this.peerId);
    const listed = await this.safeList(entry, prefix, { limit: this.batchSize });
    if (listed.length === 0) return 0;

    const now = this.clock.now();
    const ready = listed.filter((key) => {
      const state = this.delivery.get(key);
      return !state || state.nextAttemptAt <= now;
    });

    let delivered = 0;
    for (const batch of chunks(ready, this.concurrency)) {
      const results = await Promise.all(
        batch.map((key) => this.consume(entry, store, key, /* acknowledge */ true)),
      );
      delivered += results.filter(Boolean).length;
    }
    return delivered;
  }

  private async pollTopic(entry: ManagedTransport, channel: string): Promise<number> {
    const store = entry.transport as StoreTransport;
    const prefix = topicPrefix(this.workspace, channel);
    const cursorKey = `${entry.name}:${channel}`;
    const startAfter = this.topicCursors.get(cursorKey);
    const options: ListOptions = { limit: this.batchSize };
    if (startAfter) options.startAfter = startAfter;

    const listed = await this.safeList(entry, prefix, options);
    if (listed.length === 0) return 0;

    let delivered = 0;
    for (const key of listed) {
      // Broadcast messages belong to every subscriber, so they are never
      // deleted on consumption; the cursor is what stops redelivery here and
      // retention reaping is what eventually removes them.
      if (await this.consume(entry, store, key, /* acknowledge */ false)) delivered += 1;
      this.topicCursors.set(cursorKey, key);
    }
    return delivered;
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
  ): Promise<boolean> {
    const handler = this.handler;
    if (!handler) return false;
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

      const assembled = this.assembleOrHold(envelope, key, store, acknowledge);
      if (!assembled) return false;

      if (!this.dedupe.claim(dedupeKey(assembled))) {
        this.metrics.messagesDropped.inc({ reason: 'duplicate' });
        if (acknowledge) await this.remove(store, key);
        this.delivery.delete(key);
        return false;
      }

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
    } finally {
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

function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}
