import { describe, expect, it } from 'vitest';

import {
  DeadDropError,
  KeyRing,
  createEnvelope,
  decodeFrame,
  generateWorkspaceSecret,
  type Envelope,
} from '@fyrlabs/dead-drop-protocol';

import type { TestClock } from './clock.js';
import { deadLetterPrefix, inboxKey, inboxPrefix, messageIdFromKey, topicPrefix } from './keys.js';
import { MailboxEngine, type MailboxOptions } from './mailbox.js';
import { MetricsRegistry } from './observability/metrics.js';
import { Tracer } from './observability/tracer.js';
import { DedupeStore } from './reliability/dedupe.js';
import { faultyTransport, harness, type FaultyStore } from './testing.js';
import { TransportManager } from './transport-manager.js';

const WORKSPACE = 'demo';
const SECRET = generateWorkspaceSecret();
/** Fixed clock base. Envelopes must be stamped with it or ttl maths is nonsense. */
const BASE_TIME = 1_700_000_000_000;

interface Fixture {
  clock: TestClock;
  metrics: MetricsRegistry;
  manager: TransportManager;
  store: FaultyStore;
  mailbox: MailboxEngine;
  received: Envelope[];
  start(): Promise<void>;
  stop(): Promise<void>;
}

async function fixture(
  options: {
    peerId?: string;
    mailbox?: Partial<MailboxOptions>;
    store?: Parameters<typeof faultyTransport>[1];
    capabilities?: Parameters<typeof faultyTransport>[2];
    objects?: Map<string, Uint8Array>;
    handler?: (envelope: Envelope) => Promise<void>;
    encrypted?: boolean;
    tracer?: Tracer;
  } = {},
): Promise<Fixture> {
  const { clock, logger } = harness(BASE_TIME);
  const metrics = new MetricsRegistry();
  const peerId = options.peerId ?? 'peer-a';
  const { registration, store } = faultyTransport(
    'alpha',
    { ...(options.objects ? { objects: options.objects } : {}), ...options.store },
    options.capabilities,
  );
  const manager = new TransportManager({
    workspace: WORKSPACE,
    peerId,
    registrations: [registration],
    clock,
    logger,
    metrics,
    retry: { maxAttempts: 1 },
    ...(options.tracer ? { tracer: options.tracer } : {}),
  });
  await manager.start();

  const received: Envelope[] = [];
  const mailbox = new MailboxEngine({
    workspace: WORKSPACE,
    peerId,
    manager,
    clock,
    logger,
    metrics,
    dedupe: new DedupeStore({ clock }),
    ...(options.tracer ? { tracer: options.tracer } : {}),
    ...(options.encrypted === false ? {} : { keys: KeyRing.fromSecrets(WORKSPACE, [SECRET]) }),
    ...options.mailbox,
  });

  const handler =
    options.handler ??
    (async (envelope: Envelope) => {
      received.push(envelope);
    });

  mailbox.setHandler(handler);

  return {
    clock,
    metrics,
    manager,
    store,
    mailbox,
    received,
    start: () => mailbox.start(handler),
    stop: async () => {
      await mailbox.stop();
      await manager.stop();
    },
  };
}

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return createEnvelope({
    workspace: WORKSPACE,
    kind: 'event',
    channel: 'orders',
    from: 'peer-a',
    to: 'peer-b',
    contentType: 'application/json',
    ts: BASE_TIME,
    payload: new TextEncoder().encode('{"ok":true}'),
    ...overrides,
  });
}

