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

import { createPublicKey, randomBytes } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
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
 * Write to a temp file, then `link()` it onto the target, rather than a
 * check-then-write or a `flag: 'wx'` write. Two runtimes can start against one
 * data directory and the loser of that race must adopt the winner's key rather
 * than overwrite it: overwriting would silently orphan every era key already
 * wrapped for the old one. `link` gives that the same `EEXIST` a `wx` write
 * does, and unlike `wx` it publishes a file that is already complete.
 *
 * A `wx` write creates the file and fills it in two steps, so the loser could
 * see the winner's entry between them and read zero bytes, which `read` below
 * refuses as corrupt. That shipped in 0.13.0, and it failed 18 of 150 rounds of
 * four simultaneous first starts on macOS: not a rare flake between processes,
 * however hard it is to hit inside one. `rename` would be wrong here: it
 * replaces the winner instead of losing to it.
 *
 * The temp write keeps `wx` only so a name collision cannot be silent; the
 * random suffix means it never fires.
 *
 * A filesystem without hard links (FAT, exFAT) fails here where the old write
 * would have worked. That is accepted rather than handled: such a volume cannot
 * hold the 0600 this file needs either.
 */
export async function loadOrCreateIdentity(path: string): Promise<PeerIdentity> {
  const existing = await read(path);
  if (existing) return existing;

  const identity = generateIdentity();
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temp, exportPrivateKey(identity.privateKey), { flag: 'wx', mode: 0o600 });
    await link(temp, path);
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
  } finally {
    // The link made a second name for the same inode; this drops the first one.
    // If the process dies before this runs the temp file is inert: nothing reads
    // the data directory by pattern, and the next start writes its own.
    await unlink(temp).catch(() => undefined);
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
