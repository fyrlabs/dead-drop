import { describe, expect, it, vi } from 'vitest';

import { TestClock, systemClock } from '#dead-drop/core/clock.js';

describe('TestClock', () => {
  it('only moves when advanced', async () => {
    const clock = new TestClock(1000);
    expect(clock.now()).toBe(1000);
    await clock.advance(500);
    expect(clock.now()).toBe(1500);
  });

  it('runs timeouts in due order', async () => {
    const clock = new TestClock(0);
    const order: string[] = [];
    clock.setTimeout(30, () => order.push('c'));
    clock.setTimeout(10, () => order.push('a'));
    clock.setTimeout(20, () => order.push('b'));
    await clock.advance(100);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('sets the time to each task due point as it fires', async () => {
    const clock = new TestClock(0);
    const seen: number[] = [];
    clock.setTimeout(10, () => seen.push(clock.now()));
    clock.setTimeout(25, () => seen.push(clock.now()));
    await clock.advance(100);
    expect(seen).toEqual([10, 25]);
    expect(clock.now()).toBe(100);
  });

  it('repeats intervals and stops when cancelled', async () => {
    const clock = new TestClock(0);
    let ticks = 0;
    const cancel = clock.setInterval(10, () => {
      ticks += 1;
    });
    await clock.advance(35);
    expect(ticks).toBe(3);
    cancel();
    await clock.advance(100);
    expect(ticks).toBe(3);
    expect(clock.pending).toBe(0);
  });

  it('does not run tasks scheduled beyond the window', async () => {
    const clock = new TestClock(0);
    const spy = vi.fn();
    clock.setTimeout(1000, spy);
    await clock.advance(999);
    expect(spy).not.toHaveBeenCalled();
    await clock.advance(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('resolves sleep when time passes', async () => {
    const clock = new TestClock(0);
    let resolved = false;
    void clock.sleep(50).then(() => {
      resolved = true;
    });
    await clock.advance(49);
    expect(resolved).toBe(false);
    await clock.advance(1);
    expect(resolved).toBe(true);
  });

  it('rejects sleep on abort, before and during', async () => {
    const clock = new TestClock(0);
    const pre = new AbortController();
    pre.abort();
    await expect(clock.sleep(10, pre.signal)).rejects.toThrowError(/aborted/);

    const mid = new AbortController();
    const promise = clock.sleep(1000, mid.signal);
    mid.abort();
    await expect(promise).rejects.toThrowError(/aborted/);
    expect(clock.pending).toBe(0);
  });

  it('sees timers scheduled inside promise chains', async () => {
    const clock = new TestClock(0);
    let done = false;
    void Promise.resolve()
      .then(() => clock.sleep(100))
      .then(() => {
        done = true;
      });
    await clock.advance(200);
    expect(done).toBe(true);
  });
});

describe('systemClock', () => {
  it('reports wall-clock time and sleeps', async () => {
    const before = systemClock.now();
    await systemClock.sleep(5);
    expect(systemClock.now()).toBeGreaterThanOrEqual(before);
  });

  it('rejects a sleep that is aborted', async () => {
    const controller = new AbortController();
    const promise = systemClock.sleep(5000, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrowError(/aborted/);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(systemClock.sleep(10, controller.signal)).rejects.toThrowError(/aborted/);
  });

  it('cancels intervals and timeouts', async () => {
    const spy = vi.fn();
    systemClock.setInterval(1, spy)();
    systemClock.setTimeout(1, spy)();
    await systemClock.sleep(20);
    expect(spy).not.toHaveBeenCalled();
  });
});