describe('MailboxEngine send', () => {
  it('writes an encrypted frame into the recipient inbox', async () => {
    const context = await fixture();
    const message = envelope();
    await context.mailbox.send(message);

    const key = inboxKey(WORKSPACE, 'peer-b', message.id);
    const frame = context.store.objects.get(key);
    expect(frame).toBeDefined();
    expect(Buffer.from(frame!).includes('orders')).toBe(false);

    const decoded = await decodeFrame(frame!, { keys: KeyRing.fromSecrets(WORKSPACE, [SECRET]) });
    expect(decoded.envelope.channel).toBe('orders');
    expect(context.metrics.messagesSent.get({ kind: 'event', channel: 'orders' })).toBe(1);
  });

  it('writes a broadcast message into the topic prefix', async () => {
    const context = await fixture();
    const message = envelope({ to: undefined, channel: 'events/orders' });
    await context.mailbox.send(message);
    const keys = [...context.store.objects.keys()];
    expect(keys[0]?.startsWith(topicPrefix(WORKSPACE, 'events/orders'))).toBe(true);
  });

  it('applies a default ttl when one is configured', async () => {
    const context = await fixture({ mailbox: { defaultTtlMs: 5000 } });
    const message = envelope();
    await context.mailbox.send(message);
    const stored = [...context.store.objects.values()][0]!;
    const decoded = await decodeFrame(stored, { keys: KeyRing.fromSecrets(WORKSPACE, [SECRET]) });
    expect(decoded.envelope.ttlMs).toBe(5000);
  });

  it('refuses a payload over the configured message limit', async () => {
    const context = await fixture({ mailbox: { maxMessageBytes: 1024 } });
    await expect(
      context.mailbox.send(envelope({ payload: new Uint8Array(2048) })),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(context.metrics.messagesDropped.get({ reason: 'send-failed' })).toBe(1);
  });

  it('splits a large payload across the transport object limit', async () => {
    const context = await fixture({ store: { maxPayloadBytes: 8192 } });
    const payload = new Uint8Array(40_000);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xff;
    await context.mailbox.send(envelope({ payload }));
    expect(context.store.objects.size).toBeGreaterThan(1);
    for (const frame of context.store.objects.values()) {
      expect(frame.length).toBeLessThanOrEqual(8192);
    }
  });
});

describe('MailboxEngine tracing', () => {
  // Without propagation every span is its own single-span trace, which makes
  // `ddrop trace` useless. The parent link is the thing worth guarding.
  it('keys the send trace to the message id and parents the transport write to it', async () => {
    const tracer = new Tracer();
    const context = await fixture({ tracer });
    const message = envelope();
    await context.mailbox.send(message);
    await context.stop();

    const spans = tracer.trace(message.id);
    const send = spans.find((span) => span.name === 'mailbox.send');
    const put = spans.find((span) => span.name === 'transport.put');
    expect(send).toBeDefined();
    expect(put?.parentSpanId).toBe(send?.spanId);
    // Nothing about this message landed in some other trace.
    expect(spans).toHaveLength(tracer.spans().filter((span) => span.traceId === message.id).length);
  });

  it('joins a response to the trace of the request it answers', async () => {
    const tracer = new Tracer();
    const objects = new Map<string, Uint8Array>();
    const sender = await fixture({ peerId: 'peer-sender', objects });
    const requestId = 'msg_01REQUEST';
    await sender.mailbox.send(
      envelope({ to: 'peer-b', kind: 'response', correlationId: requestId }),
    );
    await sender.stop();

    const receiver = await fixture({ peerId: 'peer-b', objects, tracer });
    expect(await receiver.mailbox.pollOnce()).toBe(1);
    await receiver.stop();

    expect(tracer.trace(requestId).map((span) => span.name)).toContain('mailbox.deliver');
  });
});

describe('MailboxEngine receive', () => {
  async function deliver(
    to: string,
    message: Envelope,
    objects: Map<string, Uint8Array>,
  ): Promise<void> {
    const sender = await fixture({ peerId: 'peer-sender', objects });
    await sender.mailbox.send({ ...message, to });
    await sender.stop();
  }

  it('delivers, deduplicates and deletes an inbox message', async () => {
    const objects = new Map<string, Uint8Array>();
    const context = await fixture({ peerId: 'peer-b', objects });
    const message = envelope({ from: 'peer-a', to: 'peer-b' });
    await deliver('peer-b', message, objects);

    expect(await context.mailbox.pollOnce()).toBe(1);
    expect(context.received).toHaveLength(1);
    expect(context.received[0]?.channel).toBe('orders');
    // Delete is the acknowledgement.
    expect([...objects.keys()].filter((key) => key.includes('/inbox/'))).toHaveLength(0);
    expect(context.metrics.messagesReceived.get({ kind: 'event', channel: 'orders' })).toBe(1);
  });

  it('drops a redelivered message as a duplicate', async () => {
    const objects = new Map<string, Uint8Array>();
    const context = await fixture({ peerId: 'peer-b', objects });
    const message = envelope({ to: 'peer-b' });
    await deliver('peer-b', message, objects);
    const key = [...objects.keys()][0]!;
    const frame = objects.get(key)!;

    await context.mailbox.pollOnce();
    objects.set(key, frame); // transport resurrected the object
    await context.mailbox.pollOnce();

    expect(context.received).toHaveLength(1);
    expect(context.metrics.messagesDropped.get({ reason: 'duplicate' })).toBe(1);
  });

  it('drops an expired message without delivering it', async () => {
    const objects = new Map<string, Uint8Array>();
    const context = await fixture({ peerId: 'peer-b', objects });
    await deliver('peer-b', envelope({ to: 'peer-b', ttlMs: 1000 }), objects);
    await context.clock.advance(5000);

    expect(await context.mailbox.pollOnce()).toBe(0);
    expect(context.received).toHaveLength(0);
    expect(context.metrics.messagesDropped.get({ reason: 'expired' })).toBe(1);
    expect(objects.size).toBe(0);
  });

  it('discards undecodable objects instead of looping on them', async () => {
    const objects = new Map<string, Uint8Array>();
    const context = await fixture({ peerId: 'peer-b', objects });
    objects.set(
      inboxKey(WORKSPACE, 'peer-b', 'msg_01HZY0000000000000000000AB'),
      new TextEncoder().encode('this is not a ddrop frame'),
    );

    expect(await context.mailbox.pollOnce()).toBe(0);
    expect(objects.size).toBe(0);
    expect(context.metrics.messagesDropped.get({ reason: 'undecodable' })).toBe(1);
  });

  it('ignores objects addressed to a different workspace', async () => {
    const objects = new Map<string, Uint8Array>();
    const other = await fixture({ peerId: 'peer-b', objects });
    // Encode a frame for another workspace using the same key material path.
    const foreign = createEnvelope({
      workspace: 'other',
      kind: 'event',
      channel: 'orders',
      from: 'peer-x',
      to: 'peer-b',
    });
    const sender = new MailboxEngine({
      workspace: 'other',
      peerId: 'peer-x',
      manager: other.manager,
      clock: other.clock,
      keys: KeyRing.fromSecrets(WORKSPACE, [SECRET]),
    });
    await sender.send(foreign);
    // Move it into this peer's inbox under the demo workspace prefix.
    const original = [...objects.entries()][0]!;
    objects.delete(original[0]);
    objects.set(inboxKey(WORKSPACE, 'peer-b', foreign.id), original[1]);

    expect(await other.mailbox.pollOnce()).toBe(0);
    expect(other.metrics.messagesDropped.get({ reason: 'wrong-workspace' })).toBe(1);
  });

  it('reassembles a chunked message before dispatching it', async () => {
    const objects = new Map<string, Uint8Array>();
    const context = await fixture({
      peerId: 'peer-b',
      objects,
      store: { maxPayloadBytes: 8192 },
    });
    const payload = new Uint8Array(40_000);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 13) & 0xff;

    const sender = await fixture({ peerId: 'peer-a', objects, store: { maxPayloadBytes: 8192 } });
    await sender.mailbox.send(envelope({ to: 'peer-b', payload }));
    await sender.stop();
    expect(objects.size).toBeGreaterThan(1);

    await context.mailbox.pollOnce();
    expect(context.received).toHaveLength(1);
    expect(Buffer.from(context.received[0]!.payload).equals(Buffer.from(payload))).toBe(true);
    expect([...objects.keys()].filter((key) => key.includes('/inbox/'))).toHaveLength(0);
  });
});

