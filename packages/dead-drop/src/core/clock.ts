/**
 * Time and scheduling, injected rather than imported.
 *
 * Every part of the runtime that waits, backs off, expires or polls takes a
 * `Clock`. Tests then drive time deterministically instead of sleeping, which
 * is the difference between a retry suite that runs in 3 ms and one that runs
 * in 30 s and flakes.
 */

export interface Clock {
  now(): number;
  /** Resolves after `ms`, or rejects with an `AbortError` if `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Returns a cancel function. Callbacks must never throw. */
  setInterval(ms: number, callback: () => void): () => void;
  setTimeout(ms: number, callback: () => void): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const timer = globalThis.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        globalThis.clearTimeout(timer);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
  setInterval: (ms, callback) => {
    const timer = globalThis.setInterval(callback, ms);
    timer.unref?.();
    return () => globalThis.clearInterval(timer);
  },
  setTimeout: (ms, callback) => {
    const timer = globalThis.setTimeout(callback, ms);
    timer.unref?.();
    return () => globalThis.clearTimeout(timer);
  },
};

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

interface ScheduledTask {
  id: number;
  dueAt: number;
  intervalMs: number | undefined;
  callback: () => void;
  cancelled: boolean;
}

/**
 * A clock whose time only moves when a test moves it. `advance` fires every
 * task due in the window, in due order, and drains microtasks between them so
 * promise chains started by a timer get a chance to run.
 */
export class TestClock implements Clock {
  private current: number;
  private nextId = 1;
  private tasks: ScheduledTask[] = [];

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const cancel = this.setTimeout(ms, () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });
      const onAbort = (): void => {
        cancel();
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  setInterval(ms: number, callback: () => void): () => void {
    return this.schedule(ms, callback, ms);
  }

  setTimeout(ms: number, callback: () => void): () => void {
    return this.schedule(ms, callback, undefined);
  }

  /**
   * Moves time forward, running everything that becomes due.
   *
   * Microtasks are drained before each pick, not only after each callback:
   * code under test typically schedules its timer inside a promise chain that
   * has not run yet when `advance` is called, and without the leading drain
   * that timer would be invisible and the test would hang.
   */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (let guard = 0; guard < 100_000; guard++) {
      await drainMicrotasks();
      const next = this.tasks
        .filter((task) => !task.cancelled && task.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0];
      if (!next) break;

      this.current = next.dueAt;
      if (next.intervalMs === undefined) {
        next.cancelled = true;
      } else {
        next.dueAt = this.current + next.intervalMs;
      }
      next.callback();
      await drainMicrotasks();
    }
    this.current = target;
    await drainMicrotasks();
  }

  /** Number of live timers. Used by tests to assert nothing was leaked. */
  get pending(): number {
    return this.tasks.filter((task) => !task.cancelled).length;
  }

  private schedule(ms: number, callback: () => void, intervalMs: number | undefined): () => void {
    const task: ScheduledTask = {
      id: this.nextId++,
      dueAt: this.current + ms,
      intervalMs,
      callback,
      cancelled: false,
    };
    this.tasks.push(task);
    return () => {
      task.cancelled = true;
      this.tasks = this.tasks.filter((candidate) => candidate !== task);
    };
  }
}

/**
 * Lets pending promise chains run before the caller continues.
 *
 * Yields through `setImmediate` rather than `Promise.resolve()`: crossing a
 * macrotask boundary flushes the *entire* microtask queue, whereas awaiting a
 * resolved promise only advances the chain by one tick. Test code routinely has
 * chains deeper than any fixed tick count, and guessing that count is how fake
 * timers turn into intermittent hangs.
 */
export async function drainMicrotasks(times = 2): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}
