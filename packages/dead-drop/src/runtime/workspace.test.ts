/**
 * Workspace start-up and presence.
 *
 * The presence beacon is the one thing a workspace does on its own schedule
 * rather than because a caller asked, so it is the one thing that can turn a
 * slow transport into a failing one without anybody making a request.
 */

import { describe, expect, it } from 'vitest';

import type { StoreTransport, TransportHealth } from '@fyrlabs/dead-drop-transport-sdk';
import { defineTransport, type TransportRegistration } from '@fyrlabs/dead-drop-transport-sdk';

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

function registration(store: StoreTransport): TransportRegistration<never> {
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
  return factory({}) as unknown as TransportRegistration<never>;
}

function workspace(
  store: StoreTransport,
  clock: TestClock,
  config: Record<string, unknown> = {},
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
    registrations: [registration(store)],
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
