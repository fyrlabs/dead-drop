/**
 * Retry with exponential backoff and jitter.
 *
 * Jitter is not optional here. Bridge peers poll on a shared schedule against a
 * rate-limited API; without jitter a transport hiccup makes every peer retry in
 * lockstep and re-create the outage. `full` jitter (random between 0 and the
 * computed delay) is the default because it spreads retries widest.
 */

import { BridgeError } from '@fyrlabs/dead-drop-protocol';

import type { Clock } from '../clock.js';
import { systemClock } from '../clock.js';

export type JitterMode = 'none' | 'full' | 'equal';

export interface RetryPolicy {
  /** Total attempts including the first. `1` disables retrying. */
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /** Delay multiplier between attempts. */
  factor: number;
  jitter: JitterMode;
  /** Never sleep longer than this in total across all attempts. */
  maxElapsedMs?: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  initialDelayMs: 200,
  maxDelayMs: 30_000,
  factor: 2,
  jitter: 'full',
};

export interface RetryContext {
  attempt: number;
  error: BridgeError;
  delayMs: number;
}

export interface RetryOptions {
  policy?: Partial<RetryPolicy>;
  clock?: Clock;
  signal?: AbortSignal;
  random?: () => number;
  /** Decides retryability. Defaults to `error.retryable`. */
  isRetryable?: (error: BridgeError) => boolean;
  /** Called before each sleep. Use it for logging and metrics. */
  onRetry?: (context: RetryContext) => void;
}

/** Computes the delay before `attempt` (1-based: the delay after attempt 1). */
export function backoffDelay(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.initialDelayMs * Math.pow(policy.factor, Math.max(0, attempt - 1)),
  );
  switch (policy.jitter) {
    case 'none':
      return Math.round(exponential);
    case 'equal':
      return Math.round(exponential / 2 + random() * (exponential / 2));
    case 'full':
    default:
      return Math.round(random() * exponential);
  }
}

/**
 * Runs `operation`, retrying retryable failures.
 *
 * A `retryAfterMs` on the error wins over the computed backoff: when a
 * transport tells us when its rate limit resets, guessing is worse.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.policy };
  if (policy.maxAttempts < 1) {
    throw new BridgeError('CONFIG_INVALID', 'retry policy maxAttempts must be at least 1');
  }
  const clock = options.clock ?? systemClock;
  const random = options.random ?? Math.random;
  const isRetryable = options.isRetryable ?? ((error: BridgeError) => error.retryable);
  const startedAt = clock.now();

  let lastError: BridgeError | undefined;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    if (options.signal?.aborted) {
      throw new BridgeError('CANCELLED', 'operation aborted before attempt', {
        details: { attempt },
      });
    }
    try {
      return await operation(attempt);
    } catch (error) {
      const bridgeError = BridgeError.from(error, 'TRANSPORT_ERROR');
      lastError = bridgeError;
      if (bridgeError.code === 'CANCELLED' || !isRetryable(bridgeError)) throw bridgeError;
      if (attempt === policy.maxAttempts) break;

      const delayMs = bridgeError.retryAfterMs ?? backoffDelay(attempt, policy, random);
      if (
        policy.maxElapsedMs !== undefined &&
        clock.now() - startedAt + delayMs > policy.maxElapsedMs
      ) {
        break;
      }
      options.onRetry?.({ attempt, error: bridgeError, delayMs });
      try {
        await clock.sleep(delayMs, options.signal);
      } catch {
        throw new BridgeError('CANCELLED', 'operation aborted while backing off', {
          details: { attempt },
        });
      }
    }
  }

  throw new BridgeError(
    lastError?.code ?? 'TRANSPORT_ERROR',
    `operation failed after ${policy.maxAttempts} attempts: ${lastError?.message ?? 'unknown'}`,
    {
      cause: lastError,
      details: { attempts: policy.maxAttempts, ...lastError?.details },
      retryable: false,
    },
  );
}

/** Rejects with `TIMEOUT` if `promise` has not settled within `ms`. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  clock: Clock = systemClock,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        cancel = clock.setTimeout(ms, () =>
          reject(
            new BridgeError('TIMEOUT', `${message} (${ms}ms)`, { details: { timeoutMs: ms } }),
          ),
        );
      }),
    ]);
  } finally {
    cancel?.();
  }
}
