import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DeadDropError,
  wrapEraKey,
  generateEraKey,
  generateWorkspaceSecret,
  unwrapEraKey,
} from '@fyrlabs/dead-drop/protocol';
import { loadOrCreateIdentity } from '#dead-drop/runtime/identity-store.js';

const isWindows = process.platform === 'win32';

const dirs: string[] = [];

async function workdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ddrop-identity-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadOrCreateIdentity', () => {
  it('creates an identity on first start and reuses it afterwards', async () => {
    const path = join(await workdir(), 'demo.identity');

    const first = await loadOrCreateIdentity(path);
    const second = await loadOrCreateIdentity(path);

    // Same key, established by using it rather than by comparing bytes: the
    // second load must unwrap what was wrapped to the first.
    const era = generateEraKey();
    const secret = generateWorkspaceSecret();
    const wrapped = wrapEraKey(
      era,
      { peerId: 'peer-a', publicKey: first.publicKey },
      { secret, workspace: 'demo' },
    );
    expect(
      unwrapEraKey(
        wrapped,
        { peerId: 'peer-a', publicKey: second.publicKey, privateKey: second.privateKey },
        { secrets: [secret], workspace: 'demo' },
      ).id,
    ).toBe(era.id);
    expect(second.publicKey).toEqual(first.publicKey);
  });

  // Windows has no POSIX mode bits: `writeFile({ mode })` and `chmod` do not
  // narrow permissions there, which is exactly the reasoning `control-plane.test.ts`
  // already carries for the socket file. Same skip, same reason.
  it.skipIf(isWindows)(
    'writes the private key 0600, because it is key material in a shared home directory',
    async () => {
      const path = join(await workdir(), 'demo.identity');
      await loadOrCreateIdentity(path);
      const mode = (await stat(path)).mode & 0o777;
      expect(mode).toBe(0o600);
    },
  );

  it('creates the data directory when it does not exist yet', async () => {
    const path = join(await workdir(), 'nested', 'deeper', 'demo.identity');
    const identity = await loadOrCreateIdentity(path);
    expect(identity.publicKey).toHaveLength(32);
    await expect(readFile(path)).resolves.toBeInstanceOf(Buffer);
  });

  it('gives each workspace its own identity, so two stores cannot be correlated', async () => {
    const dir = await workdir();
    const a = await loadOrCreateIdentity(join(dir, 'alpha.identity'));
    const b = await loadOrCreateIdentity(join(dir, 'beta.identity'));
    expect(a.publicKey).not.toEqual(b.publicKey);
  });

  it('refuses a corrupt identity rather than generating a replacement', async () => {
    // Replacing it would orphan every era key already wrapped for the old public
    // key, and the peer would look enrolled while decoding nothing at all. This
    // has to be loud.
    const path = join(await workdir(), 'demo.identity');
    await writeFile(path, Buffer.from('not a key at all'));
    await expect(loadOrCreateIdentity(path)).rejects.toThrow(DeadDropError);
  });

  it('adopts the winner of a concurrent first start instead of overwriting it', async () => {
    // Two runtimes can start against one data directory. The loser must take the
    // winner's key: overwriting would silently orphan whatever had already been
    // wrapped for it.
    const path = join(await workdir(), 'demo.identity');
    const results = await Promise.all([
      loadOrCreateIdentity(path),
      loadOrCreateIdentity(path),
      loadOrCreateIdentity(path),
    ]);
    const onDisk = await loadOrCreateIdentity(path);
    for (const result of results) {
      expect(result.publicKey).toEqual(onDisk.publicKey);
    }
  });

  it('leaves no temp file beside the identity, whether it won the race or lost it', async () => {
    // The identity is published by linking a temp file onto the target, so the
    // data directory would collect one `.tmp` per start if the unlink were
    // dropped. Both outcomes are covered: three concurrent starts means one
    // writer links its temp and two lose on EEXIST.
    const dir = await workdir();
    await Promise.all([
      loadOrCreateIdentity(join(dir, 'demo.identity')),
      loadOrCreateIdentity(join(dir, 'demo.identity')),
      loadOrCreateIdentity(join(dir, 'demo.identity')),
    ]);
    expect(await readdir(dir)).toEqual(['demo.identity']);
  });
});
