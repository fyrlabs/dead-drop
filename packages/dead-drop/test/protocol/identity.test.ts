import { describe, expect, it } from 'vitest';

import {
  DeadDropError,
  KeyRing,
  deriveWorkspaceKey,
  enrollmentProof,
  eraKeyFrom,
  exportPrivateKey,
  exportPublicKey,
  fingerprint,
  generateEraKey,
  generateIdentity,
  generateWorkspaceSecret,
  importPrivateKey,
  importPublicKey,
  unwrapEraKey,
  verifyEnrollmentProof,
  wrapEraKey,
  PUBLIC_KEY_BYTES,
} from '@fyrlabs/dead-drop/protocol';

const WORKSPACE = 'demo';

describe('peer identity', () => {
  it('generates a 32-byte public key and a private key that survives a round trip', () => {
    const identity = generateIdentity();
    expect(identity.publicKey).toHaveLength(PUBLIC_KEY_BYTES);

    const reloaded = importPrivateKey(exportPrivateKey(identity.privateKey));
    // Proof the reloaded private half is the same one: it unwraps a key wrapped
    // to the matching public key. Comparing exports would only prove encoding.
    const era = generateEraKey();
    const wrapped = wrapEraKey(era, identity.publicKey);
    expect(unwrapEraKey(wrapped, identity.publicKey, reloaded).id).toBe(era.id);
  });

  it('round-trips a public key through raw bytes', () => {
    const identity = generateIdentity();
    expect(exportPublicKey(importPublicKey(identity.publicKey))).toEqual(identity.publicKey);
  });

  it('refuses a public key of the wrong length', () => {
    expect(() => importPublicKey(Buffer.alloc(31))).toThrow(/must be 32 bytes/);
  });

  it('refuses stored private key material that is not a key', () => {
    expect(() => importPrivateKey(Buffer.from('not a key'))).toThrow(DeadDropError);
  });

  it('fingerprints stably, and differently for different keys', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    expect(fingerprint(a.publicKey)).toBe(fingerprint(a.publicKey));
    expect(fingerprint(a.publicKey)).not.toBe(fingerprint(b.publicKey));
    expect(fingerprint(a.publicKey)).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
  });
});

describe('enrollment proof', () => {
  it('verifies against the secret that minted it', () => {
    const secret = generateWorkspaceSecret();
    const identity = generateIdentity();
    const proof = enrollmentProof(secret, WORKSPACE, 'peer-a', identity.publicKey);
    expect(verifyEnrollmentProof(secret, WORKSPACE, 'peer-a', identity.publicKey, proof)).toBe(
      true,
    );
  });

  it('fails under a different secret, which is what stops a transport enrolling itself', () => {
    const identity = generateIdentity();
    const proof = enrollmentProof(
      generateWorkspaceSecret(),
      WORKSPACE,
      'peer-a',
      identity.publicKey,
    );
    const other = generateWorkspaceSecret();
    expect(verifyEnrollmentProof(other, WORKSPACE, 'peer-a', identity.publicKey, proof)).toBe(
      false,
    );
  });

  it('fails when the public key it covers is swapped', () => {
    const secret = generateWorkspaceSecret();
    const identity = generateIdentity();
    const attacker = generateIdentity();
    const proof = enrollmentProof(secret, WORKSPACE, 'peer-a', identity.publicKey);
    expect(verifyEnrollmentProof(secret, WORKSPACE, 'peer-a', attacker.publicKey, proof)).toBe(
      false,
    );
  });

  it('fails when lifted onto another peer id or another workspace', () => {
    const secret = generateWorkspaceSecret();
    const identity = generateIdentity();
    const proof = enrollmentProof(secret, WORKSPACE, 'peer-a', identity.publicKey);
    expect(verifyEnrollmentProof(secret, WORKSPACE, 'peer-b', identity.publicKey, proof)).toBe(
      false,
    );
    expect(verifyEnrollmentProof(secret, 'other', 'peer-a', identity.publicKey, proof)).toBe(false);
  });

  it('separates a shifted workspace and peer boundary, though the HKDF salt is what does it', () => {
    const secret = generateWorkspaceSecret();
    const identity = generateIdentity();
    const proof = enrollmentProof(secret, 'ab', 'c', identity.publicKey);
    expect(verifyEnrollmentProof(secret, 'a', 'bc', identity.publicKey, proof)).toBe(false);
    // Established by mutation, so it is not claimed loosely: deleting the null
    // separators from the HMAC input leaves this passing, because the workspace
    // is the HKDF salt and so the proof key already differs. This asserts the
    // property, not the mechanism, and the mechanism is documented at the source.
  });
});

describe('era keys', () => {
  it('derives an id from the material, so the same bytes give the same id', () => {
    const raw = Buffer.alloc(32, 7);
    expect(eraKeyFrom(raw).id).toBe(eraKeyFrom(raw).id);
    expect(generateEraKey().id).not.toBe(generateEraKey().id);
  });

  it('refuses material of the wrong length', () => {
    expect(() => eraKeyFrom(Buffer.alloc(16))).toThrow(/must be 32 bytes/);
  });
});

