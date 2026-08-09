/**
 * Transport manager: owns transport instances, their health, and the decision
 * about which one carries a given operation.
 *
 * This is where "the application never knows how bytes move" is actually
 * enforced. Callers ask for an operation to happen; the manager picks a
 * transport, retries it, trips a breaker, fails over to the next one, and
 * records what happened. Nothing above it names a transport.
 */

import { DeadDropError } from '../protocol/index.js';
import type {
  Transport,
  TransportCapabilities,
  TransportContext,
  TransportHealth,
  TransportRegistration,
} from '@fyrlabs/dead-drop-transport-sdk';
import { registrationName } from '@fyrlabs/dead-drop-transport-sdk';

import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import type { Logger } from './observability/logger.js';
import { silentLogger } from './observability/logger.js';
import { MetricsRegistry, healthToNumber } from './observability/metrics.js';
import type { TraceContext, Tracer } from './observability/tracer.js';
import { CircuitBreaker, isBreakerOpen } from './reliability/circuit-breaker.js';
import {
  DEFAULT_RETRY_POLICY,
  withRetry,
  withTimeout,
  type RetryPolicy,
} from './reliability/retry.js';

export type TransportMode = 'failover' | 'parallel' | 'score';

export interface TransportPolicy {
  /**
   * - `score`   (default) picks the healthiest transport by score.
   * - `failover` respects `primary` then `fallback` order strictly.
   * - `parallel` sends through every healthy transport; receivers deduplicate.
   */
  mode?: TransportMode;
  primary?: string;
  fallback?: string[];
}

export interface TransportRequirements {
  /** Needs byte-exact payloads. */
  binaryPayloads?: boolean;
  /** Needs at least this much room in a single object. */
  minPayloadBytes?: number;
  /** Needs per-recipient ordering. */
  ordering?: 'partition' | 'global';
  /** Restricts the choice to these transport instance names. */
  only?: string[];
}

export interface ManagedTransport {
  readonly name: string;
  readonly id: string;
  readonly transport: Transport;
  readonly capabilities: TransportCapabilities;
  readonly breaker: CircuitBreaker;
  health: TransportHealth;
  /** Measured round trip of the last successful operation. */
  observedLatencyMs: number;
  lastHealthCheckAt: number;
  consecutiveFailures: number;
}

export interface TransportInfo {
  name: string;
  id: string;
  kind: TransportCapabilities['kind'];
  status: TransportHealth['status'];
  breaker: string;
  score: number;
  latencyMs: number | undefined;
  errorRate: number;
  rateLimitRemaining: number | undefined;
  lastHealthCheckAt: number;
  message: string | undefined;
}

export interface TransportManagerOptions {
  workspace: string;
  peerId: string;
  registrations: ReadonlyArray<TransportRegistration<never>>;
  policy?: TransportPolicy;
  logger?: Logger;
  metrics?: MetricsRegistry;
  tracer?: Tracer;
  clock?: Clock;
  retry?: Partial<RetryPolicy>;
  /** Health probe interval. Default 30s. */
  healthIntervalMs?: number;
  /** Per-operation timeout. Default 60s. */
  operationTimeoutMs?: number;
  signal?: AbortSignal;
}

const HEALTH_WEIGHT = 0.45;
const LATENCY_WEIGHT = 0.2;
const RELIABILITY_WEIGHT = 0.25;
const RATE_LIMIT_WEIGHT = 0.1;

export class TransportManager {
  readonly metrics: MetricsRegistry;
  private readonly workspace: string;
  private readonly peerId: string;
  private readonly registrations: ReadonlyArray<TransportRegistration<never>>;
  private readonly policy: TransportPolicy;
  private readonly logger: Logger;
  private readonly tracer: Tracer | undefined;
  private readonly clock: Clock;
  private readonly retryPolicy: RetryPolicy;
  private readonly healthIntervalMs: number;
  private readonly operationTimeoutMs: number;
  private readonly controller = new AbortController();
  private readonly managed = new Map<string, ManagedTransport>();
  private stopHealthLoop: (() => void) | undefined;
  private started = false;

