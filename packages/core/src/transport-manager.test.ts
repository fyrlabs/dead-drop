import { describe, expect, it } from 'vitest';

import { BridgeError } from '@fyrlabs/dead-drop-protocol';
import type { StoreTransport, TransportRegistration } from '@fyrlabs/dead-drop-transport-sdk';

import { harness } from './testing.js';
import { faultyTransport } from './testing.js';
import { TransportManager, type TransportManagerOptions } from './transport-manager.js';

function manager(
  registrations: Array<TransportRegistration<never>>,
  options: Partial<TransportManagerOptions> = {},
): { manager: TransportManager; clock: ReturnType<typeof harness>['clock'] } {
  const { clock, logger } = harness();
  return {
    clock,
    manager: new TransportManager({
      workspace: 'demo',
      peerId: 'peer-a',
      registrations,
      clock,
      logger,
      ...options,
    }),
  };
}

describe('TransportManager lifecycle', () => {
  it('requires at least one transport', async () => {
    const { manager: subject } = manager([]);
    await expect(subject.start()).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('rejects duplicate instance names', async () => {
    const a = faultyTransport('memory');
    const b = faultyTransport('memory');
    const { manager: subject } = manager([a.registration, b.registration]);
    await expect(subject.start()).rejects.toThrowError(/duplicate transport instance name/);
  });

  it('rejects a policy naming an unknown transport', async () => {
    const { registration } = faultyTransport('alpha');
    const { manager: subject } = manager([registration], { policy: { primary: 'ghost' } });
    await expect(subject.start()).rejects.toThrowError(/unknown transport "ghost"/);
  });

  it('starts, lists and stops', async () => {
    const { registration } = faultyTransport('alpha');
    const { manager: subject } = manager([registration]);
    await subject.start();
    await subject.start(); // idempotent

    const listed = subject.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: 'alpha', kind: 'store', status: 'healthy' });
    expect(subject.get('alpha').name).toBe('alpha');
    expect(() => subject.get('nope')).toThrowError(/no transport named/);

    await subject.stop();
    expect(subject.all()).toHaveLength(0);
  });
});

describe('TransportManager selection', () => {
  it('prefers the healthier transport', async () => {
    const healthy = faultyTransport('healthy');
    const degraded = faultyTransport('degraded', {
      health: { status: 'degraded', latencyMs: 10 },
    });
    const { manager: subject } = manager([degraded.registration, healthy.registration]);
    await subject.start();
    expect(subject.select().map((entry) => entry.name)).toEqual(['healthy', 'degraded']);
  });

  it('prefers the faster transport when health is equal', async () => {
    const fast = faultyTransport('fast', { health: { status: 'healthy', latencyMs: 10 } });
    const slow = faultyTransport('slow', { health: { status: 'healthy', latencyMs: 5000 } });
    const { manager: subject } = manager([slow.registration, fast.registration]);
    await subject.start();
    expect(subject.select()[0]?.name).toBe('fast');
  });

  it('scores an unavailable transport at zero', async () => {
    const down = faultyTransport('down', { health: { status: 'unavailable' } });
    const { manager: subject } = manager([down.registration]);
    await subject.start();
    expect(subject.score(subject.get('down'))).toBe(0);
  });

  it('respects a strict failover order', async () => {
    const a = faultyTransport('alpha', { health: { status: 'healthy', latencyMs: 5000 } });
    const b = faultyTransport('beta', { health: { status: 'healthy', latencyMs: 1 } });
    const { manager: subject } = manager([a.registration, b.registration], {
      policy: { mode: 'failover', primary: 'alpha', fallback: ['beta'] },
    });
    await subject.start();
    // beta is objectively faster, but the operator said alpha first.
    expect(subject.select().map((entry) => entry.name)).toEqual(['alpha', 'beta']);
  });

  it('pins the primary first under score mode', async () => {
    const a = faultyTransport('alpha', { health: { status: 'healthy', latencyMs: 5000 } });
    const b = faultyTransport('beta', { health: { status: 'healthy', latencyMs: 1 } });
    const { manager: subject } = manager([a.registration, b.registration], {
      policy: { primary: 'alpha' },
    });
    await subject.start();
    expect(subject.select()[0]?.name).toBe('alpha');
  });

  it('filters by capability requirements', async () => {
    const small = faultyTransport('small', { maxPayloadBytes: 4096 });
    const big = faultyTransport('big', { maxPayloadBytes: 10 * 1024 * 1024 });
    const text = faultyTransport('text', {}, { binaryPayloads: false });
    const unordered = faultyTransport('unordered', {}, { ordering: 'none' });
    const { manager: subject } = manager([
      small.registration,
      big.registration,
      text.registration,
      unordered.registration,
    ]);
    await subject.start();

    expect(subject.select({ minPayloadBytes: 1_000_000 }).map((e) => e.name)).not.toContain(
      'small',
    );
    expect(subject.select({ binaryPayloads: true }).map((e) => e.name)).not.toContain('text');
    expect(subject.select({ ordering: 'partition' }).map((e) => e.name)).not.toContain('unordered');
    expect(subject.select({ ordering: 'global' })).toHaveLength(0);
    expect(subject.select({ only: ['big'] }).map((e) => e.name)).toEqual(['big']);
  });
});