describe('key wrapping', () => {
  it('wraps to a recipient and back, preserving the era id', () => {
    const identity = generateIdentity();
    const era = generateEraKey();
    const wrapped = wrapEraKey(era, identity.publicKey);

    expect(wrapped.eraId).toBe(era.id);
    expect(wrapped.ephemeralPublicKey).toHaveLength(PUBLIC_KEY_BYTES);
    // The era material must not be readable from the wrapped object.
    expect(wrapped.ciphertext.equals(era.key.export())).toBe(false);

    const unwrapped = unwrapEraKey(wrapped, identity.publicKey, identity.privateKey);
    expect(unwrapped.id).toBe(era.id);
    expect(unwrapped.key.export()).toEqual(era.key.export());
  });

  it('cannot be unwrapped by a peer it was not wrapped for', () => {
    const target = generateIdentity();
    const other = generateIdentity();
    const wrapped = wrapEraKey(generateEraKey(), target.publicKey);
    expect(() => unwrapEraKey(wrapped, other.publicKey, other.privateKey)).toThrow(
      /failed authenticated decryption/,
    );
  });

  it('cannot be redirected at another recipient even by someone holding the right private key', () => {
    const target = generateIdentity();
    const other = generateIdentity();
    const wrapped = wrapEraKey(generateEraKey(), target.publicKey);
    // The Diffie-Hellman here succeeds, since the real private key is passed. What
    // refuses is the recipient key not matching the one the object was wrapped for.
    // That key is bound in two places, the KDF salt and the AAD, and mutation shows
    // either alone suffices: this fails only when both bindings are removed.
    expect(() => unwrapEraKey(wrapped, other.publicKey, target.privateKey)).toThrow(
      /failed authenticated decryption/,
    );
  });

  it('rejects a tampered ciphertext rather than yielding a wrong key', () => {
    const identity = generateIdentity();
    const wrapped = wrapEraKey(generateEraKey(), identity.publicKey);
    wrapped.ciphertext[0] ^= 0xff;
    expect(() => unwrapEraKey(wrapped, identity.publicKey, identity.privateKey)).toThrow(
      /failed authenticated decryption/,
    );
  });

  it('rejects an eraId edited after the fact, because the id is inside the AAD', () => {
    const identity = generateIdentity();
    const wrapped = wrapEraKey(generateEraKey(), identity.publicKey);
    const edited = { ...wrapped, eraId: 'deadbeef' };
    expect(() => unwrapEraKey(edited, identity.publicKey, identity.privateKey)).toThrow(
      /failed authenticated decryption/,
    );
  });

  it('rejects a consistent liar: a wrapper whose label and AAD agree but whose material does not', () => {
    const identity = generateIdentity();
    const era = generateEraKey();
    // Editing the object cannot produce this case, because the id is authenticated.
    // A malicious peer can, by sealing real material under a label of its choosing,
    // and the only thing that catches it is re-deriving the id from what came out.
    const mislabelled = wrapEraKey({ id: 'deadbeef', key: era.key }, identity.publicKey);
    expect(() => unwrapEraKey(mislabelled, identity.publicKey, identity.privateKey)).toThrow(
      /claims era deadbeef but contains/,
    );
  });

  it('produces a different object every time for the same inputs', () => {
    const identity = generateIdentity();
    const era = generateEraKey();
    const first = wrapEraKey(era, identity.publicKey);
    const second = wrapEraKey(era, identity.publicKey);
    expect(first.ephemeralPublicKey.equals(second.ephemeralPublicKey)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });
});

describe('KeyRing growth', () => {
  it('accepts an unwrapped era for opening without changing what seals', () => {
    const secret = generateWorkspaceSecret();
    const era0 = deriveWorkspaceKey(secret, WORKSPACE);
    const ring = new KeyRing(era0);
    const era1 = generateEraKey();

    expect(ring.has(era1.id)).toBe(false);
    ring.add(era1);

    expect(ring.has(era1.id)).toBe(true);
    expect(ring.get(era1.id).id).toBe(era1.id);
    // Adding must not change what new frames are sealed under; that is `promote`.
    expect(ring.primary.id).toBe(era0.id);
  });

  it('is idempotent, so re-reading the store costs nothing', () => {
    const ring = new KeyRing(generateEraKey());
    const era = generateEraKey();
    ring.add(era);
    ring.add(era);
    expect(ring.keyIds.filter((id) => id === era.id)).toHaveLength(1);
  });

  it('promotes a new era for sealing while keeping every old one readable', () => {
    const era0 = generateEraKey();
    const era1 = generateEraKey();
    const ring = new KeyRing(era0);
    ring.promote(era1);

    expect(ring.primary.id).toBe(era1.id);
    // A frame sealed under the old era may still be in an inbox, so it stays open.
    expect(ring.get(era0.id).id).toBe(era0.id);
  });

  it('still reports the ids it holds when asked for one it does not', () => {
    const ring = new KeyRing(generateEraKey());
    expect(() => ring.get('00000000')).toThrow(/no workspace key matches key id 00000000/);
  });
});
