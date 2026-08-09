/**
 * Circuit breaker per transport.
 *
 * When GitHub returns 403 for the next 40 minutes, retrying every poll burns
 * the rate limit that would otherwise recover. The breaker turns a stream of
 * failures into one fast rejection, and the transport manager reads its state
 * when scoring transports, so an open breaker means "route elsewhere" rather
 * than "fail".
 */

import { DeadDropError } from '../../protocol/index.js';

import type { Clock } from '../clock.js';
import { systemClock } from '../clock.js';

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker. Default 5. */
  failureThreshold?: number;
  /** How long the breaker stays open before probing. Default 30s. */
  resetTimeoutMs?: number;
  /** Consecutive successes in half-open needed to close. Default 2. */
  successThreshold?: number;
  /** Trailing window used for the reported error rate. Default 50. */
  sampleSize?: number;
  clock?: Clock;
  onStateChange?: (from: BreakerState, to: BreakerState) => void;
}

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private openedAt = 0;
  private readonly samples: boolean[] = [];
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly successThreshold: number;
  private readonly sampleSize: number;
  private readonly clock: Clock;
  private readonly onStateChange: ((from: BreakerState, to: BreakerState) => void) | undefined;

  constructor(
    readonly name: string,
    options: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.successThreshold = options.successThreshold ?? 2;
    this.sampleSize = options.sampleSize ?? 50;
    this.clock = options.clock ?? systemClock;
    this.onStateChange = options.onStateChange;
  }

  /** Current state, moving `open` to `half-open` once the reset timeout passes. */
  get current(): BreakerState {
    if (this.state === 'open' && this.clock.now() - this.openedAt >= this.resetTimeoutMs) {
      this.transition('half-open');
    }
    return this.state;
  }

  /** Failure ratio over the trailing window, 0..1. */
  get errorRate(): number {
    if (this.samples.length === 0) return 0;
    const failures = this.samples.filter((ok) => !ok).length;
    return failures / this.samples.length;
  }

  /** True when a call is allowed through right now. */
  canAttempt(): boolean {
    return this.current !== 'open';
  }

  /** Milliseconds until an open breaker will next allow a probe. */
  get retryAfterMs(): number {
    if (this.current !== 'open') return 0;
    return Math.max(0, this.resetTimeoutMs - (this.clock.now() - this.openedAt));
  }

  recordSuccess(): void {
    // Read through `current`, not `state`: the open -> half-open transition is
    // driven by elapsed time, and a caller that probed after the reset timeout
    // without first checking `current` would otherwise never close the breaker.
    const state = this.current;
    this.record(true);
    this.consecutiveFailures = 0;
    if (state === 'half-open') {
      this.consecutiveSuccesses += 1;
      if (this.consecutiveSuccesses >= this.successThreshold) this.transition('closed');
    } else {
      this.consecutiveSuccesses = 0;
    }
  }

  recordFailure(): void {
    const state = this.current;
    this.record(false);
    this.consecutiveSuccesses = 0;
    if (state === 'half-open') {
      // A failed probe means the backend is still bad; go straight back to open.
      this.trip();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) this.trip();
  }

  /** Runs `operation` under the breaker, rejecting fast while it is open. */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.canAttempt()) {
      throw new DeadDropError('TRANSPORT_ERROR', `circuit breaker "${this.name}" is open`, {
        // Retryable, but not by a caller standing in front of this breaker.
        // Somewhere else, or later; see `isBreakerOpen`.
        retryable: true,
        retryAfterMs: this.retryAfterMs,
        details: { breaker: this.name, state: 'open' },
      });
    }
    try {
      const result = await operation();
      this.recordSuccess();
      return result;
    } catch (error) {
      // A cancelled call says nothing about backend health.
      if (DeadDropError.is(error) && error.code === 'CANCELLED') throw error;
      this.recordFailure();
      throw error;
    }
  }

  /** Forces the breaker closed. Used by operators via `ddrop transport reset`. */
  reset(): void {
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.samples.length = 0;
    this.transition('closed');
  }

  private trip(): void {
    this.openedAt = this.clock.now();
    this.consecutiveFailures = this.failureThreshold;
    this.transition('open');
  }

  private transition(next: BreakerState): void {
    if (this.state === next) return;
    const previous = this.state;
    this.state = next;
    if (next === 'half-open') this.consecutiveSuccesses = 0;
    this.onStateChange?.(previous, next);
  }

  private record(ok: boolean): void {
    this.samples.push(ok);
    if (this.samples.length > this.sampleSize) this.samples.shift();
  }
}

/**
 * True when a rejection came from the breaker itself rather than the backend.
 *
 * An open breaker is a decision that has already been made: this transport is
 * not working, do not call it. Retrying that rejection re-asks a question the
 * breaker exists to answer once, and the retry loop backs off up to 30 seconds
 * per attempt while doing it. A caller that has somewhere else to go should go
 * there immediately; the breaker's own half-open probe is the retry.
 */
export function isBreakerOpen(error: unknown): boolean {
  return DeadDropError.is(error) && error.details?.state === 'open';
}
