/**
 * Transport conformance suite.
 *
 * Third-party adapter authors run this against their implementation to check it
 * satisfies the contract the mailbox engine relies on. Deliberately free of any
 * test framework: `transportConformanceCases()` returns plain
 * `{ name, run }` objects, so it works under vitest, node:test, jest or a bare
 * script. `registerConformanceTests` wires them into whatever `describe`/`it`
 * the caller already has.
 */

import { DeadDropError } from '../errors.js';

import type {
  NativeTransport,
  StoreTransport,
  Transport,
  TransportCapabilities,
} from '../types.js';

export interface ConformanceCase {
  name: string;
  run(): Promise<void>;
}

export interface ConformanceHarness {
  capabilities: TransportCapabilities;
  /** Creates a transport bound to a fresh, empty namespace. */
  create(): Promise<Transport>;
  /** Tears down whatever `create` allocated. Called after every case. */
  cleanup?(transport: Transport): Promise<void>;
  /**
   * Milliseconds to wait for eventual consistency before asserting. Backends
   * with read-after-write consistency leave this at 0.
   */
  settleMs?: number;
}

class AssertionFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConformanceAssertionFailed';
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionFailed(message);
}

function assertBytesEqual(actual: Uint8Array | undefined, expected: Uint8Array, label: string) {
  assert(actual !== undefined, `${label}: expected bytes, got undefined`);
  assert(
    actual.length === expected.length,
    `${label}: expected ${expected.length} bytes, got ${actual.length}`,
  );
  for (let i = 0; i < expected.length; i++) {
    assert(actual[i] === expected[i], `${label}: byte ${i} differs`);
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  });

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

export function transportConformanceCases(harness: ConformanceHarness): ConformanceCase[] {
  return harness.capabilities.kind === 'store' ? storeCases(harness) : nativeCases(harness);
}

function withTransport<T extends Transport>(
  harness: ConformanceHarness,
  body: (transport: T) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const transport = (await harness.create()) as T;
    try {
      await body(transport);
    } finally {
      await harness.cleanup?.(transport).catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  };
}

