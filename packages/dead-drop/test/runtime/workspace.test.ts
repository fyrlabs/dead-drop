/**
 * Workspace start-up, presence, and queued depth.
 *
 * The presence beacon is the one thing a workspace does on its own schedule
 * rather than because a caller asked, so it is the one thing that can turn a
 * slow transport into a failing one without anybody making a request.
 */

import { describe, expect, it } from 'vitest';

import type {
  ListOptions,
  ListResult,
  ObjectEntry,
  StoreTransport,
  TransportHealth,
} from '@fyrlabs/dead-drop-transport-sdk';
import { defineTransport, type TransportRegistration } from '@fyrlabs/dead-drop-transport-sdk';

import {
  createEnvelope,
  createMessageId,
  DeadDropError,
  encodeFrame,
  encodeJson,
  enrollmentProof,
  generateEraKey,
  generateIdentity,
  generateWorkspaceSecret,
  wrapEraKey,
  JSON_CONTENT_TYPE,
  KeyRing,
} from '#dead-drop/protocol/index.js';
import { identityKey, inboxKey, peerKey, wrappedKeyKey } from '#dead-drop/core/keys.js';
import { TestClock } from '#dead-drop/core/clock.js';
import { createLogger, MemoryLogSink } from '#dead-drop/core/observability/logger.js';

import { encodeWrappedKey, Workspace } from '#dead-drop/runtime/workspace.js';

const SECRET = 'ddk1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** A store whose `put` never settles until the test releases it. */
class HangingStore implements StoreTransport {
  readonly kind = 'store' as const;
  readonly inflight: Array<() => void> = [];
  /**
   * Beacon puts only. Enrollment publishes an identity object on start too
   * (ADR 0007), and counting every put would make these assertions depend on
   * how many unrelated things a workspace happens to write at start-up.
   */
  puts = 0;

  async put(key: string): Promise<{ key: string }> {
    if (key.startsWith('ws/demo/peers/')) this.puts += 1;
    await new Promise<void>((resolve) => this.inflight.push(resolve));
    return { key: 'ok' };
  }

  async get(): Promise<Uint8Array | undefined> {
    return undefined;
  }

  async list(): Promise<{ entries: [] }> {
    return { entries: [] };
  }

  async delete(): Promise<void> {}

  healthChecks = 0;

  async health(): Promise<TransportHealth> {
    this.healthChecks += 1;
    return { status: 'healthy', latencyMs: 1 };
  }

  async close(): Promise<void> {}
}

/**
 * A store holding a fixed set of keys, paginating exactly like the real ones:
 * lexicographic order, `limit` honoured, cursor set only when more remains.
 */
class ListingStore implements StoreTransport {
  readonly kind = 'store' as const;
  listCalls = 0;
  /**
   * Non-retryable on purpose. The mailbox's own poll runs `list` through the
   * transport manager, so a retryable failure parks it in a backoff the test
   * clock never advances past; `queues()` calls the store directly and is not
   * affected either way.
   */
  failListWith: DeadDropError | undefined;

  constructor(private readonly objects: ObjectEntry[]) {}

  async put(): Promise<{ key: string }> {
    return { key: 'ok' };
  }

  async get(): Promise<Uint8Array | undefined> {
    return undefined;
  }

  async list(prefix: string, options: ListOptions = {}): Promise<ListResult> {
    this.listCalls += 1;
    if (this.failListWith) throw this.failListWith;
    const under = this.objects
      .filter((entry) => entry.key.startsWith(`${prefix}/`))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const after = options.cursor ?? options.startAfter;
    const start = after ? under.findIndex((entry) => entry.key > after) : 0;
    const from = start < 0 ? under.length : start;
    const page = under.slice(from, from + (options.limit ?? under.length));
    const result: ListResult = { entries: page };
    if (from + page.length < under.length && page.length > 0) {
      result.cursor = page[page.length - 1]!.key;
    }
    return result;
  }

  async delete(): Promise<void> {}

  async health(): Promise<TransportHealth> {
    return { status: 'healthy', latencyMs: 1 };
  }

  async close(): Promise<void> {}
}

/**
 * A store that really holds what is put in it.
 *
 * `ListingStore` above answers from a fixed set and its `delete` is a no-op,
 * which is fine for counting a queue and useless for testing a reaper: the
 * question is which objects survive.
 */
class MutableStore implements StoreTransport {
  readonly kind = 'store' as const;
  readonly objects = new Map<string, Uint8Array>();
  /** Keys actually removed, in order. */
  readonly deleted: string[] = [];
  /** Deletes tried, successful or not: what a backoff has to hold down. */
  deleteAttempts = 0;
  failListWith: DeadDropError | undefined;
  failDeleteWith: DeadDropError | undefined;
  failPutWith: DeadDropError | undefined;
  /**
   * A prefix that lists as empty. Used only to hide a peer's own inbox from its
   * mailbox poll while leaving it visible to a listing of the inbox root, which
   * is the one way to watch the reaper decide about an object the delivery loop
   * would otherwise have consumed before it ever got there.
   */
  hidePrefix: string | undefined;

