/**
 * Metrics.
 *
 * A small counter/gauge/histogram registry with Prometheus text output. No
 * dependency, because pulling a client library into the runtime would force it
 * on every embedder; anyone who wants prom-client can read `snapshot()` and
 * feed it in.
 *
 * Histograms use explicit buckets rather than sketches: transport latency
 * spans milliseconds (memory) to tens of seconds (a git push), and fixed
 * buckets keep p95 honest across that range.
 */

export type MetricLabels = Record<string, string>;

export interface CounterSnapshot {
  type: 'counter';
  name: string;
  help: string;
  values: Array<{ labels: MetricLabels; value: number }>;
}

export interface GaugeSnapshot {
  type: 'gauge';
  name: string;
  help: string;
  values: Array<{ labels: MetricLabels; value: number }>;
}

export interface HistogramSnapshot {
  type: 'histogram';
  name: string;
  help: string;
  values: Array<{
    labels: MetricLabels;
    count: number;
    sum: number;
    buckets: Array<{ le: number; count: number }>;
  }>;
}

export type MetricSnapshot = CounterSnapshot | GaugeSnapshot | HistogramSnapshot;

/** Latency buckets in milliseconds, from an in-memory hop to a slow git push. */
export const DEFAULT_LATENCY_BUCKETS = [
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000,
];

/** Payload size buckets in bytes. */
export const DEFAULT_SIZE_BUCKETS = [
  256, 1024, 4096, 16_384, 65_536, 262_144, 1_048_576, 8_388_608, 67_108_864,
];

function labelKey(labels: MetricLabels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((key) => `${key}=${labels[key] ?? ''}`).join(',');
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  abstract snapshot(): MetricSnapshot;
}

export class Counter extends Metric {
  private readonly values = new Map<string, { labels: MetricLabels; value: number }>();

  inc(labels: MetricLabels = {}, amount = 1): void {
    if (amount < 0) throw new Error(`counter ${this.name} cannot decrease`);
    const key = labelKey(labels);
    const existing = this.values.get(key);
    if (existing) existing.value += amount;
    else this.values.set(key, { labels, value: amount });
  }

  get(labels: MetricLabels = {}): number {
    return this.values.get(labelKey(labels))?.value ?? 0;
  }

  override snapshot(): CounterSnapshot {
    return { type: 'counter', name: this.name, help: this.help, values: [...this.values.values()] };
  }
}

export class Gauge extends Metric {
  private readonly values = new Map<string, { labels: MetricLabels; value: number }>();

  set(value: number, labels: MetricLabels = {}): void {
    this.values.set(labelKey(labels), { labels, value });
  }

  add(delta: number, labels: MetricLabels = {}): void {
    const key = labelKey(labels);
    const existing = this.values.get(key);
    if (existing) existing.value += delta;
    else this.values.set(key, { labels, value: delta });
  }

  get(labels: MetricLabels = {}): number {
    return this.values.get(labelKey(labels))?.value ?? 0;
  }

  override snapshot(): GaugeSnapshot {
    return { type: 'gauge', name: this.name, help: this.help, values: [...this.values.values()] };
  }
}

interface HistogramSeries {
  labels: MetricLabels;
  counts: number[];
  sum: number;
  count: number;
}

export class Histogram extends Metric {
  private readonly series = new Map<string, HistogramSeries>();

  constructor(
    name: string,
    help: string,
    readonly buckets: number[] = DEFAULT_LATENCY_BUCKETS,
  ) {
    super(name, help);
  }

  observe(value: number, labels: MetricLabels = {}): void {
    const key = labelKey(labels);
    let entry = this.series.get(key);
    if (!entry) {
      entry = {
        labels,
        counts: new Array<number>(this.buckets.length + 1).fill(0),
        sum: 0,
        count: 0,
      };
      this.series.set(key, entry);
    }
    entry.sum += value;
    entry.count += 1;
    let index = this.buckets.findIndex((bucket) => value <= bucket);
    if (index < 0) index = this.buckets.length; // +Inf
    entry.counts[index] = (entry.counts[index] ?? 0) + 1;
  }

  /** Approximate quantile from bucket boundaries. Good enough for operations. */
  quantile(q: number, labels: MetricLabels = {}): number | undefined {
    const entry = this.series.get(labelKey(labels));
    if (!entry || entry.count === 0) return undefined;
    const target = q * entry.count;
    let cumulative = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      cumulative += entry.counts[i] ?? 0;
      if (cumulative >= target) return this.buckets[i];
    }
    return Number.POSITIVE_INFINITY;
  }

  count(labels: MetricLabels = {}): number {
    return this.series.get(labelKey(labels))?.count ?? 0;
  }

  override snapshot(): HistogramSnapshot {
    return {
      type: 'histogram',
      name: this.name,
      help: this.help,
      values: [...this.series.values()].map((entry) => {
        let cumulative = 0;
        const buckets = this.buckets.map((le, index) => {
          cumulative += entry.counts[index] ?? 0;
          return { le, count: cumulative };
        });
        return { labels: entry.labels, count: entry.count, sum: entry.sum, buckets };
      }),
    };
  }
}