describe('MailboxEngine redelivery and dead letters', () => {
  it('retries a failing handler with backoff, then succeeds', async () => {
    const objects = new Map<string, Uint8Array>();
    let attempts = 0;
    const context = await fixture({
      peerId: 'peer-b',
      objects,
      mailbox: {
        maxDeliveryAttempts: 5,
        redeliveryPolicy: { initialDelayMs: 1000, jitter: 'none' },
      },
      handler: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('handler exploded');
      },
    });
    const sender = await fixture({ peerId: 'peer-a', objects });
    await sender.mailbox.send(envelope({ to: 'peer-b' }));
    await sender.stop();

    expect(await context.mailbox.pollOnce()).toBe(0);
    expect(objects.size).toBe(1); // still queued
    // Too soon: the backoff window has not elapsed.
    expect(await context.mailbox.pollOnce()).toBe(0);
    expect(attempts).toBe(1);

    await context.clock.advance(5000);
    expect(await context.mailbox.pollOnce()).toBe(0);
    await context.clock.advance(30_000);
    expect(await context.mailbox.pollOnce()).toBe(1);
    expect(attempts).toBe(3);
    expect(objects.size).toBe(0);
  });

  it('dead-letters a message once attempts run out', async () => {
    const objects = new Map<string, Uint8Array>();
    const context = await fixture({
      peerId: 'peer-b',
      objects,
      mailbox: { maxDeliveryAttempts: 2, redeliveryPolicy: { initialDelayMs: 10, jitter: 'none' } },
      handler: async () => {
        throw new DeadDropError('SERVICE_ERROR', 'always fails');
      },
    });
    const sender = await fixture({ peerId: 'peer-a', objects });
    await sender.mailbox.send(envelope({ to: 'peer-b' }));
    await sender.stop();

    await context.mailbox.pollOnce();
    await context.clock.advance(10_000);
    await context.mailbox.pollOnce();

    const dead = [...objects.keys()].filter((key) =>
      key.startsWith(deadLetterPrefix(WORKSPACE, 'peer-b')),
    );
    expect(dead).toHaveLength(1);
    expect([...objects.keys()].filter((key) => key.includes('/inbox/'))).toHaveLength(0);
    expect(context.metrics.messagesDropped.get({ reason: 'dead-letter' })).toBe(1);
  });

  it('releases the dedupe claim so a retry is not swallowed', async () => {
    const objects = new Map<string, Uint8Array>();
    let calls = 0;
    const context = await fixture({
      peerId: 'peer-b',
      objects,
      mailbox: { redeliveryPolicy: { initialDelayMs: 1, jitter: 'none' } },
      handler: async () => {
        calls += 1;
        if (calls === 1) throw new Error('first attempt fails');
      },
    });
    const sender = await fixture({ peerId: 'peer-a', objects });
    await sender.mailbox.send(envelope({ to: 'peer-b' }));
    await sender.stop();

    await context.mailbox.pollOnce();
    await context.clock.advance(1000);
    expect(await context.mailbox.pollOnce()).toBe(1);
    expect(calls).toBe(2);
  });
});