  async put(key: string, data: Uint8Array): Promise<{ key: string }> {
    if (this.failPutWith) throw this.failPutWith;
    this.objects.set(key, data);
    return { key };
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.objects.get(key);
  }

  async list(prefix: string, options: ListOptions = {}): Promise<ListResult> {
    if (this.failListWith) throw this.failListWith;
    if (this.hidePrefix !== undefined && prefix === this.hidePrefix) return { entries: [] };
    const under = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(`${prefix}/`))
      .map(([key, data]) => ({ key, size: data.byteLength }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const after = options.cursor ?? options.startAfter;
    const start = after ? under.findIndex((entry) => entry.key > after) : 0;
    const from = start < 0 ? under.length : start;
    const page = under.slice(from, from + (options.limit ?? under.length));
    const result: ListResult = { entries: page };
    if (from + page.length < under.length && page.length > 0) {
      result.cursor = page[page.length - 1]!.key;
    }
    return result;
  }

  async delete(key: string): Promise<void> {
    this.deleteAttempts += 1;
    if (this.failDeleteWith) throw this.failDeleteWith;
    if (this.objects.delete(key)) this.deleted.push(key);
  }

  async health(): Promise<TransportHealth> {
    return { status: 'healthy', latencyMs: 1 };
  }

  async close(): Promise<void> {}
}

/** `msg_<26 sortable chars>`, with the timestamp the id encodes. */
function messageId(time: number): string {
  return createMessageId(time);
}

function frame(peerId: string, id: string, size = 100): ObjectEntry {
  return { key: `ws/demo/inbox/${peerId}/${id}.ddf`, size };
}

function registration(store: StoreTransport, name?: string): TransportRegistration<never> {
  const factory = defineTransport<Record<string, never>>({
    id: 'hanging',
    capabilities: {
      kind: 'store',
      ordering: 'partition',
      binaryPayloads: true,
      delete: true,
      watch: false,
      orderedList: true,
    },
    create: () => store,
  });
  const options = name === undefined ? undefined : { name };
  return factory({}, options) as unknown as TransportRegistration<never>;
}

function workspace(
  store: StoreTransport,
  clock: TestClock,
  config: Record<string, unknown> = {},
  extra: StoreTransport[] = [],
): Workspace {
  const logs = new MemoryLogSink();
  return new Workspace({
    config: {
      name: 'demo',
      peerId: 'peer-a',
      secrets: [SECRET],
      transports: [],
      ...config,
    } as never,
    registrations: [
      registration(store),
      ...extra.map((other, index) => registration(other, `extra-${index}`)),
    ],
    logger: createLogger({ level: 'silent', sink: logs.sink, clock }),
    clock,
    // Supplied only when the config does not, because the explicit option wins
    // over the config field and would hide whether that field reaches anything.
    ...(config.presenceIntervalMs === undefined ? { presenceIntervalMs: 30_000 } : {}),
  });
}

describe('presence beacons', () => {
  it('never runs two at once, however slow the transport is', async () => {
    // Beacons are fire-and-forget, so nothing upstream bounds them. While
    // start-up awaited the first one, the interval could not overlap it: the
    // first beacon was always finished before the clock started. Publishing it
    // in the background removed that guarantee, and on a cold transport -- one
    // still authenticating, or still cloning -- the first beacon easily outlives
    // the interval. Each extra beacon is another writer on the same backend and
    // makes the next one slower still, so a transport that was merely slow gets
    // pushed into failing by nothing but its own presence records.
    const store = new HangingStore();
    const clock = new TestClock();
    const ws = workspace(store, clock);

    await ws.start();
    expect(store.puts).toBe(1);

    // Two intervals pass with the first beacon still unanswered. Without the
    // guard each one starts another: three concurrent writes for one record.
    await clock.advance(60_000);
    expect(store.puts).toBe(1);

    // Once it lands, the next interval publishes again as normal.
    store.inflight.splice(0).forEach((release) => release());
    await clock.advance(30_000);
    expect(store.puts).toBe(2);

    await ws.stop();
  });
});

describe('interval tuning from config', () => {
  // Both of these were code-only options that the config could not reach, which
  // is the same shape of gap `concurrency` had: the value parses, and then
  // nothing consumes it. Each test advances the clock by less than the default
  // interval, so it fails if the config field is ignored.
  it('takes the presence interval from the workspace config', async () => {
    const store = new HangingStore();
    const clock = new TestClock();
    const ws = workspace(store, clock, { presenceIntervalMs: 5000 });

    await ws.start();
    expect(store.puts).toBe(1);
    store.inflight.splice(0).forEach((release) => release());

    await clock.advance(5000);
    expect(store.puts).toBe(2);

    store.inflight.splice(0).forEach((release) => release());
    await ws.stop();
  });

  it('takes the health sweep interval from the workspace config', async () => {
    const store = new HangingStore();
    const clock = new TestClock();
    const ws = workspace(store, clock, { healthIntervalMs: 1000 });

    await ws.start();
    const afterOpeningSweep = store.healthChecks;

    await clock.advance(3000);
    expect(store.healthChecks).toBeGreaterThan(afterOpeningSweep);

    store.inflight.splice(0).forEach((release) => release());
    await ws.stop();
  });
});

describe('queued depth', () => {
  it('counts every peer inbox, not just its own, and dates the oldest', async () => {
    // The value of the command is answering "what is waiting, and for whom"
    // across the workspace. Reading only `ws/demo/inbox/peer-a` -- the prefix
    // the mailbox itself polls -- would report one peer and call it complete.
    const oldest = messageId(1_700_000_000_000);
    const store = new ListingStore([
      frame('peer-a', oldest, 10),
      frame('peer-a', messageId(1_700_000_005_000), 20),
      frame('peer-b', messageId(1_700_000_009_000), 30),
      frame('peer-b', messageId(1_700_000_007_000), 40),
      frame('peer-b', messageId(1_700_000_008_000), 50),
      // Not an inbox frame: it must not be counted against any peer.
      { key: 'ws/demo/peers/peer-b.ddf', size: 999 },
    ]);
    const ws = workspace(store, new TestClock());
    await ws.start();

    const report = await ws.queues();
    expect(report.peerId).toBe('peer-a');
    expect(report.read).toBe(1);
    expect(report.truncated).toBe(false);
    // Deepest queue first: that is the one an operator is looking for.
    expect(report.queues.map((queue) => queue.peerId)).toEqual(['peer-b', 'peer-a']);
    expect(report.queues[0]).toMatchObject({ peerId: 'peer-b', count: 3, bytes: 120 });
    expect(report.queues[1]).toMatchObject({ peerId: 'peer-a', count: 2, bytes: 30 });
    // Read from the key alone -- no frame was fetched, let alone decrypted.
    expect(report.queues[1]?.oldestId).toBe(oldest);
    expect(report.queues[1]?.oldestAt).toBe(1_700_000_000_000);

    await ws.stop();
  });

  it('counts a message held by two transports once', async () => {
    // Under the parallel policy one message really does exist on several
    // transports, and the mailbox deduplicates it on delivery. Summing the
    // listings would report a backlog twice the size of the real one.
    const shared = messageId(1_700_000_000_000);
    const first = new ListingStore([frame('peer-b', shared)]);
    const second = new ListingStore([frame('peer-b', shared), frame('peer-b', messageId(2))]);
    const ws = workspace(first, new TestClock(), {}, [second]);
    await ws.start();

    const report = await ws.queues();
    expect(report.read).toBe(2);
    expect(report.queues).toHaveLength(1);
    expect(report.queues[0]?.count).toBe(2);

    await ws.stop();
  });

  it('reports a transport it could not list instead of counting it as empty', async () => {
    const good = new ListingStore([frame('peer-b', messageId(1_700_000_000_000))]);
    const bad = new ListingStore([]);
    bad.failListWith = new DeadDropError('UNAUTHORIZED', 'clone is gone');
    const ws = workspace(good, new TestClock(), {}, [bad]);
    await ws.start();

    const report = await ws.queues();
    expect(report.read).toBe(1);
    expect(report.queues[0]?.count).toBe(1);
    expect(report.unreadable).toHaveLength(1);
    expect(report.unreadable[0]?.message).toContain('clone is gone');

    await ws.stop();
  });

  it('reports read=0 when no store could be listed, rather than an empty queue', async () => {
    // "Nothing is queued" and "I could not look" are different answers, and
    // this project has already shipped one bug from conflating a failed check
    // with a passing one. `read` is what lets a caller tell them apart.
    const store = new ListingStore([]);
    store.failListWith = new DeadDropError('UNAUTHORIZED', 'unavailable');
    const ws = workspace(store, new TestClock());
    await ws.start();

    const report = await ws.queues();
    expect(report.read).toBe(0);
    expect(report.queues).toEqual([]);
    expect(report.unreadable).toHaveLength(1);

    await ws.stop();
  });

  it('flags truncation instead of silently reporting a short count', async () => {
    const store = new ListingStore(
      Array.from({ length: 10_500 }, (_, index) => frame('peer-b', messageId(index + 1))),
    );
    const ws = workspace(store, new TestClock());
    await ws.start();

    const report = await ws.queues();
    expect(report.truncated).toBe(true);
    expect(report.queues[0]?.count).toBe(10_000);

    await ws.stop();
  });
});

describe('discovery', () => {
  it('reports read=0 when no store could be listed, rather than no peers', async () => {
    // The shipped bug: every store failing produced an empty peer list and a
    // debug log, so `ddrop discover` printed "No peers have announced
    // themselves yet" and exited 0 in the one situation where that sentence is
    // most misleading -- the command people run first when something is wrong.
    const store = new ListingStore([]);
    store.failListWith = new DeadDropError('UNAUTHORIZED', 'store is unreachable');
    const ws = workspace(store, new TestClock());
    await ws.start();

    const report = await ws.discoverPeers();
    expect(report.read).toBe(0);
    expect(report.peers).toEqual([]);
    expect(report.unreadable).toEqual([{ transport: 'hanging', message: 'store is unreachable' }]);

    await ws.stop();
  });

  it('counts a store that answered with no peers as read', async () => {
    const ws = workspace(new ListingStore([]), new TestClock());
    await ws.start();

    const report = await ws.discoverPeers();
    expect(report.read).toBe(1);
    expect(report.peers).toEqual([]);
    expect(report.unreadable).toEqual([]);

    await ws.stop();
  });
});

describe('delivery concurrency', () => {
  it('reaches the mailbox from the workspace config', () => {
    // The engine has always had this option and nothing ever set it, so the
    // failure to guard against is a config field that parses and then goes
    // nowhere. Assert the effective value, not that the field was accepted.
    const clock = new TestClock();
    expect(
      workspace(new HangingStore(), clock, { concurrency: 4 }).stats().mailbox.concurrency,
    ).toBe(4);
  });

  it('defaults to one, which is the serial behaviour', () => {
    const clock = new TestClock();
    expect(workspace(new HangingStore(), clock).stats().mailbox.concurrency).toBe(1);
  });
});

/**
 * `policy.mode`, asserted where a user would notice it: on the stores.
 *
 * The same failure the concurrency tests above guard against, except it shipped.
 * `parallel` parsed, was documented as writing through every healthy transport,
 * and selected exactly one, because the fan-out in the transport manager had no
 * caller. A test at the manager alone would not have caught it either; what was
 * missing was anybody asking where a published message actually landed.
 */
describe('transport policy', () => {
  const topics = (store: MutableStore): string[] =>
    [...store.objects.keys()].filter((key) => key.includes('/topic/'));
  const beacons = (store: MutableStore): string[] =>
    [...store.objects.keys()].filter((key) => key.includes('/peers/'));

  it('writes a message and a beacon to every transport under parallel', async () => {
    const a = new MutableStore();
    const b = new MutableStore();
    const ws = workspace(a, new TestClock(), { policy: { mode: 'parallel' } }, [b]);
    await ws.start();
    await ws.publish('orders', encodeJson({ ok: true }));

    expect(topics(a)).toHaveLength(1);
    expect(topics(b)).toHaveLength(1);
    // The beacon fans out too, or a peer that cannot reach the first transport
    // never discovers this one, and discovery would contradict delivery.
    expect(beacons(a)).toHaveLength(1);
    expect(beacons(b)).toHaveLength(1);

    await ws.stop();
  });

  it('writes to a single transport by default', async () => {
    const a = new MutableStore();
    const b = new MutableStore();
    const ws = workspace(a, new TestClock(), {}, [b]);
    await ws.start();
    await ws.publish('orders', encodeJson({ ok: true }));

    expect(topics(a).length + topics(b).length).toBe(1);
    expect(beacons(a).length + beacons(b).length).toBe(1);

    await ws.stop();
  });

  it('withdraws the beacon from every transport it may have reached', async () => {
    // `stop` deletes from all stores whatever the policy, which is what keeps a
    // fanned-out beacon from outliving its peer on the transport it was not
    // withdrawn from and reading as liveness to the inbox reaper.
    const a = new MutableStore();
    const b = new MutableStore();
    const ws = workspace(a, new TestClock(), { policy: { mode: 'parallel' } }, [b]);
    await ws.start();
    expect(beacons(a).length + beacons(b).length).toBe(2);

    await ws.stop();
    expect(beacons(a)).toHaveLength(0);
    expect(beacons(b)).toHaveLength(0);
  });
});

/**
 * Orphaned inbox reaping, ADR 0006.
 *
 * Nothing but a peer itself ever empties its own inbox, so mail addressed to a
 * peer that never returns is storage no process reclaims. The whole difficulty
 * is telling "gone" from "not looking right now", which is why the offline case
 * is the first test here: the happy path passes just as well against a reaper
 * that deletes indiscriminately, and proves nothing on its own.
 */
describe('reaping orphaned inboxes', () => {
  const NOW = 1_800_000_000_000;
  const DAY = 24 * 60 * 60_000;
  /** One presence interval, which is when the first maintenance pass runs. */
  const TICK = 30_000;

  async function planted(store: MutableStore, peerId: string, createdAt: number): Promise<string> {
    const id = createMessageId(createdAt);
    await store.put(`ws/demo/inbox/${peerId}/${id}.ddf`, new Uint8Array(1024));
    return `ws/demo/inbox/${peerId}/${id}.ddf`;
  }

  /** A beacon as `announce()` writes one, at an announce time of our choosing. */
  async function plantBeacon(store: MutableStore, peerId: string, announcedAt: number) {
    const keys = KeyRing.fromSecrets('demo', [SECRET]);
    const envelope = createEnvelope({
      workspace: 'demo',
      kind: 'control',
      channel: 'presence',
      from: peerId,
      contentType: JSON_CONTENT_TYPE,
      ts: announcedAt,
      payload: encodeJson({
        peerId,
        services: [],
        exposures: [],
        announcedAt,
        startedAt: announcedAt,
        version: 'test',
      }),
    });
    await store.put(peerKey('demo', peerId), await encodeFrame(envelope, { key: keys.primary }));
  }

  it('keeps every message for a peer that is merely offline', async () => {
    // The discriminating case. peer-b has a fresh beacon and a week-old
    // backlog: it is running and has not drained, which is precisely the
    // situation a mailbox exists to survive. Age alone would delete this.
    const store = new MutableStore();
    const clock = new TestClock(NOW);
    const first = await planted(store, 'peer-b', NOW - 8 * DAY);
    const second = await planted(store, 'peer-b', NOW - 9 * DAY);
    await plantBeacon(store, 'peer-b', NOW);

    const ws = workspace(store, clock);
    await ws.start();
    await clock.advance(TICK);

    expect(store.objects.has(first)).toBe(true);
    expect(store.objects.has(second)).toBe(true);
    expect(store.deleted).toEqual([]);

    await ws.stop();
  });

  it('reaps an inbox whose owner left no beacon behind', async () => {
    // The measured leak: `stop()` withdraws the beacon, so a peer that exited
    // cleanly with mail in flight leaves no beacon and a populated inbox.
    const store = new MutableStore();
    const clock = new TestClock(NOW);
    const orphan = await planted(store, 'peer-b', NOW - 8 * DAY);

    const ws = workspace(store, clock);
    await ws.start();
    await clock.advance(TICK);

    expect(store.objects.has(orphan)).toBe(false);
    expect(store.deleted).toEqual([orphan]);

    await ws.stop();
  });

  it('never reaps an identity or a wrapped key, even for the peer it just reaped an inbox for', async () => {
    // ADR 0007's highest-risk interaction with ADR 0006. An identity and a
    // wrapped era key are long-lived and belong to a peer that may be offline
    // for weeks, which is exactly the profile this reaper collects. Collecting
    // them would quietly cost the workspace the ability to admit or address that
    // peer, and the symptom would appear nowhere near the cause.
    //
    // Today these objects are safe structurally, because they sit outside every
    // prefix the reaper walks. Mutation says precisely what this catches and what
    // it does not: widening the listed root to `workspaceRoot` and trusting the
    // listing fails it, which is the accidental edit worth guarding. Bypassing
    // `parseInboxKey` alone does not fail it, because these keys are never listed
    // in the first place. The protection is the prefix, not the parser.
    const store = new MutableStore();
    const clock = new TestClock(NOW);
    const orphan = await planted(store, 'peer-b', NOW - 8 * DAY);
    const identity = identityKey('demo', 'peer-b');
    const wrapped = wrappedKeyKey('demo', 'peer-b', 'deadbeef');
    await store.put(identity, new Uint8Array(64));
    await store.put(wrapped, new Uint8Array(96));

    const ws = workspace(store, clock);
    await ws.start();
    await clock.advance(TICK);

    // The inbox object goes, which proves the reaper really ran on this peer
    // rather than the test passing because nothing was collected at all.
    expect(store.objects.has(orphan)).toBe(false);
    expect(store.objects.has(identity)).toBe(true);
    expect(store.objects.has(wrapped)).toBe(true);
    expect(store.deleted).toEqual([orphan]);

    await ws.stop();
  });

  it('keeps recent messages for a peer that has not announced yet', async () => {
    // Absence of a beacon is not enough on its own. A peer that has just been
    // sent something and has not started yet has no beacon at all.
    const store = new MutableStore();
    const clock = new TestClock(NOW);
    const fresh = await planted(store, 'peer-b', NOW - 60_000);

    const ws = workspace(store, clock);
    await ws.start();
    await clock.advance(TICK);

    expect(store.objects.has(fresh)).toBe(true);

    await ws.stop();
  });

  it('deletes nothing when a store could not be listed', async () => {
    // A store that did not answer holds beacons we would otherwise read as
    // absence, so acting on a partial view turns an outage into data loss.
    const store = new MutableStore();
    const blind = new MutableStore();
    blind.failListWith = new DeadDropError('UNAUTHORIZED', 'clone is gone');
    const clock = new TestClock(NOW);
    const orphan = await planted(store, 'peer-b', NOW - 8 * DAY);

    const ws = workspace(store, clock, {}, [blind]);
    await ws.start();
    await clock.advance(TICK);

    expect(store.objects.has(orphan)).toBe(true);
    expect(store.deleted).toEqual([]);

    await ws.stop();
  });

  it('does nothing at all when inboxOrphanMs is zero', async () => {
    const store = new MutableStore();
    const clock = new TestClock(NOW);
    const orphan = await planted(store, 'peer-b', NOW - 8 * DAY);
    await plantBeacon(store, 'peer-b', NOW - 8 * DAY);

    const ws = workspace(store, clock, { inboxOrphanMs: 0 });
    await ws.start();
    await clock.advance(TICK);

    expect(store.objects.has(orphan)).toBe(true);
    expect(store.deleted).toEqual([]);

    await ws.stop();
  });

  it('treats a beacon it cannot decode as liveness', async () => {
    // A frame from a key era we do not hold tells us nothing about its owner,
    // who may be alive and republishing it. Its existence is the signal.
    const store = new MutableStore();
    const clock = new TestClock(NOW);
    const orphan = await planted(store, 'peer-b', NOW - 8 * DAY);
    await store.put(peerKey('demo', 'peer-b'), new Uint8Array([1, 2, 3, 4]));

    const ws = workspace(store, clock);
    await ws.start();
    await clock.advance(TICK);

    expect(store.objects.has(orphan)).toBe(true);

    await ws.stop();
  });

  it('reaps a beacon that has gone stale', async () => {
    // Beacons get the aggressive horizon because they are self-healing: a live
    // peer rewrites its own every interval, so a wrong delete costs one
    // interval of invisibility and repairs itself.
    const store = new MutableStore();
    const clock = new TestClock(NOW);
    const key = peerKey('demo', 'peer-b');
    await plantBeacon(store, 'peer-b', NOW - DAY);

    const ws = workspace(store, clock);
    await ws.start();
    await clock.advance(TICK);

    expect(store.objects.has(key)).toBe(false);

    await ws.stop();
  });

  it('keeps a stale beacon while its owner still has mail waiting', async () => {
    // The beacon is the only evidence that the backlog is worth keeping, so
    // reaping it first would let the next pass see "no beacon" and delete mail
    // on age alone. Both survive; once the mail goes, so does the beacon.
    const store = new MutableStore();
    const clock = new TestClock(NOW);
    const key = peerKey('demo', 'peer-b');
    const fresh = await planted(store, 'peer-b', NOW - 60_000);
    await plantBeacon(store, 'peer-b', NOW - DAY);

    const ws = workspace(store, clock);
    await ws.start();
    await clock.advance(TICK);

    expect(store.objects.has(key)).toBe(true);
    expect(store.objects.has(fresh)).toBe(true);

    await ws.stop();
  });

  it('never reaps its own inbox, even with no beacon of its own to prove it', async () => {
    // In every ordinary state this peer's own fresh beacon already protects its
    // inbox, so the explicit skip looks redundant. It is not: a transport that
    // refuses writes leaves this peer with no beacon at all, and then it would
    // meet its own orphan test. What it must do instead is deliver from that
    // inbox, which is a peer's own business and nobody else's schedule.
    const store = new MutableStore();
    const clock = new TestClock(NOW);
    const mine = await planted(store, 'peer-a', NOW - 8 * DAY);
    // Beacons cannot land, so nothing announces peer-a as alive.
    store.failPutWith = new DeadDropError('UNAUTHORIZED', 'read-only mirror');
    // The delivery loop would consume this object long before the reaper looked
    // at it, and consuming it is correct. Hiding it from that one prefix is
    // what leaves the reaper's decision the only thing under test.
    store.hidePrefix = 'ws/demo/inbox/peer-a';

    const ws = workspace(store, clock);
    await ws.start();
    await clock.advance(TICK);

    expect(store.objects.has(mine)).toBe(true);
    expect(store.deleted).toEqual([]);

    await ws.stop();
  });

  it('backs off instead of retrying a refused delete every pass', async () => {
    // A refused delete leaves the condition that triggered it true. Without a
    // floor the pass retries at full rate for the life of the process, which is
    // the bug compaction already shipped once.
    const store = new MutableStore();
    const clock = new TestClock(NOW);
    await planted(store, 'peer-b', NOW - 8 * DAY);
    store.failDeleteWith = new DeadDropError('UNAUTHORIZED', 'read-only mirror');

    const ws = workspace(store, clock);
    await ws.start();
    await clock.advance(TICK);
    const attempted = store.deleteAttempts;
    expect(attempted).toBeGreaterThan(0);

    // One normal interval later the pass is still backed off, so nothing is
    // retried. Without the backoff this would attempt the same delete again.
    await clock.advance(15 * 60_000);
    expect(store.deleteAttempts).toBe(attempted);

    await ws.stop();
  });
});

/**
 * Enrollment, ADR 0007.
 *
 * These cover the half of the design that is live: a peer publishes its public
 * key with a proof, refuses one whose proof does not verify, and takes delivery
 * of an era key wrapped for it. Wrapping *for others* is deliberately not here
 * because it is deliberately not implemented: while the primary era is still
 * derived from the workspace secret, every member already computes it and
 * publishing wrapped copies would be writes that hand over nothing.
 */
describe('enrollment', () => {
  const NOW = 1_800_000_000_000;
  const TICK = 30_000;

  it('publishes its public key under the configured identity, not the mailbox address', async () => {
    const store = new MutableStore();
    const clock = new TestClock(NOW);
    // A session runtime, whose peerId carries the ephemeral -c<pid> suffix.
    const ws = new Workspace({
      config: { name: 'demo', peerId: 'peer-a', secrets: [SECRET], transports: [] } as never,
      registrations: [registration(store)],
      logger: createLogger({ level: 'silent', sink: new MemoryLogSink().sink, clock }),
      clock,
      sessionId: 'abc',
      presenceIntervalMs: 30_000,
    });
    await ws.start();
    await clock.advance(TICK);

    // Keyed by identity. A key wrapped to `peer-a-cabc` would die with this
    // process, which is the whole reason this is not keyed by peerId.
    expect(ws.peerId).toBe('peer-a-cabc');
    expect(store.objects.has(identityKey('demo', 'peer-a'))).toBe(true);
    expect(store.objects.has(identityKey('demo', 'peer-a-cabc'))).toBe(false);

    await ws.stop();
  });

  it('accepts an identity whose proof verifies', async () => {
    const store = new MutableStore();
    const clock = new TestClock(NOW);
    const other = generateIdentity();
    await store.put(
      identityKey('demo', 'peer-b'),
      encodeJson({
        publicKey: other.publicKey.toString('base64url'),
        proof: enrollmentProof(SECRET, 'demo', 'peer-b', other.publicKey).toString('base64url'),
      }),
    );

    const ws = workspace(store, clock);
    await ws.start();

    const found = await ws.identities();
    expect(found.map((entry) => entry.peerId).sort()).toEqual(['peer-a', 'peer-b']);
    expect(found.find((entry) => entry.peerId === 'peer-b')?.publicKey).toEqual(other.publicKey);

    await ws.stop();
  });

  it('refuses an identity planted by someone who cannot forge the proof', async () => {
    // This is the case the whole design exists for: whoever controls the store
    // can write this object, and must not thereby become a member.
    const store = new MutableStore();
    const clock = new TestClock(NOW);
    const attacker = generateIdentity();
    await store.put(
      identityKey('demo', 'attacker'),
      encodeJson({
        publicKey: attacker.publicKey.toString('base64url'),
        proof: Buffer.alloc(32).toString('base64url'),
      }),
    );
    // And a proof that is valid, but for a different peer id, so lifting a real
    // one out of another object does not work either.
    const lifted = generateIdentity();
    await store.put(
      identityKey('demo', 'peer-c'),
      encodeJson({
        publicKey: lifted.publicKey.toString('base64url'),
        proof: enrollmentProof(SECRET, 'demo', 'peer-b', lifted.publicKey).toString('base64url'),
      }),
    );

    const ws = workspace(store, clock);
    await ws.start();

    const found = await ws.identities();
    expect(found.map((entry) => entry.peerId)).toEqual(['peer-a']);

    await ws.stop();
  });

  it('takes delivery of an era key wrapped for it and can then open frames sealed under it', async () => {
    const store = new MutableStore();
    const clock = new TestClock(NOW);
    const ws = workspace(store, clock);
    await ws.start();
    await clock.advance(TICK);

    // The peer published its own key, so wrap a fresh era to it exactly as a
    // rotation would, using the key it actually advertised.
    const published = (await ws.identities()).find((entry) => entry.peerId === 'peer-a');
    expect(published).toBeDefined();
    const era = generateEraKey();
    await store.put(
      wrappedKeyKey('demo', 'peer-a', era.id),
      encodeWrappedKey(wrapEraKey(era, published!, { secret: SECRET, workspace: 'demo' })),
    );

    // Not held before the pass, so the assertion after it means something.
    expect(ws.keyIds()).not.toContain(era.id);

    await clock.advance(TICK);

    // In the ring, which is what lets a frame sealed under an era this peer was
    // never given the secret for be opened at all.
    expect(ws.keyIds()).toContain(era.id);

    await ws.stop();
  });

  it('ignores a wrapped key it is not the recipient of, and keeps taking the rest', async () => {
    const store = new MutableStore();
    const clock = new TestClock(NOW);
    const ws = workspace(store, clock);
    await ws.start();
    await clock.advance(TICK);

    const stranger = generateIdentity();
    const notOurs = generateEraKey();
    const ours = generateEraKey();
    const published = (await ws.identities()).find((entry) => entry.peerId === 'peer-a');
    // Both under this peer's prefix, so the only thing separating them is whether
    // they actually unwrap.
    await store.put(
      wrappedKeyKey('demo', 'peer-a', notOurs.id),
      encodeWrappedKey(
        wrapEraKey(
          notOurs,
          { peerId: 'peer-a', publicKey: stranger.publicKey },
          { secret: SECRET, workspace: 'demo' },
        ),
      ),
    );
    await store.put(
      wrappedKeyKey('demo', 'peer-a', ours.id),
      encodeWrappedKey(wrapEraKey(ours, published!, { secret: SECRET, workspace: 'demo' })),
    );
    await store.put(wrappedKeyKey('demo', 'peer-a', 'garbage'), new Uint8Array([1, 2, 3]));

    await clock.advance(TICK);

    expect(ws.keyIds()).toContain(ours.id);
    expect(ws.keyIds()).not.toContain(notOurs.id);

    await ws.stop();
  });

  it('refuses an era key wrapped by someone who cannot forge the enrollment proof', async () => {
    // The attack this closes, and the reason a wrapped key needs a proof at all.
    //
    // Wrapping needs nothing but the recipient's public key, and that key is
    // published in the clear on purpose. So whoever controls the store can mint
    // an era of its own, wrap it to a victim, and have the victim load it into
    // the ring. `frame.ts` opens whichever key id a frame names, and the sender
    // in an envelope header is just a field, so the next step is a request that
    // decodes cleanly and claims to come from any peer the attacker likes.
    //
    // Before ADR 0007 this was impossible: every key in the ring came from
    // `KeyRing.fromSecrets`, so opening a frame at all proved the author held
    // the secret. Wrapped keys have to preserve that or they hand membership to
    // the transport, which is the one adversary `protocol/crypto.ts` names.
    const store = new MutableStore();
    const clock = new TestClock(NOW);
    const ws = workspace(store, clock);
    const reached: string[] = [];
    ws.handle('svc.op', (_payload, context) => {
      reached.push(context.identity);
      return undefined;
    });
    await ws.start();
    await clock.advance(TICK);

    // Read the victim's public key the way the store operator would: off the
    // store, from the object the victim published itself.
    const published = store.objects.get(identityKey('demo', 'peer-a'));
    expect(published).toBeDefined();
    const victimPublicKey = Buffer.from(
      (JSON.parse(Buffer.from(published!).toString('utf8')) as { publicKey: string }).publicKey,
      'base64url',
    );

    const forged = generateEraKey();
    await store.put(
      wrappedKeyKey('demo', 'peer-a', forged.id),
      // Wrapped under a secret of the attacker's own, which is the only thing it
      // can do: it has the victim's public key but not the workspace secret.
      encodeWrappedKey(
        wrapEraKey(
          forged,
          { peerId: 'peer-a', publicKey: victimPublicKey },
          { secret: generateWorkspaceSecret(), workspace: 'demo' },
        ),
      ),
    );
    await clock.advance(TICK);

    expect(ws.keyIds()).not.toContain(forged.id);

    // And the consequence, stated as the thing that actually matters: a request
    // sealed under that era must not reach a handler wearing another peer's name.
    const envelope = createEnvelope({
      workspace: 'demo',
      kind: 'request',
      channel: 'svc.op',
      from: 'peer-b',
      to: 'peer-a',
      ts: clock.now(),
    });
    await store.put(
      inboxKey('demo', 'peer-a', envelope.id),
      await encodeFrame(envelope, { key: forged }),
    );
    await ws.mailbox.pollOnce();

    expect(reached).toEqual([]);

    await ws.stop();
  });
});
