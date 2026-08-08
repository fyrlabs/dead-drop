import { afterEach, describe, expect, it } from 'vitest';

import { DeadDropError } from '../../protocol/index.js';
import { registerConformanceTests } from '@fyrlabs/dead-drop-transport-sdk/testing';
import type { StoreTransport, TransportContext } from '@fyrlabs/dead-drop-transport-sdk';

import { memoryTransport, resetMemoryTransports } from './index.js';

let namespaceCounter = 0;

export function testContext(overrides: Partial<TransportContext> = {}): TransportContext {
  return {
    workspace: 'demo',
    peerId: 'peer-a',
    instance: 'memory',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    now: () => Date.now(),
    ...overrides,
  };
}

afterEach(() => {
  resetMemoryTransports();
});

registerConformanceTests({ describe, it }, 'memory', {
  capabilities: memoryTransport.definition.capabilities,
  async create() {
    // Each case gets its own namespace so shared module state cannot leak.
    return memoryTransport.definition.create(
      { namespace: `conformance-${++namespaceCounter}` },
      testContext(),
    );
  },
});

describe('memory transport specifics', () => {
  const create = (config: Parameters<typeof memoryTransport>[0] = {}): StoreTransport =>
    memoryTransport.definition.create(
      { namespace: `unit-${++namespaceCounter}`, ...config },
      testContext(),
    ) as StoreTransport;

  it('shares objects between instances in the same namespace', async () => {
    const namespace = `shared-${++namespaceCounter}`;
    const a = memoryTransport.definition.create({ namespace }, testContext()) as StoreTransport;
    const b = memoryTransport.definition.create({ namespace }, testContext()) as StoreTransport;
    await a.put('inbox/peer-b/1.ddf', new Uint8Array([7]));
    expect(await b.get('inbox/peer-b/1.ddf')).toEqual(new Uint8Array([7]));
  });

  it('isolates different namespaces', async () => {
    const a = create();
    const b = create();
    await a.put('inbox/peer-b/1.ddf', new Uint8Array([7]));
    expect(await b.get('inbox/peer-b/1.ddf')).toBeUndefined();
  });

  it('copies data in and out so callers cannot mutate stored objects', async () => {
    const store = create();
    const data = new Uint8Array([1, 2, 3]);
    await store.put('inbox/peer-b/1.ddf', data);
    data[0] = 99;
    const read = await store.get('inbox/peer-b/1.ddf');
    expect(read?.[0]).toBe(1);
    read![1] = 99;
    expect((await store.get('inbox/peer-b/1.ddf'))?.[1]).toBe(2);
  });

  it('honours ifMatch', async () => {
    const store = create();
    const first = await store.put('inbox/peer-b/1.ddf', new Uint8Array([1]));
    await expect(
      store.put('inbox/peer-b/1.ddf', new Uint8Array([2]), { ifMatch: 'wrong' }),
    ).rejects.toBeInstanceOf(DeadDropError);
    await expect(
      store.put('inbox/peer-b/1.ddf', new Uint8Array([2]), { ifMatch: first.etag }),
    ).resolves.toBeDefined();
  });

  it('simulates failures deterministically', async () => {
    const store = memoryTransport.definition.create(
      { namespace: `fail-${++namespaceCounter}`, failureRate: 1, random: () => 0 },
      testContext(),
    ) as StoreTransport;
    await expect(store.put('inbox/peer-b/1.ddf', new Uint8Array())).rejects.toThrowError(
      /simulated/,
    );
  });

  it('reports a configured status and goes unavailable once closed', async () => {
    const store = memoryTransport.definition.create(
      { namespace: `health-${++namespaceCounter}`, status: 'degraded' },
      testContext(),
    ) as StoreTransport;
    expect((await store.health()).status).toBe('degraded');
    await store.close();
    expect((await store.health()).status).toBe('unavailable');
    await expect(store.get('inbox/peer-b/1.ddf')).rejects.toThrowError(/closed/);
  });

  it('aborts when the runtime signal is aborted', async () => {
    const controller = new AbortController();
    const store = memoryTransport.definition.create(
      { namespace: `abort-${++namespaceCounter}` },
      testContext({ signal: controller.signal }),
    ) as StoreTransport;
    controller.abort();
    await expect(store.put('inbox/peer-b/1.ddf', new Uint8Array())).rejects.toMatchObject({
      code: 'CANCELLED',
    });
  });

  it('validates its configuration', () => {
    expect(() => memoryTransport({ namespace: 5 as unknown as string })).toThrowError(
      /must be a string/,
    );
    expect(memoryTransport(undefined as never).config).toEqual({});
    expect(memoryTransport({}, { name: 'memory-2' }).name).toBe('memory-2');
    expect(() => memoryTransport({}, { name: 'Bad Name' })).toThrowError(/instance name/);
  });
});
