/**
 * Structured logging.
 *
 * dead-drop sits between an application and a credentialed transport, so the log
 * is the main way an operator finds out what happened. Two rules follow from
 * that: records are JSON with stable field names (greppable, ingestible), and
 * anything that smells like a credential is redacted before it is written.
 */

import type { Clock } from '../clock.js';
import { systemClock } from '../clock.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface LogRecord {
  time: number;
  level: Exclude<LogLevel, 'silent'>;
  message: string;
  fields: Record<string, unknown>;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** Returns a logger that merges `fields` into every record. */
  child(fields: Record<string, unknown>): Logger;
  readonly level: LogLevel;
}

/** Field names whose values are replaced with `[redacted]`. */
const SECRET_KEYS = [
  'secret',
  'token',
  'password',
  'passwd',
  'authorization',
  'apikey',
  'api_key',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'privatekey',
  'private_key',
  'credential',
  'cookie',
  'sessionid',
];

/** Value patterns that are secrets wherever they appear. */
const SECRET_VALUE_PATTERNS = [
  /\bddk1_[A-Za-z0-9_-]{20,}/g, // dead-drop workspace secret
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bglpat-[A-Za-z0-9_-]{16,}/g, // GitLab PAT
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
];

export const REDACTED = '[redacted]';

export function redactValue(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/**
 * Deep-redacts a field map. Depth-limited and cycle-safe: log fields come from
 * anywhere, including application code, and a logger must never be the thing
 * that takes the process down.
 */
export function redactFields(
  fields: Record<string, unknown>,
  maxDepth = 6,
): Record<string, unknown> {
  const seen = new WeakSet<object>();

  const walk = (value: unknown, depth: number, keyHint: string): unknown => {
    if (depth > maxDepth) return '[truncated]';
    if (typeof value === 'string') {
      return isSecretKey(keyHint) ? REDACTED : redactValue(value);
    }
    if (value === null || typeof value !== 'object') {
      return isSecretKey(keyHint) ? REDACTED : value;
    }
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    if (value instanceof Error) {
      return { name: value.name, message: redactValue(value.message) };
    }
    if (Array.isArray(value)) {
      return value.slice(0, 100).map((item) => walk(item, depth + 1, keyHint));
    }
    if (value instanceof Uint8Array) return `<${value.length} bytes>`;

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? REDACTED : walk(item, depth + 1, key);
    }
    return out;
  };

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = isSecretKey(key) ? REDACTED : walk(value, 1, key);
  }
  return result;
}

function isSecretKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[^a-z_]/g, '');
  return SECRET_KEYS.some((secret) => normalised.includes(secret.replace(/[^a-z_]/g, '')));
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  clock?: Clock;
  /** Merged into every record produced by this logger. */
  base?: Record<string, unknown>;
}

class StructuredLogger implements Logger {
  readonly level: LogLevel;
  private readonly sink: LogSink;
  private readonly clock: Clock;
  private readonly base: Record<string, unknown>;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.sink = options.sink ?? jsonSink();
    this.clock = options.clock ?? systemClock;
    this.base = options.base ?? {};
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write('debug', message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.write('info', message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('warn', message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.write('error', message, fields);
  }

  child(fields: Record<string, unknown>): Logger {
    return new StructuredLogger({
      level: this.level,
      sink: this.sink,
      clock: this.clock,
      base: { ...this.base, ...fields },
    });
  }

  private write(
    level: Exclude<LogLevel, 'silent'>,
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const record: LogRecord = {
      time: this.clock.now(),
      level,
      message: redactValue(message),
      fields: redactFields({ ...this.base, ...fields }),
    };
    try {
      this.sink(record);
    } catch {
      // A broken sink must not break the caller.
    }
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new StructuredLogger(options);
}

/** Writes newline-delimited JSON to stderr, keeping stdout free for real output. */
export function jsonSink(write: (line: string) => void = defaultWrite): LogSink {
  return (record) => {
    write(
      JSON.stringify({
        time: new Date(record.time).toISOString(),
        level: record.level,
        msg: record.message,
        ...record.fields,
      }),
    );
  };
}

function defaultWrite(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** Human-friendly sink for interactive CLI use. */
export function prettySink(write: (line: string) => void = defaultWrite): LogSink {
  return (record) => {
    const time = new Date(record.time).toISOString().slice(11, 23);
    const extras = Object.entries(record.fields)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(' ');
    write(
      `${time} ${record.level.toUpperCase().padEnd(5)} ${record.message}${extras ? ` ${extras}` : ''}`,
    );
  };
}

/** Captures records in memory. Used by `ddrop logs` and by tests. */
export class MemoryLogSink {
  readonly records: LogRecord[] = [];
  constructor(private readonly limit = 1000) {}

  readonly sink: LogSink = (record) => {
    this.records.push(record);
    if (this.records.length > this.limit) this.records.splice(0, this.records.length - this.limit);
  };

  find(predicate: (record: LogRecord) => boolean): LogRecord | undefined {
    return this.records.find(predicate);
  }

  clear(): void {
    this.records.length = 0;
  }
}

export const silentLogger: Logger = createLogger({ level: 'silent', sink: () => undefined });

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}
