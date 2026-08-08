import { describe, expect, it, vi } from 'vitest';

import { TestClock } from '../clock.js';
import {
  MemoryLogSink,
  REDACTED,
  createLogger,
  isLogLevel,
  jsonSink,
  prettySink,
  redactFields,
  redactValue,
} from './logger.js';
import { Counter, Gauge, Histogram, MetricsRegistry, healthToNumber } from './metrics.js';
import { Tracer, withSpan } from './tracer.js';

describe('logger', () => {
  const build = (level: 'debug' | 'info' | 'warn' | 'error' | 'silent' = 'debug') => {
    const captured = new MemoryLogSink();
    const logger = createLogger({ level, sink: captured.sink, clock: new TestClock(1000) });
    return { logger, captured };
  };

  it('writes structured records with the configured clock', () => {
    const { logger, captured } = build();
    logger.info('transport started', { transport: 'github' });
    expect(captured.records).toEqual([
      { time: 1000, level: 'info', message: 'transport started', fields: { transport: 'github' } },
    ]);
  });

  it('filters below the configured level', () => {
    const { logger, captured } = build('warn');
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    expect(captured.records.map((record) => record.level)).toEqual(['warn', 'error']);
  });

  it('silences everything at level silent', () => {
    const { logger, captured } = build('silent');
    logger.error('boom');
    expect(captured.records).toHaveLength(0);
  });

  it('merges child fields and keeps the parent sink', () => {
    const { logger, captured } = build();
    logger.child({ workspace: 'demo' }).child({ peer: 'a' }).info('hello', { extra: 1 });
    expect(captured.records[0]?.fields).toEqual({ workspace: 'demo', peer: 'a', extra: 1 });
  });

  it('redacts secret-looking field names', () => {
    const { logger, captured } = build();
    logger.info('config', {
      token: 'abc123',
      Authorization: 'Bearer xyz',
      nested: { apiKey: 'k', safe: 'visible' },
    });
    expect(captured.records[0]?.fields).toEqual({
      token: REDACTED,
      Authorization: REDACTED,
      nested: { apiKey: REDACTED, safe: 'visible' },
    });
  });

  it('redacts secret-looking values anywhere they appear', () => {
    expect(redactValue('using ddk1_AAAAAAAAAAAAAAAAAAAAAAAAAAAA now')).toBe(
      `using ${REDACTED} now`,
    );
    expect(redactValue('ghp_0123456789abcdefghijklmnopqrstuv')).toBe(REDACTED);
    expect(redactValue('glpat-0123456789abcdefghij')).toBe(REDACTED);
    expect(redactValue('AKIAIOSFODNN7EXAMPLE')).toBe(REDACTED);
    expect(redactValue('nothing secret here')).toBe('nothing secret here');
  });

  it('redacts secrets embedded in the message itself', () => {
    const { logger, captured } = build();
    logger.error('failed with ghp_0123456789abcdefghijklmnopqrstuv');
    expect(captured.records[0]?.message).toBe(`failed with ${REDACTED}`);
  });

  it('survives cycles, deep nesting, errors and binary fields', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    const deep = { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } };
    const result = redactFields({
      cyclic,
      deep,
      error: new Error('boom'),
      bytes: new Uint8Array(8),
      list: [1, 2, 3],
    });
    expect(JSON.stringify(result)).toContain('[circular]');
    expect(JSON.stringify(result)).toContain('[truncated]');
    expect(result.error).toEqual({ name: 'Error', message: 'boom' });
    expect(result.bytes).toBe('<8 bytes>');
    expect(result.list).toEqual([1, 2, 3]);
  });

  it('never lets a broken sink break the caller', () => {
    const logger = createLogger({
      level: 'info',
      sink: () => {
        throw new Error('sink exploded');
      },
    });
    expect(() => logger.info('hello')).not.toThrow();
  });

  it('formats json and pretty output', () => {
    const lines: string[] = [];
    jsonSink((line) => lines.push(line))({
      time: 0,
      level: 'info',
      message: 'hi',
      fields: { a: 1 },
    });
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'info', msg: 'hi', a: 1 });

    const pretty: string[] = [];
    prettySink((line) => pretty.push(line))({
      time: 0,
      level: 'warn',
      message: 'careful',
      fields: { a: 1 },
    });
    expect(pretty[0]).toContain('WARN');
    expect(pretty[0]).toContain('a=1');
  });

  it('caps the memory sink and can be cleared', () => {
    const sink = new MemoryLogSink(2);
    for (const message of ['a', 'b', 'c']) {
      sink.sink({ time: 0, level: 'info', message, fields: {} });
    }
    expect(sink.records.map((record) => record.message)).toEqual(['b', 'c']);
    expect(sink.find((record) => record.message === 'c')).toBeDefined();
    sink.clear();
    expect(sink.records).toHaveLength(0);
  });

  it('validates log levels', () => {
    expect(isLogLevel('debug')).toBe(true);
    expect(isLogLevel('loud')).toBe(false);
  });
});

