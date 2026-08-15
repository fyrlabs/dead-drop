/**
 * Which peers a human has approved by fingerprint. [ADR 0007](../../../../docs/adr/0007-per-peer-key-wrapping.md), the `requireApproval` tier.
 *
 * This is the one place in dead-drop where trust comes from outside the system.
 * Every other check answers "does this carry a proof under the workspace
 * secret", which is exactly the question a transport that has somehow obtained
 * the secret would also pass. A fingerprint read aloud over a phone call does
 * not go through the transport at all, so it is the only check that survives an
 * enrollment the store itself performed.
 *
 * The file records the fingerprint that was approved rather than a bare "yes",
 * so a peer that later republishes a *different* public key under the same name
 * stops being approved instead of inheriting the decision. That is the whole
 * attack this tier exists to stop: a store operator waiting for a workspace to
 * settle and then replacing one identity object.
 *
 * Not secret, unlike the identity and era files beside it, and mode 0600 anyway
 * for consistency rather than for need: knowing a fingerprint grants nothing.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { DeadDropError } from '../protocol/index.js';
import type { Logger } from '../core/index.js';

/** Peer id to the fingerprint approved for it. */
export type Approvals = Map<string, string>;

export async function loadApprovals(path: string, logger?: Logger): Promise<Approvals> {
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw new DeadDropError('INTERNAL', `could not read approvals at ${path}`, { cause: error });
  }
  try {
    const body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('not an object');
    }
    const approvals: Approvals = new Map();
    for (const [peerId, fingerprint] of Object.entries(body)) {
      // A malformed entry is dropped rather than defaulted to approved. Under
      // this tier the safe reading of "I cannot tell what this says" is that
      // nobody approved anything.
      if (typeof fingerprint === 'string' && fingerprint.length > 0) {
        approvals.set(peerId, fingerprint);
      }
    }
    return approvals;
  } catch (error) {
    logger?.warn('approvals file will not parse; treating every peer as unapproved', {
      path,
      error: String(error),
    });
    return new Map();
  }
}

export async function saveApprovals(path: string, approvals: Approvals): Promise<void> {
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  await writeFile(path, JSON.stringify(Object.fromEntries(approvals), null, 2), { mode: 0o600 });
}
