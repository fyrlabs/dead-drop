import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { registerConformanceTests } from '@fyrlabs/dead-drop-transport-sdk/testing';
import type { StoreTransport, TransportContext } from '@fyrlabs/dead-drop-transport-sdk';

import { directoryExists, filesystemTransport } from '#dead-drop/transports/filesystem/index.js';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'deaddrop-fs-'));
  roots.push(root);
  return root;
}

function context(overrides: Partial<TransportContext> = {}): TransportContext {
  return {
    workspace: 'demo',
    peerId: 'peer-a',
    instance: 'filesystem',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    now: () => Date.now(),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

registerConformanceTests({ describe, it }, 'filesystem', {
  capabilities: filesystemTransport.definition.capabilities,
  async create() {
    return filesystemTransport.definition.create({ root: await makeRoot() }, context());
  },
});

describe('filesystem transport specifics', () => {
  async function store(
    config: Partial<Parameters<typeof filesystemTransport>[0]> = {},
  ): Promise<{ transport: StoreTransport; root: string }> {
    const root = await makeRoot();
    const transport = (await filesystemTransport.definition.create(
      { root, ...config },
      context(),
    )) as StoreTransport;
    return { transport, root };
  }

  it('creates the root directory lazily', async () => {
    const root = join(await makeRoot(), 'nested', 'deeper');
    expect(await directoryExists(root)).toBe(false);
    const transport = filesystemTransport.definition.create({ root }, context()) as StoreTransport;
    await transport.put('inbox/peer-b/1.ddf', new Uint8Array([1]));
    expect(await directoryExists(root)).toBe(true);
  });

  it('writes objects as real files under the root', async () => {
    const { transport, root } = await store();
    await transport.put('inbox/peer-b/1.ddf', new Uint8Array([1, 2, 3]));
    const onDisk = await readFile(join(root, 'inbox', 'peer-b', '1.ddf'));
    expect([...onDisk]).toEqual([1, 2, 3]);
  });

  it('leaves no temp files behind after a write', async () => {
    const { transport } = await store();
    await transport.put('inbox/peer-b/1.ddf', new Uint8Array([1]));
    const listed = await transport.list('inbox/peer-b');
    expect(listed.entries.map((entry) => entry.key)).toEqual(['inbox/peer-b/1.ddf']);
  });

  it('ignores in-flight temp files and dotfiles when listing', async () => {
    const { transport, root } = await store();
    await transport.put('inbox/peer-b/1.ddf', new Uint8Array([1]));
    await writeFile(join(root, 'inbox', 'peer-b', 'half.ddf.abc123.tmp'), 'partial');
    await writeFile(join(root, 'inbox', 'peer-b', '.DS_Store'), 'junk');
    const listed = await transport.list('inbox/peer-b');
    expect(listed.entries.map((entry) => entry.key)).toEqual(['inbox/peer-b/1.ddf']);
  });

  it('lists nested keys recursively', async () => {
    const { transport } = await store();
    await transport.put('inbox/peer-b/a/1.ddf', new Uint8Array([1]));
    await transport.put('inbox/peer-b/b/2.ddf', new Uint8Array([2]));
    const listed = await transport.list('inbox/peer-b');
    expect(listed.entries.map((entry) => entry.key)).toEqual([
      'inbox/peer-b/a/1.ddf',
      'inbox/peer-b/b/2.ddf',
    ]);
  });

  it('refuses keys that would escape the root', async () => {
    const { transport } = await store();
    await expect(transport.put('../outside.ddf', new Uint8Array())).rejects.toThrowError(/invalid/);
    await expect(transport.get('/etc/passwd')).rejects.toThrowError(/invalid/);
  });

  it('reports healthy for a writable root and unavailable once closed', async () => {
    const { transport } = await store();
    const health = await transport.health();
    expect(health.status).toBe('healthy');
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    await transport.close();
    expect((await transport.health()).status).toBe('unavailable');
  });

  it('reports unavailable when the root cannot be created', async () => {
    const file = join(await makeRoot(), 'a-file');
    await writeFile(file, 'not a directory');
    const transport = filesystemTransport.definition.create(
      { root: join(file, 'nested') },
      context(),
    ) as StoreTransport;
    expect((await transport.health()).status).toBe('unavailable');
  });

  it('notifies watchers when a new object appears', async () => {
    const { transport } = await store({ forcePolling: true, pollIntervalMs: 50 });
    let fired = 0;
    const stop = await transport.watch('inbox/peer-b', () => {
      fired += 1;
    });
    await transport.put('inbox/peer-b/1.ddf', new Uint8Array([1]));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fired).toBeGreaterThan(0);
    await stop();
  });

  it('validates configuration', () => {
    expect(() => filesystemTransport({ root: '' })).toThrowError(/requires "root"/);
    expect(() => filesystemTransport('nope' as never)).toThrowError(/must be an object/);
    expect(() => filesystemTransport({ root: '/tmp/x', pollIntervalMs: 10 })).toThrowError(
      /at least 50/,
    );
  });

  it('rejects construction without a root', () => {
    expect(() => filesystemTransport.definition.create({ root: '' }, context())).toThrowError(
      /root directory/,
    );
  });
});
