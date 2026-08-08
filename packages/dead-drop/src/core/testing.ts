/**
 * Test doubles shared across core, runtime and end-to-end suites.
 *
 * Not exported from the package entry point: this is build-time-only support
 * code, and shipping it would invite production use of `FaultyStore`.
 */

import { DeadDropError } from '../protocol/index.js';
import {
  defineTransport,
  type StoreTransport,
  type TransportHealth,
} from '@fyrlabs/dead-drop-transport-sdk';
import type { TransportContext, TransportRegistration } from '@fyrlabs/dead-drop-transport-sdk';

import { TestClock } from './clock.js';
import { MemoryLogSink, createLogger, type Logger } from './observability/logger.js';

export interface TestHarness {
  clock: TestClock;
  logs: MemoryLogSink;
  logger: Logger;
}

export function harness(start = 0): TestHarness {
  const clock = new TestClock(start);
  const logs = new MemoryLogSink();
  return { clock, logs, logger: createLogger({ level: 'debug', sink: logs.sink, clock }) };
}

export function testContext(overrides: Partial<TransportContext> = {}): TransportContext {
  return {
    workspace: 'demo',
    peerId: 'peer-a',
    instance: 'test',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    now: () => Date.now(),
    ...overrides,
  };
}

export interface FaultyStoreConfig {
  /** Backing map. Share it between instances to simulate one backend. */
  objects?: Map<string, Uint8Array>;
  /** Operations that should fail until `healAfter` calls have been made. */
  failOperations?: Array<'put' | 'get' | 'list' | 'delete'>;
  /** Number of failures to emit before recovering. `Infinity` never recovers. */
  failCount?: number;
  health?: TransportHealth;
  maxPayloadBytes?: number;
  /** Records every operation for assertions. */
  calls?: string[];
}

/**
 * A store whose failures are scripted. Used to exercise retry, breaker,
 * failover and dead-letter paths without waiting on a real backend.
 */
export class FaultyStore implements StoreTransport {
  readonly kind = 'store' as const;
  readonly objects: Map<string, Uint8Array>;
  private remainingFailures: number;
  private readonly failOperations: Set<string>;
  private readonly configuredHealth: TransportHealth;
  readonly calls: string[];

  constructor(private readonly config: FaultyStoreConfig = {}) {
    this.objects = config.objects ?? new Map();
    this.remainingFailures = config.failCount ?? 0;
    this.failOperations = new Set(config.failOperations ?? []);
    this.configuredHealth = config.health ?? { status: 'healthy', latencyMs: 1 };
    this.calls = config.calls ?? [];
  }

  private guard(operation: string): void {
    this.calls.push(operation);
    if (this.failOperations.has(operation) && this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new DeadDropError('TRANSPORT_ERROR', `scripted ${operation} failure`);
    }
  }

  async put(key: string, data: Uint8Array): Promise<{ key: string }> {
    this.guard('put');
    if (this.config.maxPayloadBytes !== undefined && data.length > this.config.maxPayloadBytes) {
      throw new DeadDropError('PAYLOAD_TOO_LARGE', `object exceeds ${this.config.maxPayloadBytes}`);
    }
    this.objects.set(key, Uint8Array.from(data));
    return { key };
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    this.guard('get');
    const found = this.objects.get(key);
    return found ? Uint8Array.from(found) : undefined;
  }

  async list(
    prefix: string,
    options: { limit?: number; startAfter?: string; cursor?: string } = {},
  ): Promise<{ entries: Array<{ key: string; size: number }>; cursor?: string }> {
    this.guard('list');
    const scope = prefix === '' ? '' : `${prefix}/`;
    const after = options.startAfter ?? options.cursor;
    const all = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(scope))
      .filter(([key]) => !after || key > after)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, value]) => ({ key, size: value.length }));
    const limit = options.limit ?? all.length;
    const page = all.slice(0, limit);
    return all.length > page.length && page.length > 0
      ? { entries: page, cursor: page[page.length - 1]!.key }
      : { entries: page };
  }

  async delete(key: string): Promise<void> {
    this.guard('delete');
    this.objects.delete(key);
  }

  async health(): Promise<TransportHealth> {
    return this.configuredHealth;
  }

  async close(): Promise<void> {}
}

/** Registers a `FaultyStore` as a named transport and hands back both. */
export function faultyTransport(
  name: string,
  config: FaultyStoreConfig = {},
  capabilities: Partial<Parameters<typeof defineTransport>[0]['capabilities']> = {},
): { registration: TransportRegistration<never>; store: FaultyStore } {
  const store = new FaultyStore(config);
  const factory = defineTransport<FaultyStoreConfig>({
    id: name,
    capabilities: {
      kind: 'store',
      ordering: 'partition',
      binaryPayloads: true,
      delete: true,
      watch: false,
      orderedList: true,
      ...(config.maxPayloadBytes !== undefined ? { maxPayloadBytes: config.maxPayloadBytes } : {}),
      ...capabilities,
    },
    create: () => store,
  });
  return { registration: factory(config) as unknown as TransportRegistration<never>, store };
}
