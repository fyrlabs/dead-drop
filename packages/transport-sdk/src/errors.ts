/**
 * dead-drop error model.
 *
 * Every failure that crosses a package boundary is a {@link DeadDropError} with a
 * stable machine-readable {@link DeadDropErrorCode}. Codes are part of the public
 * contract: they travel over the wire in error responses and are matched on by
 * the retry and failover logic, so renaming one is a breaking change.
 */

export const DEAD_DROP_ERROR_CODES = [
  'BAD_REQUEST',
  'CANCELLED',
  'CHUNK_INCOMPLETE',
  'CONFIG_INVALID',
  'DECODE_FAILED',
  'DECRYPT_FAILED',
  'INTERNAL',
  'NO_TRANSPORT_AVAILABLE',
  'NOT_FOUND',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'REPLAY_DETECTED',
  'SERVICE_ERROR',
  'TIMEOUT',
  'TRANSPORT_ERROR',
  'UNAUTHORIZED',
  'UNSUPPORTED',
] as const;

export type DeadDropErrorCode = (typeof DEAD_DROP_ERROR_CODES)[number];

/** Codes where retrying the same operation can plausibly succeed. */
const RETRYABLE = new Set<DeadDropErrorCode>([
  'INTERNAL',
  'NO_TRANSPORT_AVAILABLE',
  'RATE_LIMITED',
  'TIMEOUT',
  'TRANSPORT_ERROR',
]);

export interface DeadDropErrorOptions {
  cause?: unknown;
  /** Extra structured context. Must be JSON-serialisable; never put secrets here. */
  details?: Record<string, unknown>;
  /** Overrides the default retryability of the code. */
  retryable?: boolean;
  /** Hint from the remote end (or a rate limiter) about when to try again. */
  retryAfterMs?: number;
}

export class DeadDropError extends Error {
  readonly code: DeadDropErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(code: DeadDropErrorCode, message: string, options: DeadDropErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DeadDropError';
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.retryAfterMs = options.retryAfterMs;
  }

  /** Wire/log representation. Never includes `cause` chains verbatim. */
  toJSON(): {
    name: string;
    code: DeadDropErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
    retryAfterMs?: number;
  } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
    };
  }

  static is(value: unknown): value is DeadDropError {
    return value instanceof DeadDropError;
  }

  /** Rebuilds a DeadDropError from its wire form, tolerating unknown codes. */
  static fromJSON(value: unknown): DeadDropError {
    if (!isRecord(value)) {
      return new DeadDropError('INTERNAL', 'unknown remote error');
    }
    const code = isDeadDropErrorCode(value.code) ? value.code : 'INTERNAL';
    const message = typeof value.message === 'string' ? value.message : 'unknown remote error';
    return new DeadDropError(code, message, {
      details: isRecord(value.details) ? value.details : undefined,
      retryable: typeof value.retryable === 'boolean' ? value.retryable : undefined,
      retryAfterMs: typeof value.retryAfterMs === 'number' ? value.retryAfterMs : undefined,
    });
  }

  /**
   * Coerces anything thrown into a DeadDropError without losing the original.
   * `AbortError` is mapped to `CANCELLED` because that is how Node signals aborts.
   */
  static from(value: unknown, fallbackCode: DeadDropErrorCode = 'INTERNAL'): DeadDropError {
    if (DeadDropError.is(value)) return value;
    if (value instanceof Error) {
      const code = value.name === 'AbortError' ? 'CANCELLED' : fallbackCode;
      return new DeadDropError(code, value.message, { cause: value });
    }
    return new DeadDropError(fallbackCode, String(value));
  }
}

export function isDeadDropErrorCode(value: unknown): value is DeadDropErrorCode {
  return (
    typeof value === 'string' &&
    (DEAD_DROP_ERROR_CODES as readonly string[]).includes(value as string)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
