/**
 * Workspace cryptography.
 *
 * Threat model (deliberately narrow, see docs/security-model.md):
 *   - Every peer in a workspace shares one 32-byte secret. Possession of that
 *     secret *is* workspace membership; there is no PKI and no per-peer identity.
 *   - The transport (GitHub, a synced folder, S3, ...) is treated as a hostile
 *     store: it sees ciphertext only, and cannot forge or tamper with a frame.
 *   - It CAN see message sizes, timing, and the transport keys the mailbox
 *     engine writes (workspace name, recipient peer name). That metadata is not
 *     protected.
 *   - A peer that leaves a workspace must trigger a key rotation; frames carry a
 *     key id so old and new keys can be accepted during the overlap.
 */

import { createHash, createSecretKey, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { DeadDropError } from './errors.js';

export const SECRET_BYTES = 32;
export const SECRET_PREFIX = 'ddk1_';
export const AEAD_ALGORITHM = 'aes-256-gcm';
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
const HKDF_INFO = 'dead-drop/v1/workspace-aead';

/** A secret plus everything derived from it. Cheap to keep around; never log it. */
export interface WorkspaceKey {
  /** Short, non-secret identifier: first 8 hex chars of SHA-256 over the derived key. */
  id: string;
  key: KeyObject;
}

/** Generates a fresh workspace secret in its printable form. */
export function generateWorkspaceSecret(): string {
  return SECRET_PREFIX + randomBytes(SECRET_BYTES).toString('base64url');
}

export function parseWorkspaceSecret(secret: string): Buffer {
  if (!secret.startsWith(SECRET_PREFIX)) {
    throw new DeadDropError(
      'CONFIG_INVALID',
      `workspace secret must start with "${SECRET_PREFIX}"`,
    );
  }
  let raw: Buffer;
  try {
    raw = Buffer.from(secret.slice(SECRET_PREFIX.length), 'base64url');
  } catch (cause) {
    throw new DeadDropError('CONFIG_INVALID', 'workspace secret is not valid base64url', { cause });
  }
  if (raw.length !== SECRET_BYTES) {
    throw new DeadDropError(
      'CONFIG_INVALID',
      `workspace secret must decode to ${SECRET_BYTES} bytes, got ${raw.length}`,
    );
  }
  return raw;
}

/**
 * Derives the AEAD key for a workspace. The workspace name is the HKDF salt, so
 * the same secret pasted into two differently-named workspaces yields unrelated
 * keys and frames cannot be replayed across them.
 */
export function deriveWorkspaceKey(secret: string, workspace: string): WorkspaceKey {
  const ikm = parseWorkspaceSecret(secret);
  const derived = Buffer.from(
    hkdfSync('sha256', ikm, Buffer.from(workspace, 'utf8'), Buffer.from(HKDF_INFO, 'utf8'), 32),
  );
  const id = createHash('sha256').update(derived).digest('hex').slice(0, 8);
  return { id, key: createSecretKey(derived) };
}

export interface SealResult {
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

/** AES-256-GCM encrypt. `aad` is authenticated but transmitted in the clear. */
export function seal(key: WorkspaceKey, plaintext: Uint8Array, aad: Uint8Array): SealResult {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AEAD_ALGORITHM, key.key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ciphertext, tag: cipher.getAuthTag() };
}

export function open(
  key: WorkspaceKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  aad: Uint8Array,
): Buffer {
  if (iv.length !== IV_BYTES) {
    throw new DeadDropError('DECRYPT_FAILED', `iv must be ${IV_BYTES} bytes`);
  }
  if (tag.length !== TAG_BYTES) {
    throw new DeadDropError('DECRYPT_FAILED', `auth tag must be ${TAG_BYTES} bytes`);
  }
  try {
    const decipher = createDecipheriv(AEAD_ALGORITHM, key.key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (cause) {
    throw new DeadDropError('DECRYPT_FAILED', 'frame failed authenticated decryption', { cause });
  }
}

/**
 * Holds the active key plus any keys still accepted during a rotation.
 * Sealing always uses the primary; opening tries the key id in the frame.
 */
export class KeyRing {
  readonly primary: WorkspaceKey;
  private readonly byId = new Map<string, WorkspaceKey>();

  constructor(primary: WorkspaceKey, previous: readonly WorkspaceKey[] = []) {
    this.primary = primary;
    this.byId.set(primary.id, primary);
    for (const key of previous) this.byId.set(key.id, key);
  }

  static fromSecrets(workspace: string, secrets: readonly string[]): KeyRing {
    const [first, ...rest] = secrets;
    if (first === undefined) {
      throw new DeadDropError('CONFIG_INVALID', 'at least one workspace secret is required');
    }
    return new KeyRing(
      deriveWorkspaceKey(first, workspace),
      rest.map((secret) => deriveWorkspaceKey(secret, workspace)),
    );
  }

  get(id: string): WorkspaceKey {
    const key = this.byId.get(id);
    if (!key) {
      throw new DeadDropError('DECRYPT_FAILED', `no workspace key matches key id ${id}`, {
        details: { keyId: id, known: [...this.byId.keys()] },
      });
    }
    return key;
  }

  get keyIds(): string[] {
    return [...this.byId.keys()];
  }
}

/** Constant-time comparison that tolerates differing lengths. */
export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