describe('MailboxEngine topics', () => {
  it('delivers broadcast messages and resumes from a cursor', async () => {
    const objects = new Map<string, Uint8Array>();
    const context = await fixture({ peerId: 'peer-b', objects });
    context.mailbox.subscribeTopic('events/orders');

    const sender = await fixture({ peerId: 'peer-a', objects });
    await sender.mailbox.send(envelope({ to: undefined, channel: 'events/orders' }));
    await sender.mailbox.send(envelope({ to: undefined, channel: 'events/orders' }));

    expect(await context.mailbox.pollOnce()).toBe(2);
    expect(context.received).toHaveLength(2);
    // Broadcast messages stay put for other subscribers.
    expect(objects.size).toBe(2);
    // The cursor stops them being redelivered here.
    expect(await context.mailbox.pollOnce()).toBe(0);

    await sender.mailbox.send(envelope({ to: undefined, channel: 'events/orders' }));
    expect(await context.mailbox.pollOnce()).toBe(1);
    await sender.stop();
  });

  it('ignores topics that were unsubscribed', async () => {
    const objects = new Map<string, Uint8Array>();
    const context = await fixture({ peerId: 'peer-b', objects });
    context.mailbox.subscribeTopic('events/orders');
    context.mailbox.unsubscribeTopic('events/orders');

    const sender = await fixture({ peerId: 'peer-a', objects });
    await sender.mailbox.send(envelope({ to: undefined, channel: 'events/orders' }));
    await sender.stop();

    expect(await context.mailbox.pollOnce()).toBe(0);
    expect(context.mailbox.stats().subscribedTopics).toEqual([]);
  });

  it('records a topic handler failure without retrying it', async () => {
    const objects = new Map<string, Uint8Array>();
    const context = await fixture({
      peerId: 'peer-b',
      objects,
      handler: async () => {
        throw new Error('subscriber threw');
      },
    });
    context.mailbox.subscribeTopic('events/orders');
    const sender = await fixture({ peerId: 'peer-a', objects });
    await sender.mailbox.send(envelope({ to: undefined, channel: 'events/orders' }));
    await sender.stop();

    await context.mailbox.pollOnce();
    expect(context.metrics.messagesDropped.get({ reason: 'topic-handler-error' })).toBe(1);
  });
});