  constructor(options: TransportManagerOptions) {
    this.workspace = options.workspace;
    this.peerId = options.peerId;
    this.registrations = options.registrations;
    this.policy = options.policy ?? {};
    this.logger = (options.logger ?? silentLogger).child({ component: 'transport-manager' });
    this.metrics = options.metrics ?? new MetricsRegistry();
    this.tracer = options.tracer;
    this.clock = options.clock ?? systemClock;
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.healthIntervalMs = options.healthIntervalMs ?? 30_000;
    this.operationTimeoutMs = options.operationTimeoutMs ?? 60_000;
    options.signal?.addEventListener('abort', () => this.controller.abort(), { once: true });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (this.registrations.length === 0) {
      throw new DeadDropError('CONFIG_INVALID', 'a workspace needs at least one transport');
    }

    for (const registration of this.registrations) {
      const name = registrationName(registration);
      if (this.managed.has(name)) {
        throw new DeadDropError(
          'CONFIG_INVALID',
          `duplicate transport instance name "${name}"; give one of them a distinct name`,
        );
      }
      const context: TransportContext = {
        workspace: this.workspace,
        peerId: this.peerId,
        instance: name,
        logger: this.logger.child({ transport: name }),
        signal: this.controller.signal,
        now: () => this.clock.now(),
      };
      const transport = await registration.definition.create(registration.config, context);
      const breaker = new CircuitBreaker(name, {
        clock: this.clock,
        onStateChange: (from, to) => {
          this.logger.warn('transport circuit breaker changed state', {
            transport: name,
            from,
            to,
          });
        },
      });
      this.managed.set(name, {
        name,
        id: registration.definition.id,
        transport,
        capabilities: registration.definition.capabilities,
        breaker,
        health: { status: 'healthy' },
        observedLatencyMs: registration.definition.capabilities.expectedLatencyMs ?? 0,
        lastHealthCheckAt: 0,
        consecutiveFailures: 0,
      });
    }

    this.validatePolicy();
    await this.checkHealth();
    this.stopHealthLoop = this.clock.setInterval(this.healthIntervalMs, () => {
      void this.checkHealth().catch((error: unknown) => {
        this.logger.warn('health check sweep failed', { error: String(error) });
      });
    });
    this.logger.info('transports started', { transports: [...this.managed.keys()] });
  }

  async stop(): Promise<void> {
    this.stopHealthLoop?.();
    this.stopHealthLoop = undefined;
    this.controller.abort();
    await Promise.all(
      [...this.managed.values()].map(async (entry) => {
        try {
          await entry.transport.close();
        } catch (error) {
          this.logger.warn('transport failed to close cleanly', {
            transport: entry.name,
            error: String(error),
          });
        }
      }),
    );
    this.managed.clear();
    this.started = false;
  }

  get(name: string): ManagedTransport {
    const entry = this.managed.get(name);
    if (!entry) {
      throw new DeadDropError('NOT_FOUND', `no transport named "${name}"`, {
        details: { known: [...this.managed.keys()] },
      });
    }
    return entry;
  }

  all(): ManagedTransport[] {
    return [...this.managed.values()];
  }

  /** Every store transport, in selection order. Used by the mailbox engine. */
  stores(): ManagedTransport[] {
    return this.select({}).filter((entry) => entry.capabilities.kind === 'store');
  }

  list(): TransportInfo[] {
    return this.all().map((entry) => ({
      name: entry.name,
      id: entry.id,
      kind: entry.capabilities.kind,
      status: entry.health.status,
      breaker: entry.breaker.current,
      score: this.score(entry),
      latencyMs: entry.health.latencyMs ?? entry.observedLatencyMs,
      errorRate: entry.breaker.errorRate,
      rateLimitRemaining: entry.health.rateLimit?.remaining,
      lastHealthCheckAt: entry.lastHealthCheckAt,
      message: entry.health.message,
    }));
  }

