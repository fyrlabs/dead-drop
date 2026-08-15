import { describe, expect, it, vi } from 'vitest';

import { DeadDropError } from '#dead-drop/protocol/index.js';

import { TestClock } from '#dead-drop/core/clock.js';
import { CircuitBreaker } from '#dead-drop/core/reliability/circuit-breaker.js';

const make = (clock: TestClock, options = {}) =>
  new CircuitBreaker('github', { clock, failureThreshold: 3, resetTimeoutMs: 1000, ...options });

describe('CircuitBreaker', () => {
  it('starts closed and stays closed while calls succeed', async () => {
    const breaker = make(new TestClock(0));
    expect(breaker.current).toBe('closed');
    await breaker.execute(async () => 'ok');
    expect(breaker.canAttempt()).toBe(true);
  });

  it('trips after the failure threshold', () => {
    const breaker = make(new TestClock(0));
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.current).toBe('closed');
    breaker.recordFailure();
    expect(breaker.current).toBe('open');
    expect(breaker.canAttempt()).toBe(false);
  });

  it('rejects fast while open, with a retry hint', async () => {
    const clock = new TestClock(0);
    const breaker = make(clock);
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    const operation = vi.fn(async () => 'ok');
    const error = (await breaker.execute(operation).catch((e: unknown) => e)) as DeadDropError;
    expect(operation).not.toHaveBeenCalled();
    expect(error.code).toBe('TRANSPORT_ERROR');
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(1000);
  });

  it('moves to half-open after the reset timeout', async () => {
    const clock = new TestClock(0);
    const breaker = make(clock);
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(breaker.current).toBe('open');
    await clock.advance(1000);
    expect(breaker.current).toBe('half-open');
    expect(breaker.canAttempt()).toBe(true);
    expect(breaker.retryAfterMs).toBe(0);
  });

  it('closes after enough successful probes', async () => {
    const clock = new TestClock(0);
    const breaker = make(clock, { successThreshold: 2 });
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    await clock.advance(1000);
    breaker.recordSuccess();
    expect(breaker.current).toBe('half-open');
    breaker.recordSuccess();
    expect(breaker.current).toBe('closed');
  });

  it('re-opens immediately when a probe fails', async () => {
    const clock = new TestClock(0);
    const breaker = make(clock);
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    await clock.advance(1000);
    expect(breaker.current).toBe('half-open');
    breaker.recordFailure();
    expect(breaker.current).toBe('open');
  });

  it('counts consecutive failures, not total', () => {
    const breaker = make(new TestClock(0));
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.current).toBe('closed');
  });

  it('reports an error rate over the trailing window', () => {
    const breaker = make(new TestClock(0), { failureThreshold: 100, sampleSize: 4 });
    expect(breaker.errorRate).toBe(0);
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.errorRate).toBe(0.5);
    breaker.recordSuccess();
    breaker.recordSuccess();
    breaker.recordSuccess();
    expect(breaker.errorRate).toBe(0);
  });

  it('records failures for thrown operations but ignores cancellations', async () => {
    const breaker = make(new TestClock(0));
    await expect(
      breaker.execute(async () => {
        throw new DeadDropError('TRANSPORT_ERROR', 'boom');
      }),
    ).rejects.toThrow();
    expect(breaker.errorRate).toBe(1);

    await expect(
      breaker.execute(async () => {
        throw new DeadDropError('CANCELLED', 'shutting down');
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    // The cancellation left the sample window untouched.
    expect(breaker.errorRate).toBe(1);
  });

  it('reports state transitions', () => {
    const clock = new TestClock(0);
    const changes: string[] = [];
    const breaker = new CircuitBreaker('gitlab', {
      clock,
      failureThreshold: 1,
      onStateChange: (from, to) => changes.push(`${from}->${to}`),
    });
    breaker.recordFailure();
    breaker.reset();
    expect(changes).toEqual(['closed->open', 'open->closed']);
  });

  it('reset clears failures and the sample window', () => {
    const breaker = make(new TestClock(0));
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    breaker.reset();
    expect(breaker.current).toBe('closed');
    expect(breaker.errorRate).toBe(0);
  });
});
