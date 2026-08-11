/**
 * Where a peer's X25519 identity lives on disk. [ADR 0007](../../../../docs/adr/0007-per-peer-key-wrapping.md).
 *
 * There is deliberately no configuration for this. The identity is generated on
 * first start, kept beside the workspace's other state as
 * `<dataDir>/<workspace>.identity` in the same shape as `<workspace>.dedupe.json`,
 * and never mentioned to the user unless something is wrong with it. A setting
 * here would be a way to get key material wrong in exchange for nothing: nobody
 * needs to choose where it goes, and onboarding must stay a single command.
 *
 * One identity per workspace rather than one per machine. Reusing a key across
 * workspaces would be safe against replay, because the enrollment proof binds
 * the workspace name, but it would let anyone who can read two stores see that
 * the same machine is in both. Per workspace costs nothing and does not.
 *
 * The private half is never logged, never sent over the control socket, and
 * never leaves this file except as a `KeyObject`.
 */

import { createPublicKey } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  DeadDropError,
  exportPrivateKey,
  exportPublicKey,
  generateIdentity,
  importPrivateKey,
  type PeerIdentity,
} from '../protocol/index.js';

/**
 * Loads the identity at `path`, creating it if this is the first start.
 *
 * `flag: 'wx'` plus a re-read on `EEXIST` rather than a check-then-write,
 * because two runtimes can start against one data directory and the loser of
 * that race must adopt the winner's key rather than overwrite it. Overwriting
 * would silently orphan every era key already wrapped for the old one.
 */
export async function loadOrCreateIdentity(path: string): Promise<PeerIdentity> {
  const existing = await read(path);
  if (existing) return existing;

  const identity = generateIdentity();
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  try {
    await writeFile(path, exportPrivateKey(identity.privateKey), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new DeadDropError('INTERNAL', `could not write the peer identity at ${path}`, {
        cause: error,
      });
    }
    const raced = await read(path);
    if (!raced) {
      throw new DeadDropError('INTERNAL', `peer identity at ${path} vanished while being created`);
    }
    return raced;
  }
  return identity;
}

async function read(path: string): Promise<PeerIdentity | undefined> {
  let der: Buffer;
  try {
    der = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new DeadDropError('INTERNAL', `could not read the peer identity at ${path}`, {
      cause: error,
    });
  }
  // A truncated or corrupt file is not something to recover from by generating a
  // replacement: every era key already wrapped for the old public key would
  // become unreadable, and the peer would look enrolled while decoding nothing.
  // Failing loudly with the path is the only honest option.
  const privateKey = importPrivateKey(der);
  return { publicKey: exportPublicKey(createPublicKey(privateKey)), privateKey };
}
