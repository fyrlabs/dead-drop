/**
 * Where the era a peer seals under is remembered across restarts. [ADR 0007](../../../../docs/adr/0007-per-peer-key-wrapping.md).
 *
 * Without this a restarted peer starts on the key derived from the workspace
 * secret and stays there until its first enrollment pass finishes, which is a
 * window in which every frame it writes is readable by exactly the peer the
 * last rotation removed. The pass is fire-and-forget on purpose, so the window
 * is real rather than theoretical, and it reopens on every restart.
 *
 * It also makes the rotation counter durable, which is what turns "refuses a
 * replayed pointer" from a property of one process into a property of the peer.
 * A store operator that keeps the pointer from before a rotation and writes it
 * back only has to wait for a restart otherwise.
 *
 * **This file holds symmetric key material, and that is not a new exposure.**
 * `<workspace>.identity` sits beside it and can unwrap every era ever wrapped
 * for this peer, past and future, so anything that can read one can already
 * obtain the other. Same directory, same 0600, same rule that neither is ever
 * logged or sent over the control socket. There is deliberately no config field
 * naming this path, for the reasons `identity-store.ts` sets out.
 *
 * A file that will not parse is discarded rather than fatal, which is the
 * opposite of how a corrupt identity is treated, and the asymmetry is the
 * point: an unreadable identity is unrecoverable, while an unreadable era costs
 * one enrollment pass to rebuild from the store.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { DeadDropError, eraKeyFrom, type WorkspaceKey } from '../protocol/index.js';
import type { Logger } from '../core/index.js';

export interface StoredEra {
  key: WorkspaceKey;
  /** Rotation counter of the pointer this era was adopted from. */
  seq: number;
}

export async function loadEra(path: string, logger?: Logger): Promise<StoredEra | undefined> {
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new DeadDropError('INTERNAL', `could not read the stored era at ${path}`, {
      cause: error,
    });
  }
  try {
    const body = JSON.parse(raw.toString('utf8')) as {
      eraId?: unknown;
      seq?: unknown;
      key?: unknown;
    };
    if (typeof body.key !== 'string' || typeof body.eraId !== 'string') {
      throw new Error('missing eraId or key');
    }
    if (typeof body.seq !== 'number' || !Number.isInteger(body.seq) || body.seq < 0) {
      throw new Error('seq is not a rotation counter');
    }
    const key = eraKeyFrom(Buffer.from(body.key, 'base64url'));
    // The id is derived from the material, so a file whose label and contents
    // disagree is a file to throw away, not one to trust either half of.
    if (key.id !== body.eraId) throw new Error(`labelled ${body.eraId} but holds ${key.id}`);
    return { key, seq: body.seq };
  } catch (error) {
    logger?.warn('discarding an unreadable stored era; it will be rebuilt from the store', {
      path,
      error: String(error),
    });
    return undefined;
  }
}

/** Writes the era atomically enough for a file this small: one write, no rename. */
export async function saveEra(path: string, era: StoredEra): Promise<void> {
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  await writeFile(
    path,
    JSON.stringify({
      eraId: era.key.id,
      seq: era.seq,
      key: era.key.key.export().toString('base64url'),
    }),
    { mode: 0o600 },
  );
}