function storeCases(harness: ConformanceHarness): ConformanceCase[] {
  const settle = async (): Promise<void> => {
    if (harness.settleMs) await sleep(harness.settleMs);
  };
  const store = (body: (t: StoreTransport) => Promise<void>) =>
    withTransport<StoreTransport>(harness, body);
  const caps = harness.capabilities;

  const cases: ConformanceCase[] = [
    {
      name: 'declares kind "store"',
      run: store(async (t) => {
        assert(t.kind === 'store', 'transport.kind must be "store"');
      }),
    },
    {
      name: 'put then get returns the exact bytes',
      run: store(async (t) => {
        const data = bytes('hello ddrop');
        const result = await t.put('inbox/peer-a/one.ddf', data);
        assert(result.key === 'inbox/peer-a/one.ddf', 'put must echo the key it wrote');
        await settle();
        assertBytesEqual(await t.get('inbox/peer-a/one.ddf'), data, 'round trip');
      }),
    },
    {
      name: 'get returns undefined for a missing key rather than throwing',
      run: store(async (t) => {
        assert((await t.get('inbox/peer-a/missing.ddf')) === undefined, 'expected undefined');
      }),
    },
    {
      name: 'handles an empty object',
      run: store(async (t) => {
        await t.put('inbox/peer-a/empty.ddf', new Uint8Array(0));
        await settle();
        const got = await t.get('inbox/peer-a/empty.ddf');
        assert(got !== undefined && got.length === 0, 'expected a zero-length object, not absence');
      }),
    },
    {
      name: 'overwrites an existing key',
      run: store(async (t) => {
        await t.put('inbox/peer-a/x.ddf', bytes('first'));
        await settle();
        await t.put('inbox/peer-a/x.ddf', bytes('second'));
        await settle();
        assertBytesEqual(await t.get('inbox/peer-a/x.ddf'), bytes('second'), 'overwrite');
      }),
    },
    {
      name: 'delete removes the object and is idempotent',
      run: store(async (t) => {
        await t.put('inbox/peer-a/gone.ddf', bytes('bye'));
        await settle();
        await t.delete('inbox/peer-a/gone.ddf');
        await settle();
        assert((await t.get('inbox/peer-a/gone.ddf')) === undefined, 'object should be gone');
        await t.delete('inbox/peer-a/gone.ddf');
        await t.delete('inbox/peer-a/never-existed.ddf');
      }),
    },
    {
      name: 'list returns objects under a prefix and nothing outside it',
      run: store(async (t) => {
        await t.put('inbox/peer-a/1.ddf', bytes('a'));
        await t.put('inbox/peer-a/2.ddf', bytes('bb'));
        await t.put('inbox/peer-b/3.ddf', bytes('ccc'));
        await settle();

        const listed = await collect(t, 'inbox/peer-a');
        assert(listed.length === 2, `expected 2 entries under inbox/peer-a, got ${listed.length}`);
        const keys = listed.map((entry) => entry.key).sort();
        assert(keys[0] === 'inbox/peer-a/1.ddf', `unexpected key ${keys[0]}`);
        assert(keys[1] === 'inbox/peer-a/2.ddf', `unexpected key ${keys[1]}`);
        const sizes = new Map(listed.map((entry) => [entry.key, entry.size]));
        assert(sizes.get('inbox/peer-a/1.ddf') === 1, 'entry size must be the object size');
        assert(sizes.get('inbox/peer-a/2.ddf') === 2, 'entry size must be the object size');
      }),
    },
    {
      name: 'list of an empty prefix returns no entries',
      run: store(async (t) => {
        const listed = await collect(t, 'inbox/nobody');
        assert(listed.length === 0, `expected no entries, got ${listed.length}`);
      }),
    },
    {
      name: 'list does not treat a prefix as a substring match',
      run: store(async (t) => {
        await t.put('inbox/peer-a/1.ddf', bytes('a'));
        await t.put('inbox/peer-abc/1.ddf', bytes('b'));
        await settle();
        const listed = await collect(t, 'inbox/peer-a');
        assert(
          listed.every((entry) => entry.key.startsWith('inbox/peer-a/')),
          'prefix must match on path boundaries, not raw string prefix',
        );
      }),
    },
    {
      name: 'paginates with a cursor and eventually terminates',
      run: store(async (t) => {
        for (let i = 0; i < 7; i++) {
          await t.put(`inbox/peer-a/${String(i).padStart(2, '0')}.ddf`, bytes(`m${i}`));
        }
        await settle();
        const seen = new Set<string>();
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = await t.list('inbox/peer-a', cursor ? { limit: 3, cursor } : { limit: 3 });
          assert(page.entries.length <= 3, 'list must respect the limit');
          for (const entry of page.entries) seen.add(entry.key);
          cursor = page.cursor;
          assert(++pages < 20, 'pagination did not terminate');
        } while (cursor);
        assert(seen.size === 7, `expected 7 unique keys across pages, got ${seen.size}`);
      }),
    },
    {
      name: 'health reports a known status',
      run: store(async (t) => {
        const health = await t.health();
        assert(
          ['healthy', 'degraded', 'unavailable'].includes(health.status),
          `unexpected status ${health.status}`,
        );
      }),
    },
    {
      name: 'close is idempotent',
      run: store(async (t) => {
        await t.close();
        await t.close();
      }),
    },
    {
      name: 'rejects keys that escape the namespace',
      run: store(async (t) => {
        for (const key of ['../escape', 'a//b', '/absolute', 'a/../b', '']) {
          let threw = false;
          try {
            await t.put(key, bytes('x'));
          } catch (error) {
            threw = true;
            assert(
              DeadDropError.is(error),
              `put(${JSON.stringify(key)}) must reject with a DeadDropError`,
            );
          }
          assert(threw, `put(${JSON.stringify(key)}) should have been rejected`);
        }
      }),
    },
    {
      name: 'concurrent puts to distinct keys all land',
      run: store(async (t) => {
        await Promise.all(
          Array.from({ length: 16 }, (_, i) =>
            t.put(`inbox/peer-a/c${String(i).padStart(2, '0')}.ddf`, bytes(`payload-${i}`)),
          ),
        );
        await settle();
        const listed = await collect(t, 'inbox/peer-a');
        assert(listed.length === 16, `expected 16 objects, got ${listed.length}`);
      }),
    },
    {
      name: 'ifAbsent refuses to overwrite',
      run: store(async (t) => {
        await t.put('inbox/peer-a/claim', bytes('first'), { ifAbsent: true });
        await settle();
        let threw = false;
        try {
          await t.put('inbox/peer-a/claim', bytes('second'), { ifAbsent: true });
        } catch (error) {
          threw = true;
          assert(DeadDropError.is(error), 'ifAbsent conflict must reject with a DeadDropError');
        }
        assert(threw, 'ifAbsent must reject when the key already exists');
        assertBytesEqual(await t.get('inbox/peer-a/claim'), bytes('first'), 'original preserved');
      }),
    },
  ];

  if (caps.binaryPayloads) {
    cases.push({
      name: 'survives every byte value',
      run: store(async (t) => {
        const data = new Uint8Array(256);
        for (let i = 0; i < 256; i++) data[i] = i;
        await t.put('inbox/peer-a/binary.ddf', data);
        await settle();
        assertBytesEqual(await t.get('inbox/peer-a/binary.ddf'), data, 'binary round trip');
      }),
    });
  }

  if (caps.orderedList) {
    cases.push({
      name: 'list returns entries in lexicographic key order',
      run: store(async (t) => {
        const keys = ['inbox/peer-a/c', 'inbox/peer-a/a', 'inbox/peer-a/b'];
        for (const key of keys) await t.put(key, bytes(key));
        await settle();
        const listed = (await collect(t, 'inbox/peer-a')).map((entry) => entry.key);
        const sorted = [...listed].sort();
        assert(
          listed.join(',') === sorted.join(','),
          `orderedList is claimed but list returned ${listed.join(',')}`,
        );
      }),
    });
  }

  if (caps.maxPayloadBytes === undefined || caps.maxPayloadBytes >= 1024 * 1024) {
    cases.push({
      name: 'round-trips a one megabyte object',
      run: store(async (t) => {
        const data = new Uint8Array(1024 * 1024);
        for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 0xff;
        await t.put('inbox/peer-a/big.ddf', data);
        await settle();
        assertBytesEqual(await t.get('inbox/peer-a/big.ddf'), data, 'large round trip');
      }),
    });
  }

  if (caps.watch) {
    cases.push({
      name: 'watch fires on a new object and stops after unsubscribe',
      run: store(async (t) => {
        assert(typeof t.watch === 'function', 'capabilities.watch is true but watch is missing');
        let fired = 0;
        const stop = await t.watch('inbox/peer-a', () => {
          fired += 1;
        });
        await t.put('inbox/peer-a/watched.ddf', bytes('ping'));
        // Generous: a transport may legitimately notify through a poll rather
        // than a push, and this suite runs on loaded CI machines.
        for (let i = 0; i < 120 && fired === 0; i++) await sleep(50);
        assert(fired > 0, 'watch handler was never called within 6s');

        await stop();
        const after = fired;
        await t.put('inbox/peer-a/watched2.ddf', bytes('ping'));
        await sleep(300);
        assert(fired === after, 'watch handler fired after unsubscribe');
      }),
    });
  }

  return cases;
}

