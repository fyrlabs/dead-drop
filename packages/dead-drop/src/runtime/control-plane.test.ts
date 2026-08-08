import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { afterAll, describe, expect, it } from 'vitest';

import { defaultSocketPath } from './control-plane.js';

const isWindows = process.platform === 'win32';
const created: string[] = [];

afterAll(async () => {
  for (const path of created) await rm(path, { recursive: true, force: true });
});

/** A directory nested past the 104-byte `sun_path` limit, as `ddrop init` can produce. */
async function deepDataDir(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'deaddrop-deep-'));
  created.push(base);
  return join(base, 'a'.repeat(60), 'b'.repeat(60), '.deaddrop');
}

describe('defaultSocketPath', () => {
  it.skipIf(isWindows)('keeps the socket inside the data directory when it fits', () => {
    const dataDir = join(tmpdir(), 'dd-short');
    expect(defaultSocketPath(dataDir)).toBe(join(dataDir, 'deaddrop.sock'));
  });

  it.skipIf(isWindows)('falls back to a short path when the natural one is too long', async () => {
    const dataDir = await deepDataDir();
    const natural = join(dataDir, 'deaddrop.sock');
    expect(Buffer.byteLength(natural)).toBeGreaterThan(104);

    const resolved = defaultSocketPath(dataDir);
    expect(resolved).not.toBe(natural);
    expect(Buffer.byteLength(resolved)).toBeLessThanOrEqual(104);
    expect(resolved.startsWith(tmpdir())).toBe(true);
  });

  it.skipIf(isWindows)('binds on a data directory past the limit', async () => {
    // The actual regression: `ddrop start` died with `listen EINVAL: invalid
    // argument` here, naming neither the cause nor a fix.
    const socketPath = defaultSocketPath(await deepDataDir());
    created.push(socketPath);

    const server = createServer();
    server.listen(socketPath);
    await once(server, 'listening');
    expect(server.address()).toBe(socketPath);

    server.close();
    await once(server, 'close');
  });

  it.skipIf(isWindows)('is deterministic, so the client and runtime agree', async () => {
    const dataDir = await deepDataDir();
    expect(defaultSocketPath(dataDir)).toBe(defaultSocketPath(dataDir));
  });

  it.skipIf(isWindows)('gives distinct data directories distinct sockets', async () => {
    const a = await deepDataDir();
    const b = await deepDataDir();
    expect(defaultSocketPath(a)).not.toBe(defaultSocketPath(b));
  });

  it.runIf(isWindows)('uses a named pipe on Windows, regardless of depth', async () => {
    const dataDir = await deepDataDir();
    expect(defaultSocketPath(dataDir).startsWith('\\\\.\\pipe\\deaddrop-')).toBe(true);
    expect(defaultSocketPath(dataDir)).toBe(defaultSocketPath(dataDir));
  });
});
