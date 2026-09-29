import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { generateWorkspaceSecret } from '#dead-drop/protocol/index.js';
import { parseRuntimeConfig } from '#dead-drop/runtime/config.js';
import { DeadDropRuntime } from '#dead-drop/runtime/runtime.js';

/**
 * Real runtimes over one filesystem store, on the real clock. What is under
 * test is how requests, responses and services share handler slots, and that
 * only shows up when actual peers wait on each other.
 */
describe('handler lanes', () => {
  const runtimes: DeadDropRuntime[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function peers(names: string[], concurrency: number) {
    const root = await mkdtemp(join(tmpdir(), 'lanes-'));
    roots.push(root);
    const secret = generateWorkspaceSecret();
    const workspaces = [];
    for (const peerId of names) {
      const runtime = new DeadDropRuntime({
        config: parseRuntimeConfig({
          dataDir: join(root, peerId),
          logLevel: 'silent',
          workspaces: [
            {
              name: 'w',
              peerId,
              secrets: [secret],
              concurrency,
              transports: [{ use: 'filesystem', config: { root: join(root, 'store') } }],
              polling: { minIntervalMs: 20, maxIntervalMs: 100 },
            },
          ],
        }),
      });
      await runtime.start();
      runtimes.push(runtime);
      workspaces.push(runtime.defaultWorkspace());
    }
    return workspaces;
  }

  it('lets a handler call another peer at the default concurrency', async () => {
    // A request handler that awaits a call needs the response delivered while
    // its own slot is still held. When responses shared the handler slots this
    // always timed out at concurrency 1.
    const [a, b, c] = await peers(['a', 'b', 'c'], 1);
    c!.service('leaf', { v1: () => 'leaf' });
    b!.service('mid', { v1: () => b!.call('c', 'leaf.v1', {}, { timeoutMs: 3000 }) });

    expect(await a!.call('b', 'mid.v1', {}, { timeoutMs: 8000 })).toBe('leaf');
  });

  it('keeps one service from starving another when it declares its own lane', async () => {
    const [a, b] = await peers(['a', 'b'], 1);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    b!.service('slow', { v1: () => held.then(() => 'slow') }, { concurrency: 1 });
    b!.service('fast', { v1: () => 'fast' });

    const slow = a!.call('b', 'slow.v1', {}, { timeoutMs: 8000 });
    // The slow call is now running in its lane; a second slow call queues behind
    // it, and neither may stop the other service from answering.
    const queued = a!.call('b', 'slow.v1', {}, { timeoutMs: 8000 });
    expect(await a!.call('b', 'fast.v1', {}, { timeoutMs: 3000 })).toBe('fast');

    release();
    expect(await slow).toBe('slow');
    expect(await queued).toBe('slow');
  });
});
