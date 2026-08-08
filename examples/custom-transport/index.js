/**
 * A complete third-party transport in about 60 lines.
 *
 * This one stores objects in a Map. Swap the four methods for calls to your
 * backend and you have a working dead-drop transport; everything above them —
 * encryption, chunking, acknowledgement, retries, deduplication, failover —
 * is supplied by the runtime.
 *
 *   node examples/custom-transport/index.js
 */

import { DeadDropError } from '@fyrlabs/dead-drop/protocol';
import {
  assertValidKey,
  assertValidPrefix,
  defineTransport,
} from '@fyrlabs/dead-drop-transport-sdk';
import { transportConformanceCases } from '@fyrlabs/dead-drop-transport-sdk/testing';

export const acmeTransport = defineTransport({
  id: 'acme',
  capabilities: {
    kind: 'store',
    ordering: 'partition',
    binaryPayloads: true,
    delete: true,
    watch: false,
    orderedList: true,
  },
  create() {
    const objects = new Map();
    return {
      kind: 'store',

      async put(key, data, options = {}) {
        assertValidKey(key);
        if (options.ifAbsent && objects.has(key)) {
          throw new DeadDropError('TRANSPORT_ERROR', `object already exists: ${key}`, {
            retryable: false,
          });
        }
        objects.set(key, Uint8Array.from(data));
        return { key };
      },

      async get(key) {
        assertValidKey(key);
        const found = objects.get(key);
        return found ? Uint8Array.from(found) : undefined;
      },

      async list(prefix, options = {}) {
        assertValidPrefix(prefix);
        const scope = prefix === '' ? '' : `${prefix}/`;
        const after = options.startAfter ?? options.cursor;
        const all = [...objects.entries()]
          .filter(([key]) => key.startsWith(scope))
          .filter(([key]) => !after || key > after)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, value]) => ({ key, size: value.length }));
        const page = all.slice(0, options.limit ?? all.length);
        return all.length > page.length && page.length > 0
          ? { entries: page, cursor: page.at(-1).key }
          : { entries: page };
      },

      async delete(key) {
        assertValidKey(key);
        objects.delete(key);
      },

      async health() {
        return { status: 'healthy', latencyMs: 0 };
      },

      async close() {},
    };
  },
});

// Prove it satisfies the contract before shipping it.
const cases = transportConformanceCases({
  capabilities: acmeTransport.definition.capabilities,
  async create() {
    return acmeTransport.definition.create(
      {},
      {
        workspace: 'demo',
        peerId: 'peer-a',
        instance: 'acme',
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        signal: new AbortController().signal,
        now: () => Date.now(),
      },
    );
  },
});

let failed = 0;
for (const testCase of cases) {
  try {
    await testCase.run();
    console.log(`  ok   ${testCase.name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${testCase.name}: ${error.message}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} conformance cases passed`);
process.exitCode = failed === 0 ? 0 : 1;
