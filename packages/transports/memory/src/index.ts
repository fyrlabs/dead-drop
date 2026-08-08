/**
 * `@dead-drop/transport-memory` — an in-process object store.
 *
 * Two jobs: it is the transport the test suite and examples use to run a full
 * Bridge without touching a network or a disk, and it is the smallest possible
 * worked example of the store contract for adapter authors.
 *
 * Instances sharing the same `namespace` share one backing map, so two runtimes
 * in one process can talk to each other. Not for production: nothing survives a
 * restart and nothing crosses a process boundary.
 */

import { setTimeout as delay } from 'node:timers/promises';

import { BridgeError } from '@dead-drop/protocol';
import {
  assertValidKey,
  assertValidPrefix,
  defineTransport,
  type ListOptions,
  type ListResult,
  type ObjectEntry,
  type PutOptions,
  type PutResult,
  type StoreTransport,
  type TransportContext,
  type TransportHealth,
} from '@dead-drop/transport-sdk';

export interface MemoryTransportConfig {
  /**
   * Instances with the same namespace see the same objects. Defaults to
   * `'default'`, which is what makes two in-process runtimes able to talk.
   */
  namespace?: string;
  /** Injected delay per operation, used to exercise latency handling in tests. */
  latencyMs?: number;
  /**
   * Fails operations with probability 0..1 so failover paths can be tested.
   * Deterministic when `random` is supplied.
   */
  failureRate?: number;
  random?: () => number;
  /** Reported by `health()`. Lets tests simulate an unhealthy transport. */
  status?: 'healthy' | 'degraded' | 'unavailable';
}

interface StoredObject {
  data: Uint8Array;
  modifiedAt: number;
  etag: string;
}

const namespaces = new Map<string, Map<string, StoredObject>>();
const watchers = new Map<string, Set<{ prefix: string; onChange: () => void }>>();

/** Wipes every namespace. Test helper; never called by the runtime. */
export function resetMemoryTransports(): void {
  namespaces.clear();
  watchers.clear();
}

class MemoryStore implements StoreTransport {
  readonly kind = 'store' as const;
  private readonly objects: Map<string, StoredObject>;
  private readonly watcherSet: Set<{ prefix: string; onChange: () => void }>;
  private readonly config: Required<Pick<MemoryTransportConfig, 'namespace'>> &
    MemoryTransportConfig;
  private readonly context: TransportContext;
  private closed = false;
  private etagCounter = 0;
  private lastSuccessAt: number | undefined;

  constructor(config: MemoryTransportConfig, context: TransportContext) {
    const namespace = config.namespace ?? 'default';
    this.config = { ...config, namespace };
    this.context = context;

    let objects = namespaces.get(namespace);
    if (!objects) {
      objects = new Map();
      namespaces.set(namespace, objects);
    }
    this.objects = objects;

    let set = watchers.get(namespace);
    if (!set) {
      set = new Set();
      watchers.set(namespace, set);
    }
    this.watcherSet = set;
  }

  async put(key: string, data: Uint8Array, options: PutOptions = {}): Promise<PutResult> {
    assertValidKey(key);
    await this.simulate(options.signal);
    const existing = this.objects.get(key);
    if (options.ifAbsent && existing) {
      throw new BridgeError('TRANSPORT_ERROR', `object already exists: ${key}`, {
        details: { key },
        retryable: false,
      });
    }
    if (options.ifMatch !== undefined && existing?.etag !== options.ifMatch) {
      throw new BridgeError('TRANSPORT_ERROR', `etag mismatch for ${key}`, { retryable: false });
    }
    const etag = `m${++this.etagCounter}`;
    // Copy: callers reuse buffers, and a store must not alias them.
    this.objects.set(key, {
      data: Uint8Array.from(data),
      modifiedAt: this.context.now(),
      etag,
    });
    this.notify(key);
    return { key, etag };
  }

