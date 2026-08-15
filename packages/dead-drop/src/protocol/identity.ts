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
const WRAP_PROOF_INFO = 'dead-drop/v1/key-wrap-proof';
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
  return createHmac('sha256', proofKey(secret, workspace, ENROLLMENT_INFO))
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

/**
 * Derives a per-workspace HMAC key from the secret. Shared by every proof in
 * this file; a distinct `info` per proof keeps one from being replayed as
 * another, and the workspace as the salt is what separates two workspaces.
 */
function proofKey(secret: string, workspace: string, info: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      parseWorkspaceSecret(secret),
      Buffer.from(workspace, 'utf8'),
      Buffer.from(info, 'utf8'),
      32,
    ),
  );
}

/**
 * Proof that whoever published this wrapped era key holds the workspace secret.
 *
 * Wrapping needs nothing but the recipient's public key, and that key is
 * published in the clear on purpose, so without this anyone who can write to
 * the store can mint an era of their own and have a peer load it into its
 * `KeyRing`. `frame.ts` opens whichever key id a frame names and the sender in
 * an envelope header is only a field, so that is a working forgery: a request
 * that decodes cleanly and claims to come from any peer the attacker chooses.
 *
 * Before this existed every key in a ring came from `KeyRing.fromSecrets`, so
 * opening a frame at all proved its author held the secret. This is what keeps
 * that true now that keys also arrive from the store.
 *
 * What each field in the input actually does, established by mutation rather
 * than asserted: **only the recipient peer id is load-bearing**. Removing it
 * fails a named test, because it is what stops a valid proof being lifted onto
 * a wrap addressed to somebody else. Removing the workspace changes nothing,
 * for the same reason it changes nothing in `enrollmentProof`: the workspace is
 * already the HKDF salt, so the proof key differs regardless. Removing the
 * ciphertext changes nothing either, because tampering with it is caught by the
 * AEAD a moment later.
 *
 * The redundant fields are kept anyway, and this is the argument for keeping
 * them: they mean the proof stands on its own rather than leaning on the AEAD
 * layer underneath it, so a future change there cannot silently unbind it. Do
 * not delete one and conclude from a green suite that it was never needed.
 *
 * The three variable-length strings are null-separated and the variable-length
 * ciphertext goes last, so the input cannot be re-split into a different set of
 * fields. Everything between them is fixed width.
 */
export function wrapProof(
  secret: string,
  workspace: string,
  recipientPeerId: string,
  wrapped: Omit<WrappedKey, 'proof'>,
): Buffer {
  return createHmac('sha256', proofKey(secret, workspace, WRAP_PROOF_INFO))
    .update(Buffer.from(workspace, 'utf8'))
    .update(Buffer.from([0]))
    .update(Buffer.from(recipientPeerId, 'utf8'))
    .update(Buffer.from([0]))
    .update(Buffer.from(wrapped.eraId, 'ascii'))
    .update(Buffer.from([0]))
    .update(wrapped.ephemeralPublicKey)
    .update(wrapped.iv)
    .update(wrapped.tag)
    .update(wrapped.ciphertext)
    .digest();
}

export function verifyWrapProof(
  secret: string,
  workspace: string,
  recipientPeerId: string,
  wrapped: WrappedKey,
): boolean {
  return safeEqual(wrapProof(secret, workspace, recipientPeerId, wrapped), wrapped.proof);
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
  /** {@link wrapProof}: evidence the author holds the workspace secret. */
  proof: Buffer;
}

/** Who a wrapped key is for. The peer id is bound into the proof. */
export interface WrapRecipient {
  peerId: string;
  publicKey: Uint8Array;
}

/**
 * Wraps an era key to one recipient.
 *
 * An ephemeral sender keypair rather than the sender's own identity, so the
 * wrapped object does not reveal which peer produced it and a compromised
 * identity key cannot retroactively unwrap keys it never received.
 *
 * The workspace secret is required rather than optional: a wrap without a proof
 * is one a store operator could have written, and there is no legitimate caller
 * that wants to produce one. See {@link wrapProof}.
 */
export function wrapEraKey(
  era: WorkspaceKey,
  recipient: WrapRecipient,
  auth: { secret: string; workspace: string },
): WrappedKey {
  const ephemeral = generateKeyPairSync('x25519');
  const recipientKey = importPublicKey(recipient.publicKey);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientKey });
  const ephemeralPublicKey = exportPublicKey(ephemeral.publicKey);
  const wrappingKey = deriveWrappingKey(shared, ephemeralPublicKey, recipient.publicKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AEAD_ALGORITHM, wrappingKey, iv);
  cipher.setAAD(wrapAad(era.id, ephemeralPublicKey, recipient.publicKey));
  const ciphertext = Buffer.concat([cipher.update(era.key.export()), cipher.final()]);
  const body = {
    eraId: era.id,
    ephemeralPublicKey,
    iv,
    ciphertext,
    tag: cipher.getAuthTag(),
  };
  return { ...body, proof: wrapProof(auth.secret, auth.workspace, recipient.peerId, body) };
}

/**
 * Unwraps with this peer's private key. Returns the era key ready for `KeyRing.add`.
 *
 * The proof is checked first, against every secret the workspace is configured
 * with so a peer mid-secret-rotation still accepts keys wrapped under the
 * outgoing one. Verifying here rather than in the caller is deliberate: an
 * unproven wrap must never reach the ring, and a check the caller has to
 * remember is a check that a future caller will forget.
 */
export function unwrapEraKey(
  wrapped: WrappedKey,
  recipient: WrapRecipient & { privateKey: KeyObject },
  auth: { secrets: readonly string[]; workspace: string },
): WorkspaceKey {
  const proven = auth.secrets.some((secret) =>
    verifyWrapProof(secret, auth.workspace, recipient.peerId, wrapped),
  );
  if (!proven) {
    throw new DeadDropError(
      'DECRYPT_FAILED',
      `wrapped key for era ${wrapped.eraId} carries no valid enrollment proof`,
    );
  }
  const shared = diffieHellman({
    privateKey: recipient.privateKey,
    publicKey: importPublicKey(wrapped.ephemeralPublicKey),
  });
  const wrappingKey = deriveWrappingKey(shared, wrapped.ephemeralPublicKey, recipient.publicKey);
  let material: Buffer;
  try {
    const decipher = createDecipheriv(AEAD_ALGORITHM, wrappingKey, wrapped.iv);
    decipher.setAAD(wrapAad(wrapped.eraId, wrapped.ephemeralPublicKey, recipient.publicKey));
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
