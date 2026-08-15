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
  wrapProof,
  PUBLIC_KEY_BYTES,
  type WrappedKey,
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
    const secret = generateWorkspaceSecret();
    const recipient = { peerId: 'peer-a', publicKey: identity.publicKey };
    const wrapped = wrapEraKey(era, recipient, { secret, workspace: WORKSPACE });
    expect(
      unwrapEraKey(
        wrapped,
        { ...recipient, privateKey: reloaded },
        { secrets: [secret], workspace: WORKSPACE },
      ).id,
    ).toBe(era.id);
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
  const SECRET = generateWorkspaceSecret();
  const AUTH = { secret: SECRET, workspace: WORKSPACE };
  const SECRETS = { secrets: [SECRET], workspace: WORKSPACE };

  /**
   * Re-mints the proof over an object after it has been edited.
   *
   * Every AEAD binding below is now shadowed by the proof, which covers the same
   * bytes and is checked first, so tampering with a wrapped object without this
   * only ever demonstrates that the proof works. Re-proofing makes each test say
   * what it is really about: a *member*, who can mint proofs at will, still
   * cannot tamper with or redirect a wrapped key.
   */
  const reproof = (wrapped: WrappedKey, peerId: string): WrappedKey => ({
    ...wrapped,
    proof: wrapProof(SECRET, WORKSPACE, peerId, wrapped),
  });

  it('wraps to a recipient and back, preserving the era id', () => {
    const identity = generateIdentity();
    const era = generateEraKey();
    const wrapped = wrapEraKey(era, { peerId: 'peer-a', publicKey: identity.publicKey }, AUTH);

    expect(wrapped.eraId).toBe(era.id);
    expect(wrapped.ephemeralPublicKey).toHaveLength(PUBLIC_KEY_BYTES);
    // The era material must not be readable from the wrapped object.
    expect(wrapped.ciphertext.equals(era.key.export())).toBe(false);

    const unwrapped = unwrapEraKey(wrapped, { peerId: 'peer-a', ...identity }, SECRETS);
    expect(unwrapped.id).toBe(era.id);
    expect(unwrapped.key.export()).toEqual(era.key.export());
  });

  it('refuses a wrap nobody with the workspace secret authorised', () => {
    // The forgery this closes: wrapping needs only the recipient's public key,
    // which is published in the clear, so without a proof whoever controls the
    // store can put an era of its own into a peer's KeyRing and then seal frames
    // under it that the peer will open and attribute to any sender it names.
    const identity = generateIdentity();
    const wrapped = wrapEraKey(
      generateEraKey(),
      { peerId: 'peer-a', publicKey: identity.publicKey },
      { secret: generateWorkspaceSecret(), workspace: WORKSPACE },
    );
    expect(() => unwrapEraKey(wrapped, { peerId: 'peer-a', ...identity }, SECRETS)).toThrow(
      /no valid enrollment proof/,
    );
  });

  it('accepts a wrap proven under any configured secret, so a secret rotation does not deafen a peer', () => {
    const identity = generateIdentity();
    const outgoing = generateWorkspaceSecret();
    const era = generateEraKey();
    const wrapped = wrapEraKey(
      era,
      { peerId: 'peer-a', publicKey: identity.publicKey },
      { secret: outgoing, workspace: WORKSPACE },
    );
    expect(
      unwrapEraKey(
        wrapped,
        { peerId: 'peer-a', ...identity },
        { secrets: [SECRET, outgoing], workspace: WORKSPACE },
      ).id,
    ).toBe(era.id);
  });

  // The recipient half of this is the one binding in `wrapProof` that mutation
  // shows to be load-bearing; the workspace half holds because the workspace is
  // the HKDF salt, not because it is in the HMAC input. See the source.
  it('refuses a proof lifted onto another recipient or another workspace', () => {
    const identity = generateIdentity();
    const wrapped = wrapEraKey(
      generateEraKey(),
      { peerId: 'peer-a', publicKey: identity.publicKey },
      AUTH,
    );
    expect(() => unwrapEraKey(wrapped, { peerId: 'peer-b', ...identity }, SECRETS)).toThrow(
      /no valid enrollment proof/,
    );
    expect(() =>
      unwrapEraKey(
        wrapped,
        { peerId: 'peer-a', ...identity },
        { secrets: [SECRET], workspace: 'other' },
      ),
    ).toThrow(/no valid enrollment proof/);
  });

  it('cannot be unwrapped by a peer it was not wrapped for', () => {
    const target = generateIdentity();
    const other = generateIdentity();
    // Proven for `other` but sealed to `target`'s key, which is the shape a
    // hostile member would build. The proof passes; the ECDH is what refuses.
    const wrapped = wrapEraKey(
      generateEraKey(),
      { peerId: 'other', publicKey: target.publicKey },
      AUTH,
    );
    expect(() => unwrapEraKey(wrapped, { peerId: 'other', ...other }, SECRETS)).toThrow(
      /failed authenticated decryption/,
    );
  });

  it('cannot be redirected at another recipient even by someone holding the right private key', () => {
    const target = generateIdentity();
    const other = generateIdentity();
    const wrapped = wrapEraKey(
      generateEraKey(),
      { peerId: 'other', publicKey: target.publicKey },
      AUTH,
    );
    // The Diffie-Hellman here succeeds, since the real private key is passed. What
    // refuses is the recipient key not matching the one the object was wrapped for.
    // That key is bound in two places, the KDF salt and the AAD, and mutation shows
    // either alone suffices: this fails only when both bindings are removed.
    expect(() =>
      unwrapEraKey(
        wrapped,
        { peerId: 'other', publicKey: other.publicKey, privateKey: target.privateKey },
        SECRETS,
      ),
    ).toThrow(/failed authenticated decryption/);
  });

  it('rejects a tampered ciphertext rather than yielding a wrong key', () => {
    const identity = generateIdentity();
    const wrapped = wrapEraKey(
      generateEraKey(),
      { peerId: 'peer-a', publicKey: identity.publicKey },
      AUTH,
    );
    wrapped.ciphertext[0] = wrapped.ciphertext[0]! ^ 0xff;
    expect(() =>
      unwrapEraKey(reproof(wrapped, 'peer-a'), { peerId: 'peer-a', ...identity }, SECRETS),
    ).toThrow(/failed authenticated decryption/);
  });

  it('rejects an eraId edited after the fact, because the id is inside the AAD', () => {
    const identity = generateIdentity();
    const wrapped = wrapEraKey(
      generateEraKey(),
      { peerId: 'peer-a', publicKey: identity.publicKey },
      AUTH,
    );
    const edited = reproof({ ...wrapped, eraId: 'deadbeef' }, 'peer-a');
    expect(() => unwrapEraKey(edited, { peerId: 'peer-a', ...identity }, SECRETS)).toThrow(
      /failed authenticated decryption/,
    );
  });

  it('rejects a consistent liar: a wrapper whose label and AAD agree but whose material does not', () => {
    const identity = generateIdentity();
    const era = generateEraKey();
    // Editing the object cannot produce this case, because the id is authenticated.
    // A malicious peer can, by sealing real material under a label of its choosing,
    // and the only thing that catches it is re-deriving the id from what came out.
    const mislabelled = wrapEraKey(
      { id: 'deadbeef', key: era.key },
      { peerId: 'peer-a', publicKey: identity.publicKey },
      AUTH,
    );
    expect(() => unwrapEraKey(mislabelled, { peerId: 'peer-a', ...identity }, SECRETS)).toThrow(
      /claims era deadbeef but contains/,
    );
  });

  it('produces a different object every time for the same inputs', () => {
    const identity = generateIdentity();
    const era = generateEraKey();
    const recipient = { peerId: 'peer-a', publicKey: identity.publicKey };
    const first = wrapEraKey(era, recipient, AUTH);
    const second = wrapEraKey(era, recipient, AUTH);
    expect(first.ephemeralPublicKey.equals(second.ephemeralPublicKey)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(first.proof.equals(second.proof)).toBe(false);
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