function nativeCases(harness: ConformanceHarness): ConformanceCase[] {
  const native = (body: (t: NativeTransport) => Promise<void>) =>
    withTransport<NativeTransport>(harness, body);

  return [
    {
      name: 'declares kind "native"',
      run: native(async (t) => {
        assert(t.kind === 'native', 'transport.kind must be "native"');
      }),
    },
    {
      name: 'delivers a sent frame to a subscriber',
      run: native(async (t) => {
        const received: Uint8Array[] = [];
        const stop = await t.subscribe(async (message) => {
          received.push(message.frame);
        });
        const frame = bytes('frame-1');
        await t.send('peer-b', frame);
        for (let i = 0; i < 100 && received.length === 0; i++) await sleep(20);
        assert(received.length > 0, 'subscriber never received the frame');
        assertBytesEqual(received[0], frame, 'delivered frame');
        await stop();
      }),
    },
    {
      name: 'stops delivering after unsubscribe',
      run: native(async (t) => {
        let count = 0;
        const stop = await t.subscribe(async () => {
          count += 1;
        });
        await stop();
        await t.send('peer-b', bytes('after-unsubscribe'));
        await sleep(100);
        assert(count === 0, 'subscriber received a frame after unsubscribing');
      }),
    },
    {
      name: 'health reports a known status',
      run: native(async (t) => {
        const health = await t.health();
        assert(
          ['healthy', 'degraded', 'unavailable'].includes(health.status),
          `unexpected status ${health.status}`,
        );
      }),
    },
    {
      name: 'close is idempotent',
      run: native(async (t) => {
        await t.close();
        await t.close();
      }),
    },
  ];
}

async function collect(
  transport: StoreTransport,
  prefix: string,
): Promise<Array<{ key: string; size: number }>> {
  const entries: Array<{ key: string; size: number }> = [];
  let cursor: string | undefined;
  let guard = 0;
  do {
    const page: { entries: Array<{ key: string; size: number }>; cursor?: string } = cursor
      ? await transport.list(prefix, { cursor })
      : await transport.list(prefix);
    entries.push(...page.entries);
    cursor = page.cursor;
    if (++guard > 100) throw new AssertionFailed('list pagination did not terminate');
  } while (cursor);
  return entries;
}

/** Minimal shape of a test framework's `describe`/`it`. */
export interface TestFramework {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => Promise<void>): void;
}

/**
 * Registers the conformance suite with any test framework.
 *
 * ```ts
 * import { describe, it } from 'vitest';
 * registerConformanceTests({ describe, it }, 'acme', harness);
 * ```
 */
export function registerConformanceTests(
  framework: TestFramework,
  suiteName: string,
  harness: ConformanceHarness,
): void {
  framework.describe(`${suiteName} transport conformance`, () => {
    for (const testCase of transportConformanceCases(harness)) {
      framework.it(testCase.name, testCase.run);
    }
  });
}