describe('metrics', () => {
  it('counts by label set', () => {
    const counter = new Counter('c', 'help');
    counter.inc({ transport: 'a' });
    counter.inc({ transport: 'a' }, 2);
    counter.inc({ transport: 'b' });
    expect(counter.get({ transport: 'a' })).toBe(3);
    expect(counter.get({ transport: 'b' })).toBe(1);
    expect(counter.get({ transport: 'missing' })).toBe(0);
    expect(() => counter.inc({}, -1)).toThrowError(/cannot decrease/);
  });

  it('treats label order as irrelevant', () => {
    const counter = new Counter('c', 'help');
    counter.inc({ a: '1', b: '2' });
    expect(counter.get({ b: '2', a: '1' })).toBe(1);
  });

  it('sets and adjusts gauges', () => {
    const gauge = new Gauge('g', 'help');
    gauge.set(5);
    gauge.add(-2);
    expect(gauge.get()).toBe(3);
    gauge.add(1, { q: 'x' });
    expect(gauge.get({ q: 'x' })).toBe(1);
  });

  it('buckets histogram observations and estimates quantiles', () => {
    const histogram = new Histogram('h', 'help', [10, 100, 1000]);
    for (const value of [5, 50, 500, 5000]) histogram.observe(value);
    expect(histogram.count()).toBe(4);
    expect(histogram.quantile(0.25)).toBe(10);
    expect(histogram.quantile(0.5)).toBe(100);
    expect(histogram.quantile(0.99)).toBe(Number.POSITIVE_INFINITY);
    expect(histogram.quantile(0.5, { nope: '1' })).toBeUndefined();
  });

  it('exports Prometheus text with cumulative buckets', () => {
    const registry = new MetricsRegistry();
    registry.messagesSent.inc({ kind: 'event' }, 2);
    registry.queueDepth.set(7);
    registry.transportLatency.observe(30, { transport: 'a' });
    const text = registry.toPrometheus();

    expect(text).toContain('# TYPE bridge_messages_sent_total counter');
    expect(text).toContain('bridge_messages_sent_total{kind="event"} 2');
    expect(text).toContain('bridge_queue_depth 7');
    expect(text).toContain('bridge_transport_operation_duration_ms_count{transport="a"} 1');
    expect(text).toContain('le="+Inf"');
  });

  it('escapes label values', () => {
    const registry = new MetricsRegistry();
    registry.messagesSent.inc({ kind: 'we"ird\\' });
    expect(registry.toPrometheus()).toContain('kind="we\\"ird\\\\"');
  });

  it('returns the same instrument for a repeated name', () => {
    const registry = new MetricsRegistry();
    expect(registry.counter('bridge_messages_sent_total', 'x')).toBe(registry.messagesSent);
  });

  it('snapshots every registered metric', () => {
    const registry = new MetricsRegistry();
    registry.messagesSent.inc();
    const names = registry.snapshot().map((metric) => metric.name);
    expect(names).toContain('bridge_messages_sent_total');
    expect(names).toContain('bridge_transport_operation_duration_ms');
  });

  it('maps health status to a gauge value', () => {
    expect(healthToNumber('healthy')).toBe(1);
    expect(healthToNumber('degraded')).toBe(0.5);
    expect(healthToNumber('unavailable')).toBe(0);
  });
});

