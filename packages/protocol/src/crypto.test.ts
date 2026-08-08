import { describe, expect, it } from 'vitest';

import {
  KeyRing,
  SECRET_PREFIX,
  deriveWorkspaceKey,
  generateWorkspaceSecret,
  open,
  parseWorkspaceSecret,
  safeEqual,
  seal,
} from './crypto.js';

describe('workspace secrets', () => {
  it('generates parseable 32-byte secrets', () => {
    const secret = generateWorkspaceSecret();
    expect(secret.startsWith(SECRET_PREFIX)).toBe(true);
    expect(parseWorkspaceSecret(secret)).toHaveLength(32);
    expect(generateWorkspaceSecret()).not.toBe(secret);
  });

  it('rejects malformed secrets', () => {
    expect(() => parseWorkspaceSecret('nope')).toThrowError(/must start with/);
    expect(() => parseWorkspaceSecret(`${SECRET_PREFIX}c2hvcnQ`)).toThrowError(/32 bytes/);
  });

  it('derives a stable key id per secret and workspace', () => {
    const secret = generateWorkspaceSecret();
    expect(deriveWorkspaceKey(secret, 'a').id).toBe(deriveWorkspaceKey(secret, 'a').id);
    expect(deriveWorkspaceKey(secret, 'a').id).not.toBe(deriveWorkspaceKey(secret, 'b').id);
    expect(deriveWorkspaceKey(secret, 'a').id).toHaveLength(8);
  });
});

describe('seal/open', () => {
  const key = deriveWorkspaceKey(generateWorkspaceSecret(), 'demo');
  const plaintext = Buffer.from('sensitive payload');
  const aad = Buffer.from('header');

  it('round-trips', () => {
    const sealed = seal(key, plaintext, aad);
    expect(open(key, sealed.iv, sealed.ciphertext, sealed.tag, aad).equals(plaintext)).toBe(true);
  });

  it('fails when the additional data differs', () => {
    const sealed = seal(key, plaintext, aad);
    expect(() => open(key, sealed.iv, sealed.ciphertext, sealed.tag, Buffer.from('other'))).toThrow(
      /authenticated decryption/,
    );
  });

  it('validates iv and tag lengths before attempting decryption', () => {
    const sealed = seal(key, plaintext, aad);
    expect(() => open(key, Buffer.alloc(4), sealed.ciphertext, sealed.tag, aad)).toThrow(/iv must/);
    expect(() => open(key, sealed.iv, sealed.ciphertext, Buffer.alloc(4), aad)).toThrow(/auth tag/);
  });

  it('uses a fresh iv per message', () => {
    const a = seal(key, plaintext, aad);
    const b = seal(key, plaintext, aad);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });
});

describe('KeyRing', () => {
  it('resolves keys by id and reports unknown ones', () => {
    const primary = deriveWorkspaceKey(generateWorkspaceSecret(), 'demo');
    const ring = new KeyRing(primary);
    expect(ring.get(primary.id)).toBe(primary);
    expect(() => ring.get('deadbeef')).toThrowError(/no workspace key/);
  });

  it('builds from a secret list with the first entry as primary', () => {
    const secrets = [generateWorkspaceSecret(), generateWorkspaceSecret()];
    const ring = KeyRing.fromSecrets('demo', secrets);
    expect(ring.primary.id).toBe(deriveWorkspaceKey(secrets[0] as string, 'demo').id);
    expect(ring.keyIds).toHaveLength(2);
  });

  it('requires at least one secret', () => {
    expect(() => KeyRing.fromSecrets('demo', [])).toThrowError(/at least one/);
  });
});

describe('safeEqual', () => {
  it('compares content and length', () => {
    expect(safeEqual(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
    expect(safeEqual(Buffer.from('abc'), Buffer.from('abd'))).toBe(false);
    expect(safeEqual(Buffer.from('abc'), Buffer.from('abcd'))).toBe(false);
  });
});
