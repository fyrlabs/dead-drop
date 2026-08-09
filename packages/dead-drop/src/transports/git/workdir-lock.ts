/**
 * Ownership of a git working directory.
 *
 * A git working tree has exactly one writer. Two processes sharing one clone
 * interleave `reset --hard` with each other's commits, and dead-drop reaches
 * that state by ordinary use: `ddrop connect` builds its runtime from the same
 * config file as the peer already running, so it inherits the same `workDir`.
 *
 * This is an advisory lock, held for the life of the store rather than around
 * each push, so it can never wedge the write path. It answers one question --
 * is somebody already using this directory -- and the caller decides what to do
 * about it.
 *
 * The lock file lives *beside* the directory it guards, never inside it. A
 * working tree is not a place to keep bookkeeping: `git add --all` would commit
 * the file into the data branch, and the next clone to check that branch out
 * would fail because the untracked local copy is in the way.
 */

import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface OwnerRecord {
  pid: number;
  since: number;
}

export interface DirLock {
  /** Directory this lock covers. */
  dir: string;
  release(): Promise<void>;
}

/** The bookkeeping file for `dir`, alongside it rather than within. */
export function lockPathFor(dir: string): string {
  return `${dir}.owner`;
}

/** True when a process with this id exists. Signal 0 checks without signalling. */
function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to somebody else, which still counts.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readOwner(path: string): Promise<OwnerRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as OwnerRecord;
    return typeof parsed?.pid === 'number' ? parsed : undefined;
  } catch {
    // Missing, truncated or hand-edited. Either way it names no live owner.
    return undefined;
  }
}

/**
 * Claims `dir`, creating it if needed.
 *
 * Returns undefined when a live process already holds it. A lock whose owner is
 * gone is reclaimed: the alternative is that one crash makes a directory
 * unusable until somebody deletes a file by hand.
 */
export async function takeDirLock(dir: string, now: () => number): Promise<DirLock | undefined> {
  await mkdir(dir, { recursive: true });
  const path = lockPathFor(dir);
  const record: OwnerRecord = { pid: process.pid, since: now() };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, JSON.stringify(record), { flag: 'wx' });
      return { dir, release: () => releaseIfOurs(path) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = await readOwner(path);
      // Our own pid counts as taken: a second store in this process needs its
      // own tree just as much as a second process does.
      if (owner && isRunning(owner.pid)) return undefined;
      await unlink(path).catch(() => undefined);
    }
  }
  return undefined;
}

async function releaseIfOurs(path: string): Promise<void> {
  const owner = await readOwner(path);
  if (owner && owner.pid !== process.pid) return;
  await unlink(path).catch(() => undefined);
}

/** True when nothing live holds `dir`. Used to decide whether it can be reused. */
export async function isDirLockFree(dir: string): Promise<boolean> {
  const owner = await readOwner(lockPathFor(dir));
  return !owner || !isRunning(owner.pid);
}

/**
 * Removes abandoned sibling clones under `parent`, skipping `keep`.
 *
 * Every directory here belongs to a runtime that holds its lock for as long as
 * it runs, so an unlocked one is by definition finished with. Without this,
 * every `ddrop connect` would leave a clone behind for good.
 */
export async function sweepAbandoned(
  parent: string,
  keep: string,
  entries: string[],
): Promise<string[]> {
  const removed: string[] = [];
  for (const name of entries) {
    if (name.endsWith('.owner')) continue;
    const dir = join(parent, name);
    if (dir === keep) continue;
    if (!(await isDirLockFree(dir))) continue;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await rm(lockPathFor(dir), { force: true }).catch(() => undefined);
    removed.push(name);
  }
  return removed;
}