describe('tracer', () => {
  it('records spans with durations from the injected clock', async () => {
    const clock = new TestClock(0);
    const tracer = new Tracer({ clock });
    const span = tracer.startSpan('transport.put', { attributes: { transport: 'memory' } });
    await clock.advance(25);
    span.end('ok');

    const [recorded] = tracer.spans();
    expect(recorded?.name).toBe('transport.put');
    expect(recorded?.durationMs).toBe(25);
    expect(recorded?.attributes.transport).toBe('memory');
  });

  it('links children to their parent and shares a trace id', () => {
    const tracer = new Tracer({ clock: new TestClock(0) });
    const parent = tracer.startSpan('request');
    const child = parent.child('transport.put');
    child.end();
    parent.end();

    const trace = tracer.trace(parent.traceId);
    expect(trace).toHaveLength(2);
    expect(trace[1]?.parentSpanId ?? trace[0]?.parentSpanId).toBe(parent.spanId);
  });

  it('ignores a second end call', () => {
    const tracer = new Tracer({ clock: new TestClock(0) });
    const span = tracer.startSpan('op');
    span.end();
    span.end('error');
    expect(tracer.spans()).toHaveLength(1);
    expect(tracer.spans()[0]?.status).toBe('ok');
  });

  it('records events and attributes', () => {
    const tracer = new Tracer({ clock: new TestClock(5) });
    const span = tracer.startSpan('op');
    span.setAttribute('attempt', 2);
    span.addEvent('retrying', { delayMs: 100 });
    span.addEvent('gave-up');
    span.end();
    expect(tracer.spans()[0]?.events).toEqual([
      { time: 5, name: 'retrying', attributes: { delayMs: 100 } },
      { time: 5, name: 'gave-up' },
    ]);
  });

  it('bounds retained spans and can be cleared', () => {
    const tracer = new Tracer({ clock: new TestClock(0), limit: 2 });
    for (let i = 0; i < 5; i++) tracer.startSpan(`op-${i}`).end();
    expect(tracer.spans()).toHaveLength(2);
    expect(tracer.spans()[1]?.name).toBe('op-4');
    tracer.clear();
    expect(tracer.spans()).toHaveLength(0);
  });

  it('forwards finished spans to a hook', () => {
    const onSpanEnd = vi.fn();
    const tracer = new Tracer({ clock: new TestClock(0), onSpanEnd });
    tracer.startSpan('op').end();
    expect(onSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('produces cheap no-op spans when disabled', () => {
    const tracer = new Tracer({ enabled: false });
    const span = tracer.startSpan('op');
    span.setAttribute('a', 1);
    span.child('b').end();
    span.end();
    expect(tracer.spans()).toHaveLength(0);
  });

  it('withSpan ends ok on success and error on failure', async () => {
    const tracer = new Tracer({ clock: new TestClock(0) });
    await withSpan(tracer.startSpan('ok-op'), async () => 'value');
    await expect(
      withSpan(tracer.startSpan('bad-op'), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow();

    const abort = new Error('stopped');
    abort.name = 'AbortError';
    await expect(
      withSpan(tracer.startSpan('cancelled-op'), async () => {
        throw abort;
      }),
    ).rejects.toThrow();

    expect(tracer.spans().map((span) => span.status)).toEqual(['ok', 'error', 'cancelled']);
  });
});
