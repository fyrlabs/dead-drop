import { describe, expect, it, vi } from 'vitest';

import { DeadDropError } from '@fyrlabs/dead-drop-protocol';

import { TestClock } from '../clock.js';
import { DEFAULT_RETRY_POLICY, backoffDelay, withRetry, withTimeout } from './retry.js';

describe('backoffDelay', () => {
  const policy = { ...DEFAULT_RETRY_POLICY, initialDelayMs: 100, factor: 2, maxDelayMs: 1000 };

  it('grows exponentially and clamps at maxDelayMs', () => {
    const noJitter = { ...policy, jitter: 'none' as const };
    expect(backoffDelay(1, noJitter)).toBe(100);
    expect(backoffDelay(2, noJitter)).toBe(200);
    expect(backoffDelay(3, noJitter)).toBe(400);
    expect(backoffDelay(10, noJitter)).toBe(1000);
  });

  it('full jitter spans zero to the exponential delay', () => {
    const full = { ...policy, jitter: 'full' as const };
    expect(backoffDelay(2, full, () => 0)).toBe(0);
    expect(backoffDelay(2, full, () => 1)).toBe(200);
  });

  it('equal jitter keeps at least half the delay', () => {
    const equal = { ...policy, jitter: 'equal' as const };
    expect(backoffDelay(2, equal, () => 0)).toBe(100);
    expect(backoffDelay(2, equal, () => 1)).toBe(200);
  });
});

describe('withRetry', () => {
  const clock = (): TestClock => new TestClock(0);

  it('returns the first successful result without sleeping', async () => {
    const operation = vi.fn(async () => 'ok');
    expect(await withRetry(operation, { clock: clock() })).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries retryable failures until one succeeds', async () => {
    const testClock = clock();
    let calls = 0;
    const promise = withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new DeadDropError('TRANSPORT_ERROR', 'flaky');
        return 'recovered';
      },
      { clock: testClock, policy: { initialDelayMs: 100, jitter: 'none' }, random: () => 0.5 },
    );
    await testClock.advance(10_000);
    expect(await promise).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('does not retry non-retryable errors', async () => {
    const operation = vi.fn(async () => {
      throw new DeadDropError('BAD_REQUEST', 'nope');
    });
    await expect(withRetry(operation, { clock: clock() })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('never retries a cancellation', async () => {
    const operation = vi.fn(async () => {
      throw new DeadDropError('CANCELLED', 'aborted', { retryable: true });
    });
    await expect(withRetry(operation, { clock: clock() })).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts and reports how many it made', async () => {
    const testClock = clock();
    const operation = vi.fn(async () => {
      throw new DeadDropError('TIMEOUT', 'slow');
    });
    const promise = withRetry(operation, {
      clock: testClock,
      policy: { maxAttempts: 3, initialDelayMs: 10, jitter: 'none' },
    }).catch((error: unknown) => error as DeadDropError);
    await testClock.advance(10_000);
    const error = await promise;
    expect(operation).toHaveBeenCalledTimes(3);
    expect(error.code).toBe('TIMEOUT');
    expect(error.message).toMatch(/after 3 attempts/);
    expect(error.retryable).toBe(false);
  });

  it('honours retryAfterMs from the error over computed backoff', async () => {
    const testClock = clock();
    const delays: number[] = [];
    let calls = 0;
    const promise = withRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new DeadDropError('RATE_LIMITED', 'slow down', { retryAfterMs: 5000 });
        }
        return 'ok';
      },
      {
        clock: testClock,
        policy: { initialDelayMs: 10, jitter: 'none' },
        onRetry: ({ delayMs }) => delays.push(delayMs),
      },
    );
    await testClock.advance(10_000);
    await promise;
    expect(delays).toEqual([5000]);
  });

  it('stops early when the elapsed budget would be exceeded', async () => {
    const testClock = clock();
    const operation = vi.fn(async () => {
      throw new DeadDropError('TIMEOUT', 'slow');
    });
    const promise = withRetry(operation, {
      clock: testClock,
      policy: { maxAttempts: 10, initialDelayMs: 1000, jitter: 'none', maxElapsedMs: 1500 },
    }).catch(() => 'gave-up');
    await testClock.advance(60_000);
    expect(await promise).toBe('gave-up');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('aborts mid-backoff', async () => {
    const testClock = clock();
    const controller = new AbortController();
    const promise = withRetry(
      async () => {
        throw new DeadDropError('TIMEOUT', 'slow');
      },
      {
        clock: testClock,
        signal: controller.signal,
        policy: { maxAttempts: 5, initialDelayMs: 1000, jitter: 'none' },
      },
    ).catch((error: unknown) => error as DeadDropError);
    controller.abort();
    await testClock.advance(5000);
    expect((await promise).code).toBe('CANCELLED');
  });

  it('rejects an invalid policy', async () => {
    await expect(withRetry(async () => 'x', { policy: { maxAttempts: 0 } })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });

  it('accepts a custom retryability predicate', async () => {
    const testClock = clock();
    let calls = 0;
    const promise = withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw new DeadDropError('BAD_REQUEST', 'usually fatal');
        return 'ok';
      },
      { clock: testClock, isRetryable: () => true, policy: { initialDelayMs: 1, jitter: 'none' } },
    );
    await testClock.advance(100);
    expect(await promise).toBe('ok');
  });
});

describe('withTimeout', () => {
  it('passes through a fast result', async () => {
    const testClock = new TestClock(0);
    expect(await withTimeout(Promise.resolve('fast'), 1000, 'op', testClock)).toBe('fast');
  });

  it('rejects with TIMEOUT once the deadline passes', async () => {
    const testClock = new TestClock(0);
    const promise = withTimeout(new Promise(() => {}), 1000, 'slow op', testClock).catch(
      (error: unknown) => error as DeadDropError,
    );
    await testClock.advance(1500);
    const error = await promise;
    expect(error.code).toBe('TIMEOUT');
    expect(error.message).toContain('slow op');
  });

  it('treats a non-positive timeout as no timeout', async () => {
    expect(await withTimeout(Promise.resolve('x'), 0, 'op')).toBe('x');
  });

  it('clears its timer when the promise wins', async () => {
    const testClock = new TestClock(0);
    await withTimeout(Promise.resolve('x'), 1000, 'op', testClock);
    expect(testClock.pending).toBe(0);
  });
});