describe('MailboxEngine polling', () => {
  it('backs off when idle and speeds up when a message arrives', async () => {
    const objects = new Map<string, Uint8Array>();
    const context = await fixture({
      peerId: 'peer-b',
      objects,
      mailbox: { minPollIntervalMs: 100, maxPollIntervalMs: 2000, pollBackoffFactor: 2 },
    });
    await context.start();

    await context.clock.advance(100);
    expect(context.mailbox.stats().pollIntervalMs).toBeGreaterThan(100);
    await context.clock.advance(10_000);
    expect(context.mailbox.stats().pollIntervalMs).toBe(2000);

    const sender = await fixture({ peerId: 'peer-a', objects });
    await sender.mailbox.send(envelope({ to: 'peer-b' }));
    await sender.stop();

    // Exactly one poll: the loop is parked on a 2000ms timer, and a longer
    // advance would let it idle back off again before we look.
    await context.clock.advance(2000);
    expect(context.received).toHaveLength(1);
    // Delivery reset the interval; it may have started backing off again in the
    // same window, so assert it dropped rather than pinning an exact value.
    expect(context.mailbox.stats().pollIntervalMs).toBeLessThan(2000);
    await context.stop();
  });

  it('refuses to start twice and reports its stats', async () => {
    const context = await fixture({ peerId: 'peer-b' });
    await context.start();
    await expect(context.start()).rejects.toThrowError(/already started/);
    const stats = context.mailbox.stats();
    expect(stats.running).toBe(true);
    expect(stats.inflight).toBe(0);
    await context.stop();
    expect(context.mailbox.stats().running).toBe(false);
  });

  it('survives a transport whose list keeps failing', async () => {
    const context = await fixture({
      peerId: 'peer-b',
      store: { failOperations: ['list'], failCount: Number.POSITIVE_INFINITY },
    });
    expect(await context.mailbox.pollOnce()).toBe(0);
  });
});

describe('mailbox keys', () => {
  it('builds and parses frame keys', () => {
    expect(inboxPrefix('demo', 'peer-b')).toBe('ws/demo/inbox/peer-b');
    expect(inboxKey('demo', 'peer-b', 'msg_1')).toBe('ws/demo/inbox/peer-b/msg_1.ddf');
    expect(topicPrefix('demo', 'events/orders')).toBe('ws/demo/topic/events/orders');
    expect(messageIdFromKey('ws/demo/inbox/peer-b/msg_1.ddf')).toBe('msg_1');
    expect(messageIdFromKey('ws/demo/inbox/peer-b/README.md')).toBeUndefined();
    expect(messageIdFromKey('ws/demo/inbox/peer-b/.ddf')).toBeUndefined();
  });
});
