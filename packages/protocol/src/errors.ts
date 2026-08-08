/**
 * Bridge error model.
 *
 * Every failure that crosses a package boundary is a {@link BridgeError} with a
 * stable machine-readable {@link BridgeErrorCode}. Codes are part of the public
 * contract: they travel over the wire in error responses and are matched on by
 * the retry and failover logic, so renaming one is a breaking change.
 */

export const BRIDGE_ERROR_CODES = [
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

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

/** Codes where retrying the same operation can plausibly succeed. */
const RETRYABLE = new Set<BridgeErrorCode>([
  'INTERNAL',
  'NO_TRANSPORT_AVAILABLE',
  'RATE_LIMITED',
  'TIMEOUT',
  'TRANSPORT_ERROR',
]);

export interface BridgeErrorOptions {
  cause?: unknown;
  /** Extra structured context. Must be JSON-serialisable; never put secrets here. */
  details?: Record<string, unknown>;
  /** Overrides the default retryability of the code. */
  retryable?: boolean;
  /** Hint from the remote end (or a rate limiter) about when to try again. */
  retryAfterMs?: number;
}

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(code: BridgeErrorCode, message: string, options: BridgeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BridgeError';
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.retryAfterMs = options.retryAfterMs;
  }

  /** Wire/log representation. Never includes `cause` chains verbatim. */
  toJSON(): {
    name: string;
    code: BridgeErrorCode;
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

  static is(value: unknown): value is BridgeError {
    return value instanceof BridgeError;
  }

  /** Rebuilds a BridgeError from its wire form, tolerating unknown codes. */
  static fromJSON(value: unknown): BridgeError {
    if (!isRecord(value)) {
      return new BridgeError('INTERNAL', 'unknown remote error');
    }
    const code = isBridgeErrorCode(value.code) ? value.code : 'INTERNAL';
    const message = typeof value.message === 'string' ? value.message : 'unknown remote error';
    return new BridgeError(code, message, {
      details: isRecord(value.details) ? value.details : undefined,
      retryable: typeof value.retryable === 'boolean' ? value.retryable : undefined,
      retryAfterMs: typeof value.retryAfterMs === 'number' ? value.retryAfterMs : undefined,
    });
  }

  /**
   * Coerces anything thrown into a BridgeError without losing the original.
   * `AbortError` is mapped to `CANCELLED` because that is how Node signals aborts.
   */
  static from(value: unknown, fallbackCode: BridgeErrorCode = 'INTERNAL'): BridgeError {
    if (BridgeError.is(value)) return value;
    if (value instanceof Error) {
      const code = value.name === 'AbortError' ? 'CANCELLED' : fallbackCode;
      return new BridgeError(code, value.message, { cause: value });
    }
    return new BridgeError(fallbackCode, String(value));
  }
}

export function isBridgeErrorCode(value: unknown): value is BridgeErrorCode {
  return (
    typeof value === 'string' && (BRIDGE_ERROR_CODES as readonly string[]).includes(value as string)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
