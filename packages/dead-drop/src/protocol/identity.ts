/**
 * Per-peer identity and key wrapping. See [ADR 0007](../../../../docs/adr/0007-per-peer-key-wrapping.md).
 *
 * The workspace secret stops being the key that seals frames and becomes proof
 * of invite. Each peer holds an X25519 keypair; the symmetric key a frame is
 * actually sealed under (an "era" key) is wrapped to each peer's public key and
 * published as its own object, so admitting a peer no longer means handing over
 * the key to everything already written.
 *
 * Nothing here touches the frame format. `frame.ts` already carries a key id in
 * the clear and `KeyRing` already opens by that id, so an era key is just another
 * key the ring holds.
 *
 * X25519 rather than Ed25519 because wrapping is a Diffie-Hellman and Ed25519
 * cannot do DH. Node provides both, so this adds no dependency.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  createSecretKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import {
  AEAD_ALGORITHM,
  IV_BYTES,
  parseWorkspaceSecret,
  safeEqual,
  type WorkspaceKey,
} from './crypto.js';
import { DeadDropError } from './errors.js';

/** Raw X25519 keys are always 32 bytes. */
export const PUBLIC_KEY_BYTES = 32;
const ENROLLMENT_INFO = 'dead-drop/v1/enrollment';
const WRAP_INFO = 'dead-drop/v1/key-wrap';
const ERA_KEY_BYTES = 32;

export interface PeerIdentity {
  /** Raw 32-byte X25519 public key. Not secret. */
  publicKey: Buffer;
  privateKey: KeyObject;
}

/** Generates a fresh peer identity. The private half must never be logged. */
export function generateIdentity(): PeerIdentity {
  const pair = generateKeyPairSync('x25519');
  return { publicKey: exportPublicKey(pair.publicKey), privateKey: pair.privateKey };
}

/**
 * Raw 32 bytes rather than DER, so a published identity object stays small and
 * its format does not depend on how Node chooses to encode a key today.
 */
export function exportPublicKey(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' }) as { x?: string };
  if (typeof jwk.x !== 'string') {
    throw new DeadDropError('INTERNAL', 'x25519 public key did not export an x coordinate');
  }
  return Buffer.from(jwk.x, 'base64url');
}

export function importPublicKey(raw: Uint8Array): KeyObject {
  if (raw.length !== PUBLIC_KEY_BYTES) {
    throw new DeadDropError(
      'DECODE_FAILED',
      `x25519 public key must be ${PUBLIC_KEY_BYTES} bytes, got ${raw.length}`,
    );
  }
  try {
    return createPublicKey({
      key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(raw).toString('base64url') },
      format: 'jwk',
    });
  } catch (cause) {
    throw new DeadDropError('DECODE_FAILED', 'x25519 public key is not a valid point', { cause });
  }
}

/** PKCS#8 DER, which is what `.deaddrop/identity` holds. Mode 0600, never logged. */
export function exportPrivateKey(key: KeyObject): Buffer {
  return key.export({ type: 'pkcs8', format: 'der' }) as Buffer;
}

export function importPrivateKey(der: Uint8Array): KeyObject {
  try {
    return createPrivateKey({ key: Buffer.from(der), type: 'pkcs8', format: 'der' });
  } catch (cause) {
    throw new DeadDropError('CONFIG_INVALID', 'stored identity is not a valid x25519 private key', {
      cause,
    });
  }
}

/**
 * A short, non-secret string a human can read over the phone. This is what the
 * opt-in approval tier compares, so it must be stable for a given public key and
 * must not be derivable into the key it names.
 */
export function fingerprint(publicKey: Uint8Array): string {
  const digest = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
  return (digest.match(/.{4}/g) ?? []).join('-');
}

/**
 * Proof that whoever published this identity holds the workspace secret.
 *
 * The peer id and workspace name are bound in so a proof cannot be lifted from
 * one workspace, or from one peer's identity object, and replayed on another.
 * Anyone with the secret can mint one at any time with nobody else online, which
 * is the property that keeps joining a single command.
 *
 * The workspace is bound twice: as the HKDF salt and again in the HMAC input.
 * The salt is what actually separates two workspaces, established by mutation:
 * removing the null separators below does not let a proof cross workspaces,
 * because the derived key already differs. The separators are kept anyway
 * because they cost nothing and they are what would keep the encoding
 * unambiguous if a variable-length field were ever appended after `peerId`.
 * Today the trailing field is a fixed 32-byte key, so the split is unambiguous
 * without them; do not add a variable-length field and assume that still holds.
 */
export function enrollmentProof(
  secret: string,
  workspace: string,
  peerId: string,
  publicKey: Uint8Array,
): Buffer {
  const ikm = parseWorkspaceSecret(secret);
  const proofKey = Buffer.from(
    hkdfSync(
      'sha256',
      ikm,
      Buffer.from(workspace, 'utf8'),
      Buffer.from(ENROLLMENT_INFO, 'utf8'),
      32,
    ),
  );
  return createHmac('sha256', proofKey)
    .update(Buffer.from(workspace, 'utf8'))
    .update(Buffer.from([0]))
    .update(Buffer.from(peerId, 'utf8'))
    .update(Buffer.from([0]))
    .update(Buffer.from(publicKey))
    .digest();
}

