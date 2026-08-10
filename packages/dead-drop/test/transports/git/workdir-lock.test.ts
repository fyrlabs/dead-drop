/**
 * Working-directory ownership tests.
 *
 * These use real files and real process ids. A dead pid is produced by picking
 * one that cannot be running rather than by mocking, so the liveness check is
 * genuinely exercised.
 */

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isDirLockFree,
  lockPathFor,
  sweepAbandoned,
  takeDirLock,
} from '#dead-drop/transports/git/workdir-lock.js';

const dirs: string[] = [];
const now = (): number => 1;

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'deaddrop-lock-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('working directory ownership', () => {
  it('keeps its bookkeeping outside the directory it guards', async () => {
    const root = await temp();
    const dir = join(root, 'clone');
    const lock = await takeDirLock(dir, now);

    expect(lock).toBeDefined();
    // Anything left inside would be committed into the data branch by `add --all`.
    expect(await readdir(dir)).toEqual([]);
    expect(lockPathFor(dir)).toBe(`${dir}.owner`);
  });

  it('refuses a directory a live process already holds, and frees it on release', async () => {
    const root = await temp();
    const dir = join(root, 'clone');

    const first = await takeDirLock(dir, now);
    expect(first).toBeDefined();
    // Our own pid counts: a second store in this process needs its own tree too.
    expect(await takeDirLock(dir, now)).toBeUndefined();
    expect(await isDirLockFree(dir)).toBe(false);

    await first?.release();
    expect(await isDirLockFree(dir)).toBe(true);
    expect(await takeDirLock(dir, now)).toBeDefined();
  });

  it('reclaims a directory whose owner is gone', async () => {
    const root = await temp();
    const dir = join(root, 'clone');
    await mkdir(dir, { recursive: true });
    // A crash leaves the file behind. Requiring a human to delete it would make
    // one hard kill enough to wedge the transport for good.
    await writeFile(lockPathFor(dir), JSON.stringify({ pid: 0x7fffffff, since: 0 }));

    expect(await isDirLockFree(dir)).toBe(true);
    expect(await takeDirLock(dir, now)).toBeDefined();
  });

  it('reclaims a directory whose lock file is unreadable', async () => {
    const root = await temp();
    const dir = join(root, 'clone');
    await mkdir(dir, { recursive: true });
    await writeFile(lockPathFor(dir), 'not json');

    expect(await takeDirLock(dir, now)).toBeDefined();
  });

  it('sweeps abandoned clones but leaves live ones and the current one alone', async () => {
    const parent = await temp();
    const mine = join(parent, 'mine');
    const live = join(parent, 'live');
    const dead = join(parent, 'dead');

    await takeDirLock(mine, now);
    await takeDirLock(live, now);
    await mkdir(dead, { recursive: true });
    await writeFile(lockPathFor(dead), JSON.stringify({ pid: 0x7fffffff, since: 0 }));

    const removed = await sweepAbandoned(parent, mine, await readdir(parent));

    expect(removed).toEqual(['dead']);
    const left = (await readdir(parent)).filter((name) => !name.endsWith('.owner'));
    expect(left.sort()).toEqual(['live', 'mine']);
    // The stale bookkeeping goes with the directory it described.
    expect(await readdir(parent)).not.toContain('dead.owner');
  });
});