  /**
   * Transports that satisfy `requirements`, best first.
   *
   * Ordering respects the configured policy: `failover` uses the declared order
   * verbatim so an operator's intent is not silently overridden, everything
   * else sorts by score.
   */
  select(requirements: TransportRequirements = {}): ManagedTransport[] {
    const eligible = this.all().filter((entry) => this.satisfies(entry, requirements));
    if (this.policy.mode === 'failover') {
      const order = [this.policy.primary, ...(this.policy.fallback ?? [])].filter(
        (name): name is string => typeof name === 'string',
      );
      const ranked = order
        .map((name) => eligible.find((entry) => entry.name === name))
        .filter((entry): entry is ManagedTransport => entry !== undefined);
      // Anything not named in the policy still gets a turn, after the named ones.
      const rest = eligible.filter((entry) => !order.includes(entry.name));
      return [...ranked, ...rest.sort((a, b) => this.score(b) - this.score(a))];
    }
    return eligible.sort((a, b) => {
      if (this.policy.primary) {
        if (a.name === this.policy.primary && b.name !== this.policy.primary) return -1;
        if (b.name === this.policy.primary && a.name !== this.policy.primary) return 1;
      }
      return this.score(b) - this.score(a);
    });
  }

  /**
   * 0..1 desirability. Health dominates, then recent reliability, then latency,
   * then rate-limit headroom. An open breaker scores 0 so it is chosen only
   * when nothing else exists.
   */
  score(entry: ManagedTransport): number {
    if (entry.breaker.current === 'open') return 0;
    const health = healthToNumber(entry.health.status);
    if (health === 0) return 0;

    const latency = entry.health.latencyMs ?? entry.observedLatencyMs;
    // 1 at 0ms, 0.5 at 1s, approaching 0 as latency grows.
    const latencyScore = 1 / (1 + latency / 1000);
    const reliability = 1 - entry.breaker.errorRate;
    const rateLimit = entry.health.rateLimit;
    const rateLimitScore =
      rateLimit?.remaining !== undefined && rateLimit.limit
        ? Math.max(0, Math.min(1, rateLimit.remaining / rateLimit.limit))
        : 1;
    const halfOpenPenalty = entry.breaker.current === 'half-open' ? 0.5 : 1;

    return (
      (health * HEALTH_WEIGHT +
        reliability * RELIABILITY_WEIGHT +
        latencyScore * LATENCY_WEIGHT +
        rateLimitScore * RATE_LIMIT_WEIGHT) *
      halfOpenPenalty
    );
  }

  /**
   * Runs `body` against the best transport, retrying and failing over.
   *
   * Retries stay on one transport (a transient blip is usually local); moving
   * to the next transport happens only once that one is exhausted, and it is
   * counted separately so `ddrop metrics` can distinguish a flaky transport
   * from a flaky network.
   */
  async run<T>(
    operation: string,
    body: (transport: Transport, entry: ManagedTransport) => Promise<T>,
    options: {
      requirements?: TransportRequirements;
      timeoutMs?: number;
      signal?: AbortSignal;
      /** Overrides the retry policy for this call. */
      retry?: Partial<RetryPolicy>;
      /** Attaches the transport spans to the caller trace. */
      trace?: TraceContext;
    } = {},
  ): Promise<T> {
    const candidates = this.select(options.requirements ?? {});
    if (candidates.length === 0) {
      throw new DeadDropError(
        'NO_TRANSPORT_AVAILABLE',
        `no transport satisfies the requirements for ${operation}`,
        { details: { operation, requirements: options.requirements ?? {} } },
      );
    }

    const timeoutMs = options.timeoutMs ?? this.operationTimeoutMs;
    let lastError: DeadDropError | undefined;

    for (const [index, entry] of candidates.entries()) {
      if (index > 0) {
        this.metrics.failovers.inc({ from: candidates[index - 1]!.name, to: entry.name });
        this.logger.warn('failing over to the next transport', {
          operation,
          from: candidates[index - 1]!.name,
          to: entry.name,
          reason: lastError?.message,
        });
      }
      try {
        return await this.runOn(entry, operation, body, timeoutMs, options);
      } catch (error) {
        const deadDropError = DeadDropError.from(error, 'TRANSPORT_ERROR');
        // Caller-side problems are not the transport's fault; another transport
        // will fail identically, so stop rather than amplify the damage.
        if (!isWorthFailingOver(deadDropError)) throw deadDropError;
        lastError = deadDropError;
      }
    }

    throw new DeadDropError(
      'NO_TRANSPORT_AVAILABLE',
      `every transport failed for ${operation}: ${lastError?.message ?? 'unknown error'}`,
      {
        cause: lastError,
        details: { operation, tried: candidates.map((entry) => entry.name) },
      },
    );
  }