/** Constant-time proof check. A failure means "not a member", never "try again". */
export function verifyEnrollmentProof(
  secret: string,
  workspace: string,
  peerId: string,
  publicKey: Uint8Array,
  proof: Uint8Array,
): boolean {
  return safeEqual(enrollmentProof(secret, workspace, peerId, publicKey), proof);
}

/** Mints a fresh era key. Its id follows the existing scheme so frames are unchanged. */
export function generateEraKey(): WorkspaceKey {
  const raw = randomBytes(ERA_KEY_BYTES);
  return eraKeyFrom(raw);
}

export function eraKeyFrom(raw: Uint8Array): WorkspaceKey {
  if (raw.length !== ERA_KEY_BYTES) {
    throw new DeadDropError(
      'DECODE_FAILED',
      `era key must be ${ERA_KEY_BYTES} bytes, got ${raw.length}`,
    );
  }
  const material = Buffer.from(raw);
  const id = createHash('sha256').update(material).digest('hex').slice(0, 8);
  return { id, key: createSecretKey(material) };
}

export interface WrappedKey {
  /** Id of the era key inside, so a reader knows what it is getting before unwrapping. */
  eraId: string;
  /** Ephemeral public key the shared secret was derived against. */
  ephemeralPublicKey: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

/**
 * Wraps an era key to one recipient.
 *
 * An ephemeral sender keypair rather than the sender's own identity, so the
 * wrapped object does not reveal which peer produced it and a compromised
 * identity key cannot retroactively unwrap keys it never received.
 */
export function wrapEraKey(era: WorkspaceKey, recipientPublicKey: Uint8Array): WrappedKey {
  const ephemeral = generateKeyPairSync('x25519');
  const recipient = importPublicKey(recipientPublicKey);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const ephemeralPublicKey = exportPublicKey(ephemeral.publicKey);
  const wrappingKey = deriveWrappingKey(shared, ephemeralPublicKey, recipientPublicKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AEAD_ALGORITHM, wrappingKey, iv);
  cipher.setAAD(wrapAad(era.id, ephemeralPublicKey, recipientPublicKey));
  const ciphertext = Buffer.concat([cipher.update(era.key.export()), cipher.final()]);
  return { eraId: era.id, ephemeralPublicKey, iv, ciphertext, tag: cipher.getAuthTag() };
}

/** Unwraps with this peer's private key. Returns the era key ready for `KeyRing.add`. */
export function unwrapEraKey(
  wrapped: WrappedKey,
  ownPublicKey: Uint8Array,
  ownPrivateKey: KeyObject,
): WorkspaceKey {
  const shared = diffieHellman({
    privateKey: ownPrivateKey,
    publicKey: importPublicKey(wrapped.ephemeralPublicKey),
  });
  const wrappingKey = deriveWrappingKey(shared, wrapped.ephemeralPublicKey, ownPublicKey);
  let material: Buffer;
  try {
    const decipher = createDecipheriv(AEAD_ALGORITHM, wrappingKey, wrapped.iv);
    decipher.setAAD(wrapAad(wrapped.eraId, wrapped.ephemeralPublicKey, ownPublicKey));
    decipher.setAuthTag(wrapped.tag);
    material = Buffer.concat([decipher.update(wrapped.ciphertext), decipher.final()]);
  } catch (cause) {
    throw new DeadDropError('DECRYPT_FAILED', 'wrapped key failed authenticated decryption', {
      cause,
    });
  }
  const era = eraKeyFrom(material);
  // The id is derived from the material, so a wrapper that lied about which era
  // it was handing over is caught here rather than surfacing later as a frame
  // that will not open under the id it claims.
  if (era.id !== wrapped.eraId) {
    throw new DeadDropError(
      'DECRYPT_FAILED',
      `wrapped key claims era ${wrapped.eraId} but contains ${era.id}`,
    );
  }
  return era;
}

/**
 * Binds both public keys into the derivation, so a wrapped object cannot be
 * redirected at a different recipient.
 *
 * The recipient key is bound twice, here and in `wrapAad`, and **either binding
 * alone is sufficient**. That is established by mutation, not assumed: removing
 * it from this salt keeps every test passing, removing it from the AAD keeps
 * every test passing, and removing it from both fails the redirect test. So
 * neither is individually load-bearing, and a future edit that drops one is
 * safe while an edit that drops both is not. Do not "simplify" by deleting one
 * and conclude from a green suite that the other was the only one that mattered.
 */
function deriveWrappingKey(
  shared: Buffer,
  ephemeralPublicKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): KeyObject {
  const salt = Buffer.concat([Buffer.from(ephemeralPublicKey), Buffer.from(recipientPublicKey)]);
  return createSecretKey(
    Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from(WRAP_INFO, 'utf8'), 32)),
  );
}

function wrapAad(
  eraId: string,
  ephemeralPublicKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): Buffer {
  return Buffer.concat([
    Buffer.from(eraId, 'ascii'),
    Buffer.from(ephemeralPublicKey),
    Buffer.from(recipientPublicKey),
  ]);
}
