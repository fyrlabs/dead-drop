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

import { createMessageId, DeadDropError } from '../protocol/index.js';
import { TestClock } from '../core/clock.js';
import { createLogger, MemoryLogSink } from '../core/observability/logger.js';

import { Workspace } from './workspace.js';

const SECRET = 'ddk1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** A store whose `put` never settles until the test releases it. */
class HangingStore implements StoreTransport {
  readonly kind = 'store' as const;
  readonly inflight: Array<() => void> = [];
  puts = 0;

  async put(): Promise<{ key: string }> {
    this.puts += 1;
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