describe('TransportManager run', () => {
  it('runs on the best transport and records metrics', async () => {
    const { registration, store } = faultyTransport('alpha');
    const { manager: subject } = manager([registration]);
    await subject.start();

    await subject.run('put', (transport) =>
      (transport as StoreTransport).put('ws/demo/inbox/peer-b/1.ddf', new Uint8Array([1])),
    );
    expect(store.objects.size).toBe(1);
    expect(
      subject.metrics.transportOperations.get({
        transport: 'alpha',
        operation: 'put',
        outcome: 'success',
      }),
    ).toBe(1);
    expect(subject.metrics.transportLatency.count({ transport: 'alpha', operation: 'put' })).toBe(
      1,
    );
  });

  it('retries a transient failure on the same transport', async () => {
    const { registration, store } = faultyTransport('alpha', {
      failOperations: ['put'],
      failCount: 2,
    });
    const { manager: subject, clock } = manager([registration], {
      retry: { maxAttempts: 5, initialDelayMs: 10, jitter: 'none' },
    });
    await subject.start();

    const promise = subject.run('put', (transport) =>
      (transport as StoreTransport).put('ws/demo/inbox/peer-b/1.ddf', new Uint8Array([1])),
    );
    await clock.advance(5000);
    await promise;
    expect(store.calls.filter((call) => call === 'put')).toHaveLength(3);
    expect(subject.metrics.transportRetries.get({ transport: 'alpha', operation: 'put' })).toBe(2);
  });

  it('fails over to the next transport once the first is exhausted', async () => {
    const broken = faultyTransport('broken', {
      failOperations: ['put'],
      failCount: Number.POSITIVE_INFINITY,
    });
    const working = faultyTransport('working');
    const { manager: subject, clock } = manager([broken.registration, working.registration], {
      policy: { mode: 'failover', primary: 'broken', fallback: ['working'] },
      retry: { maxAttempts: 2, initialDelayMs: 10, jitter: 'none' },
    });
    await subject.start();

    const promise = subject.run('put', (transport) =>
      (transport as StoreTransport).put('ws/demo/inbox/peer-b/1.ddf', new Uint8Array([1])),
    );
    await clock.advance(5000);
    await promise;

    expect(working.store.objects.size).toBe(1);
    expect(subject.metrics.failovers.get({ from: 'broken', to: 'working' })).toBe(1);
  });

  it('does not fail over for caller-side errors', async () => {
    const first = faultyTransport('first');
    const second = faultyTransport('second');
    const { manager: subject } = manager([first.registration, second.registration]);
    await subject.start();

    await expect(
      subject.run('put', async () => {
        throw new BridgeError('UNAUTHORIZED', 'bad workspace secret');
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(subject.metrics.failovers.get({ from: 'first', to: 'second' })).toBe(0);
  });

  it('reports which transports it tried when all fail', async () => {
    const a = faultyTransport('alpha', {
      failOperations: ['put'],
      failCount: Number.POSITIVE_INFINITY,
    });
    const b = faultyTransport('beta', {
      failOperations: ['put'],
      failCount: Number.POSITIVE_INFINITY,
    });
    const { manager: subject, clock } = manager([a.registration, b.registration], {
      retry: { maxAttempts: 1 },
    });
    await subject.start();

    const promise = subject
      .run('put', (transport) =>
        (transport as StoreTransport).put('ws/demo/inbox/peer-b/1.ddf', new Uint8Array()),
      )
      .catch((error: unknown) => error as BridgeError);
    await clock.advance(1000);
    const error = await promise;
    expect(error.code).toBe('NO_TRANSPORT_AVAILABLE');
    expect(error.details?.tried).toEqual(['alpha', 'beta']);
  });

  it('reports NO_TRANSPORT_AVAILABLE when nothing satisfies the requirements', async () => {
    const { registration } = faultyTransport('small', { maxPayloadBytes: 2048 });
    const { manager: subject } = manager([registration]);
    await subject.start();
    await expect(
      subject.run('put', async () => undefined, { requirements: { minPayloadBytes: 10_000_000 } }),
    ).rejects.toMatchObject({ code: 'NO_TRANSPORT_AVAILABLE' });
  });

  it('trips the breaker after repeated failures and scores the transport at zero', async () => {
    const { registration } = faultyTransport('flaky', {
      failOperations: ['put'],
      failCount: Number.POSITIVE_INFINITY,
    });
    const { manager: subject, clock } = manager([registration], { retry: { maxAttempts: 1 } });
    await subject.start();

    for (let i = 0; i < 5; i++) {
      const attempt = subject
        .run('put', (transport) =>
          (transport as StoreTransport).put('ws/demo/inbox/peer-b/1.ddf', new Uint8Array()),
        )
        .catch(() => undefined);
      await clock.advance(100);
      await attempt;
    }
    expect(subject.get('flaky').breaker.current).toBe('open');
    expect(subject.score(subject.get('flaky'))).toBe(0);
    expect(subject.list()[0]?.breaker).toBe('open');
  });

  it('times out a hung operation', async () => {
    const { registration } = faultyTransport('slow');
    const { manager: subject, clock } = manager([registration], {
      operationTimeoutMs: 1000,
      retry: { maxAttempts: 1 },
    });
    await subject.start();

    const promise = subject
      .run('put', () => new Promise<void>(() => {}))
      .catch((error: unknown) => error as BridgeError);
    await clock.advance(2000);
    expect((await promise).message).toMatch(/failed after 1 attempts|TIMEOUT|timed/i);
  });

  it('runAll succeeds when at least one transport works', async () => {
    const broken = faultyTransport('broken', {
      failOperations: ['put'],
      failCount: Number.POSITIVE_INFINITY,
    });
    const working = faultyTransport('working');
    const { manager: subject, clock } = manager([broken.registration, working.registration], {
      retry: { maxAttempts: 1 },
    });
    await subject.start();

    const promise = subject.runAll('put', (transport) =>
      (transport as StoreTransport).put('ws/demo/inbox/peer-b/1.ddf', new Uint8Array([1])),
    );
    await clock.advance(1000);
    expect(await promise).toHaveLength(1);
    expect(working.store.objects.size).toBe(1);
  });

  it('runAll rejects when every transport fails', async () => {
    const a = faultyTransport('alpha', {
      failOperations: ['put'],
      failCount: Number.POSITIVE_INFINITY,
    });
    const { manager: subject, clock } = manager([a.registration], { retry: { maxAttempts: 1 } });
    await subject.start();
    const promise = subject
      .runAll('put', (transport) =>
        (transport as StoreTransport).put('ws/demo/inbox/peer-b/1.ddf', new Uint8Array()),
      )
      .catch((error: unknown) => error as BridgeError);
    await clock.advance(1000);
    expect(await promise).toBeInstanceOf(BridgeError);
  });
});

describe('TransportManager health', () => {
  it('marks a transport unavailable when its health probe throws', async () => {
    const { registration, store } = faultyTransport('alpha');
    const { manager: subject } = manager([registration]);
    await subject.start();

    store.health = async () => {
      throw new Error('backend gone');
    };
    await subject.checkHealth();
    expect(subject.get('alpha').health.status).toBe('unavailable');
    expect(subject.get('alpha').health.message).toContain('backend gone');
    expect(subject.metrics.transportHealth.get({ transport: 'alpha' })).toBe(0);
  });

  it('publishes rate-limit headroom as a gauge and factors it into the score', async () => {
    const generous = faultyTransport('generous', {
      health: { status: 'healthy', latencyMs: 1, rateLimit: { limit: 100, remaining: 100 } },
    });
    const throttled = faultyTransport('throttled', {
      health: { status: 'healthy', latencyMs: 1, rateLimit: { limit: 100, remaining: 1 } },
    });
    const { manager: subject } = manager([throttled.registration, generous.registration]);
    await subject.start();

    expect(subject.select()[0]?.name).toBe('generous');
    expect(subject.metrics.transportRateLimitRemaining.get({ transport: 'throttled' })).toBe(1);
    expect(subject.list().find((info) => info.name === 'throttled')?.rateLimitRemaining).toBe(1);
  });

  it('re-probes on the health interval', async () => {
    const { registration } = faultyTransport('alpha');
    const { manager: subject, clock } = manager([registration], { healthIntervalMs: 1000 });
    await subject.start();
    const first = subject.get('alpha').lastHealthCheckAt;
    await clock.advance(2500);
    expect(subject.get('alpha').lastHealthCheckAt).toBeGreaterThan(first);
    await subject.stop();
  });
});
