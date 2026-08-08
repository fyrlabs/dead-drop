/**
 * Tracing.
 *
 * A Bridge request crosses at least four boundaries (local IPC, transport
 * write, remote poll, target application), and when it is slow the only useful
 * question is "which hop?". Spans are kept in a bounded in-memory ring so
 * `bridge trace <requestId>` can answer that without an external collector,
 * and an `onSpanEnd` hook lets embedders forward them to OpenTelemetry.
 */

import { createId } from '@dead-drop/protocol';

import type { Clock } from '../clock.js';
import { systemClock } from '../clock.js';

export type SpanStatus = 'ok' | 'error' | 'cancelled';

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status: SpanStatus;
  attributes: Record<string, string | number | boolean>;
  events: Array<{ time: number; name: string; attributes?: Record<string, unknown> }>;
}

export interface ActiveSpan {
  readonly traceId: string;
  readonly spanId: string;
  setAttribute(key: string, value: string | number | boolean): void;
  addEvent(name: string, attributes?: Record<string, unknown>): void;
  /** Starts a span parented to this one. */
  child(name: string, attributes?: Record<string, string | number | boolean>): ActiveSpan;
  end(status?: SpanStatus): void;
}

export interface TracerOptions {
  clock?: Clock;
  /** Retained finished spans. Older ones are evicted. Default 500. */
  limit?: number;
  onSpanEnd?: (span: Span) => void;
  /** Set false to make every span a no-op with near-zero cost. */
  enabled?: boolean;
}

export class Tracer {
  private readonly clock: Clock;
  private readonly limit: number;
  private readonly onSpanEnd: ((span: Span) => void) | undefined;
  private readonly enabled: boolean;
  private finished: Span[] = [];

  constructor(options: TracerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.limit = options.limit ?? 500;
    this.onSpanEnd = options.onSpanEnd;
    this.enabled = options.enabled ?? true;
  }

  startSpan(
    name: string,
    options: {
      traceId?: string;
      parentSpanId?: string;
      attributes?: Record<string, string | number | boolean>;
    } = {},
  ): ActiveSpan {
    if (!this.enabled) return NOOP_SPAN;
    const span: Span = {
      traceId: options.traceId ?? createId(this.clock.now()),
      spanId: createId(this.clock.now()),
      name,
      startedAt: this.clock.now(),
      status: 'ok',
      attributes: { ...options.attributes },
      events: [],
    };
    if (options.parentSpanId) span.parentSpanId = options.parentSpanId;
    return this.makeActive(span);
  }

  /** Every finished span, oldest first. */
  spans(): readonly Span[] {
    return this.finished;
  }

  /** All spans for one trace, in start order. */
  trace(traceId: string): Span[] {
    return this.finished
      .filter((span) => span.traceId === traceId)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  clear(): void {
    this.finished = [];
  }

  private makeActive(span: Span): ActiveSpan {
    let ended = false;
    const active: ActiveSpan = {
      traceId: span.traceId,
      spanId: span.spanId,
      setAttribute: (key, value) => {
        span.attributes[key] = value;
      },
      addEvent: (name, attributes) => {
        const event: Span['events'][number] = { time: this.clock.now(), name };
        if (attributes) event.attributes = attributes;
        span.events.push(event);
      },
      child: (name, attributes) =>
        this.startSpan(name, {
          traceId: span.traceId,
          parentSpanId: span.spanId,
          ...(attributes ? { attributes } : {}),
        }),
      end: (status = 'ok') => {
        if (ended) return; // ending twice would double-report duration
        ended = true;
        span.endedAt = this.clock.now();
        span.durationMs = span.endedAt - span.startedAt;
        span.status = status;
        this.finished.push(span);
        if (this.finished.length > this.limit) {
          this.finished.splice(0, this.finished.length - this.limit);
        }
        this.onSpanEnd?.(span);
      },
    };
    return active;
  }
}

const NOOP_SPAN: ActiveSpan = {
  traceId: '',
  spanId: '',
  setAttribute() {},
  addEvent() {},
  child() {
    return NOOP_SPAN;
  },
  end() {},
};

/** Runs `body` inside a span, ending it with the right status either way. */
export async function withSpan<T>(span: ActiveSpan, body: () => Promise<T>): Promise<T> {
  try {
    const result = await body();
    span.end('ok');
    return result;
  } catch (error) {
    span.setAttribute('error', String((error as Error)?.message ?? error));
    span.end((error as Error)?.name === 'AbortError' ? 'cancelled' : 'error');
    throw error;
  }
}