  /** Runs `body` on every healthy transport. Resolves if at least one succeeds. */
  async runAll<T>(
    operation: string,
    body: (transport: Transport, entry: ManagedTransport) => Promise<T>,
    options: {
      requirements?: TransportRequirements;
      timeoutMs?: number;
      signal?: AbortSignal;
      trace?: TraceContext;
    } = {},
  ): Promise<T[]> {
    const candidates = this.select(options.requirements ?? {});
    if (candidates.length === 0) {
      throw new DeadDropError('NO_TRANSPORT_AVAILABLE', `no transport available for ${operation}`);
    }
    const timeoutMs = options.timeoutMs ?? this.operationTimeoutMs;
    const results = await Promise.allSettled(
      candidates.map((entry) => this.runOn(entry, operation, body, timeoutMs, options)),
    );
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<T>> => result.status === 'fulfilled',
    );
    if (fulfilled.length === 0) {
      const first = results[0];
      throw DeadDropError.from(
        first && first.status === 'rejected' ? first.reason : undefined,
        'NO_TRANSPORT_AVAILABLE',
      );
    }
    return fulfilled.map((result) => result.value);
  }

  /** Probes every transport and refreshes health, scores and gauges. */
  async checkHealth(): Promise<void> {
    await Promise.all(
      this.all().map(async (entry) => {
        const started = this.clock.now();
        try {
          const health = await withTimeout(
            entry.transport.health(),
            Math.min(this.operationTimeoutMs, 15_000),
            `health check for ${entry.name}`,
            this.clock,
          );
          entry.health = health;
          entry.lastHealthCheckAt = this.clock.now();
          if (health.latencyMs === undefined) {
            entry.health = { ...health, latencyMs: this.clock.now() - started };
          }
        } catch (error) {
          const failure = DeadDropError.from(error);
          const previousMessage = entry.health.message;
          entry.health = {
            status: 'unavailable',
            message: failure.message,
            latencyMs: this.clock.now() - started,
          };
          entry.lastHealthCheckAt = this.clock.now();
          // A non-retryable health failure is a misconfiguration, not a blip:
          // retrying will never clear it. Surface it, because the only other
          // signal is a flapping circuit breaker. A wrong `repo` used to look
          // like a healthy start -- "runtime started", "control plane
          // listening", then silence -- with the transport's own actionable
          // message reaching no log at all. Logged only when the message
          // changes, so a permanent fault does not repeat on every sweep.
          if (!failure.retryable && previousMessage !== failure.message) {
            this.logger.error('transport is unusable and will not recover on its own', {
              transport: entry.name,
              code: failure.code,
              error: failure.message,
            });
          }
        }
        this.metrics.transportHealth.set(healthToNumber(entry.health.status), {
          transport: entry.name,
        });
        if (entry.health.rateLimit?.remaining !== undefined) {
          this.metrics.transportRateLimitRemaining.set(entry.health.rateLimit.remaining, {
            transport: entry.name,
          });
        }
      }),
    );
  }

  private async runOn<T>(
    entry: ManagedTransport,
    operation: string,
    body: (transport: Transport, entry: ManagedTransport) => Promise<T>,
    timeoutMs: number,
    options: { signal?: AbortSignal; retry?: Partial<RetryPolicy>; trace?: TraceContext },
  ): Promise<T> {
    const span = this.tracer?.startSpan(`transport.${operation}`, {
      attributes: { transport: entry.name, operation },
      ...(options.trace?.traceId ? { traceId: options.trace.traceId } : {}),
      ...(options.trace?.parentSpanId ? { parentSpanId: options.trace.parentSpanId } : {}),
    });
    const startedAt = this.clock.now();
    try {
      const result = await withRetry(
        async (attempt) => {
          if (attempt > 1) this.metrics.transportRetries.inc({ transport: entry.name, operation });
          return entry.breaker.execute(() =>
            withTimeout(
              body(entry.transport, entry),
              timeoutMs,
              `${operation} on ${entry.name}`,
              this.clock,
            ),
          );
        },
        {
          policy: { ...this.retryPolicy, ...options.retry },
          clock: this.clock,
          ...(options.signal ? { signal: options.signal } : {}),
          // An open breaker is a decision already made about this transport, so
          // retrying it here is asking the same question five times and sleeping
          // up to 30 seconds between asks. Failing immediately hands control
          // back to `run`, which moves to the next transport — which is the
          // entire reason a fallback is configured. This one predicate was the
          // difference between failing over in seconds and taking minutes.
          isRetryable: (error) => !isBreakerOpen(error) && error.retryable,
          onRetry: ({ attempt, error, delayMs }) => {
            this.logger.debug('retrying transport operation', {
              transport: entry.name,
              operation,
              attempt,
              delayMs,
              error: error.message,
            });
          },
        },
      );
      const duration = this.clock.now() - startedAt;
      entry.observedLatencyMs = duration;
      entry.consecutiveFailures = 0;
      this.metrics.transportOperations.inc({
        transport: entry.name,
        operation,
        outcome: 'success',
      });
      this.metrics.transportLatency.observe(duration, { transport: entry.name, operation });
      span?.end('ok');
      return result;
    } catch (error) {
      entry.consecutiveFailures += 1;
      const deadDropError = DeadDropError.from(error, 'TRANSPORT_ERROR');
      this.metrics.transportOperations.inc({
        transport: entry.name,
        operation,
        outcome: deadDropError.code === 'CANCELLED' ? 'cancelled' : 'failure',
      });
      span?.setAttribute('error', deadDropError.message);
      span?.end(deadDropError.code === 'CANCELLED' ? 'cancelled' : 'error');
      throw deadDropError;
    }
  }

  private satisfies(entry: ManagedTransport, requirements: TransportRequirements): boolean {
    if (requirements.only && !requirements.only.includes(entry.name)) return false;
    const caps = entry.capabilities;
    if (requirements.binaryPayloads && !caps.binaryPayloads) return false;
    if (
      requirements.minPayloadBytes !== undefined &&
      caps.maxPayloadBytes !== undefined &&
      caps.maxPayloadBytes < requirements.minPayloadBytes
    ) {
      return false;
    }
    if (requirements.ordering === 'global' && caps.ordering !== 'global') return false;
    if (requirements.ordering === 'partition' && caps.ordering === 'none') return false;
    return true;
  }

  private validatePolicy(): void {
    const names = new Set(this.managed.keys());
    for (const name of [this.policy.primary, ...(this.policy.fallback ?? [])]) {
      if (name !== undefined && !names.has(name)) {
        throw new DeadDropError(
          'CONFIG_INVALID',
          `transport policy references unknown transport "${name}"`,
          { details: { configured: [...names] } },
        );
      }
    }
  }
}

/**
 * Failing over only helps when the failure is about the transport. A malformed
 * payload or an unauthorised workspace fails the same way everywhere, and
 * retrying it on three backends just multiplies the noise.
 */
function isWorthFailingOver(error: DeadDropError): boolean {
  switch (error.code) {
    case 'BAD_REQUEST':
    case 'CANCELLED':
    case 'CONFIG_INVALID':
    case 'PAYLOAD_TOO_LARGE':
    case 'UNAUTHORIZED':
    case 'UNSUPPORTED':
      return false;
    default:
      return true;
  }
}