  async get(key: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array | undefined> {
    assertValidKey(key);
    await this.simulate(options.signal);
    const found = this.objects.get(key);
    return found ? Uint8Array.from(found.data) : undefined;
  }

  async list(prefix: string, options: ListOptions = {}): Promise<ListResult> {
    assertValidPrefix(prefix);
    await this.simulate(options.signal);
    const scope = prefix === '' ? '' : prefix.endsWith('/') ? prefix : `${prefix}/`;
    const matching: ObjectEntry[] = [];
    for (const [key, value] of this.objects) {
      if (!key.startsWith(scope)) continue;
      matching.push({
        key,
        size: value.data.length,
        modifiedAt: value.modifiedAt,
        etag: value.etag,
      });
    }
    matching.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const start = options.cursor ? matching.findIndex((entry) => entry.key > options.cursor!) : 0;
    const from = start < 0 ? matching.length : start;
    const limit = options.limit ?? matching.length;
    const page = matching.slice(from, from + limit);
    const more = from + page.length < matching.length;
    const result: ListResult = { entries: page };
    if (more && page.length > 0) result.cursor = page[page.length - 1]!.key;
    return result;
  }

  async delete(key: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    assertValidKey(key);
    await this.simulate(options.signal);
    this.objects.delete(key);
  }

  async watch(prefix: string, onChange: () => void): Promise<() => Promise<void>> {
    assertValidPrefix(prefix);
    const entry = {
      prefix: prefix.endsWith('/') || prefix === '' ? prefix : `${prefix}/`,
      onChange,
    };
    this.watcherSet.add(entry);
    return async () => {
      this.watcherSet.delete(entry);
    };
  }

  async health(): Promise<TransportHealth> {
    const health: TransportHealth = {
      status: this.closed ? 'unavailable' : (this.config.status ?? 'healthy'),
      latencyMs: this.config.latencyMs ?? 0,
    };
    if (this.lastSuccessAt !== undefined) health.lastSuccessAt = this.lastSuccessAt;
    if (this.closed) health.message = 'transport is closed';
    return health;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private notify(key: string): void {
    for (const watcher of this.watcherSet) {
      if (key.startsWith(watcher.prefix)) {
        // Detach so a throwing handler cannot break the writer.
        queueMicrotask(() => {
          try {
            watcher.onChange();
          } catch (error) {
            this.context.logger.warn('memory transport watcher threw', {
              error: String(error),
            });
          }
        });
      }
    }
  }

  private async simulate(signal?: AbortSignal): Promise<void> {
    if (this.closed) {
      throw new BridgeError('TRANSPORT_ERROR', 'memory transport is closed');
    }
    if (signal?.aborted || this.context.signal.aborted) {
      throw new BridgeError('CANCELLED', 'operation aborted');
    }
    const latency = this.config.latencyMs ?? 0;
    if (latency > 0) await delay(latency);
    const failureRate = this.config.failureRate ?? 0;
    if (failureRate > 0) {
      const random = this.config.random ?? Math.random;
      if (random() < failureRate) {
        throw new BridgeError('TRANSPORT_ERROR', 'simulated memory transport failure');
      }
    }
    this.lastSuccessAt = this.context.now();
  }
}

export const memoryTransport = defineTransport<MemoryTransportConfig>({
  id: 'memory',
  capabilities: {
    kind: 'store',
    ordering: 'partition',
    binaryPayloads: true,
    delete: true,
    watch: true,
    orderedList: true,
    expectedLatencyMs: 0,
  },
  parseConfig(raw) {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BridgeError('CONFIG_INVALID', 'memory transport config must be an object');
    }
    const config = raw as MemoryTransportConfig;
    if (config.namespace !== undefined && typeof config.namespace !== 'string') {
      throw new BridgeError('CONFIG_INVALID', 'memory transport namespace must be a string');
    }
    return config;
  },
  create(config, context) {
    return new MemoryStore(config, context);
  },
});

export default memoryTransport;