/** The metrics a dead-drop runtime always publishes. */
export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();

  readonly messagesSent = this.counter(
    'deaddrop_messages_sent_total',
    'Envelopes handed to a transport',
  );
  readonly messagesReceived = this.counter(
    'deaddrop_messages_received_total',
    'Envelopes accepted from a transport',
  );
  readonly messagesDropped = this.counter(
    'deaddrop_messages_dropped_total',
    'Envelopes discarded (expired, duplicate, undecodable, dead-lettered)',
  );
  readonly transportOperations = this.counter(
    'deaddrop_transport_operations_total',
    'Transport operations by transport, operation and outcome',
  );
  readonly transportRetries = this.counter(
    'deaddrop_transport_retries_total',
    'Transport operations retried',
  );
  readonly failovers = this.counter(
    'deaddrop_failovers_total',
    'Times an operation moved to a different transport',
  );
  readonly requestsTotal = this.counter('deaddrop_requests_total', 'dead-drop requests by outcome');

  readonly transportLatency = this.histogram(
    'deaddrop_transport_operation_duration_ms',
    'Transport operation duration in milliseconds',
  );
  readonly requestLatency = this.histogram(
    'deaddrop_request_duration_ms',
    'End-to-end request duration in milliseconds',
  );
  readonly payloadBytes = this.histogram(
    'deaddrop_payload_bytes',
    'Wire size of transported frames',
    DEFAULT_SIZE_BUCKETS,
  );

  readonly queueDepth = this.gauge('deaddrop_queue_depth', 'Messages waiting in the outbox');
  readonly inflightRequests = this.gauge(
    'deaddrop_inflight_requests',
    'Requests awaiting a response',
  );
  readonly transportHealth = this.gauge(
    'deaddrop_transport_health',
    'Transport health: 1 healthy, 0.5 degraded, 0 unavailable',
  );
  readonly transportRateLimitRemaining = this.gauge(
    'deaddrop_transport_rate_limit_remaining',
    'Remaining rate-limit budget reported by a transport',
  );
  readonly pollIntervalMs = this.gauge(
    'deaddrop_poll_interval_ms',
    'Current adaptive poll interval per transport',
  );
  readonly cacheHitRatio = this.gauge('deaddrop_cache_hit_ratio', 'Local cache hit ratio, 0..1');

  counter(name: string, help: string): Counter {
    return this.register(name, () => new Counter(name, help)) as Counter;
  }

  gauge(name: string, help: string): Gauge {
    return this.register(name, () => new Gauge(name, help)) as Gauge;
  }

  histogram(name: string, help: string, buckets?: number[]): Histogram {
    return this.register(name, () => new Histogram(name, help, buckets)) as Histogram;
  }

  snapshot(): MetricSnapshot[] {
    return [...this.metrics.values()].map((metric) => metric.snapshot());
  }

  /** Prometheus text exposition format. */
  toPrometheus(): string {
    const lines: string[] = [];
    for (const metric of this.snapshot()) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);
      if (metric.type === 'histogram') {
        for (const series of metric.values) {
          for (const bucket of series.buckets) {
            lines.push(
              `${metric.name}_bucket${formatLabels({ ...series.labels, le: String(bucket.le) })} ${bucket.count}`,
            );
          }
          lines.push(
            `${metric.name}_bucket${formatLabels({ ...series.labels, le: '+Inf' })} ${series.count}`,
          );
          lines.push(`${metric.name}_sum${formatLabels(series.labels)} ${series.sum}`);
          lines.push(`${metric.name}_count${formatLabels(series.labels)} ${series.count}`);
        }
      } else {
        for (const series of metric.values) {
          lines.push(`${metric.name}${formatLabels(series.labels)} ${series.value}`);
        }
      }
    }
    return `${lines.join('\n')}\n`;
  }

  private register(name: string, create: () => Metric): Metric {
    const existing = this.metrics.get(name);
    if (existing) return existing;
    const metric = create();
    this.metrics.set(name, metric);
    return metric;
  }
}

function formatLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return '';
  const body = entries
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
    .join(',');
  return `{${body}}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export const healthToNumber = (status: 'healthy' | 'degraded' | 'unavailable'): number =>
  status === 'healthy' ? 1 : status === 'degraded' ? 0.5 : 0;
