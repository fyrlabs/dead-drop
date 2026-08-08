import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { KeyRing, deriveWorkspaceKey, generateWorkspaceSecret } from './crypto.js';
import { createEnvelope, type Envelope } from './envelope.js';
import { BridgeError } from './errors.js';
import { decodeFrame, encodeFrame, looksLikeFrame } from './frame.js';

const SECRET = generateWorkspaceSecret();
const KEY = deriveWorkspaceKey(SECRET, 'demo');
const KEYS = new KeyRing(KEY);

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return createEnvelope({
    workspace: 'demo',
    kind: 'event',
    channel: 'orders',
    from: 'peer-a',
    to: 'peer-b',
    contentType: 'application/json',
    // Uint8Array, not Buffer: decoded payloads are plain Uint8Arrays and the
    // two are not deeply equal even when the bytes match.
    payload: Uint8Array.from(Buffer.from('{"hello":"world"}')),
    ...overrides,
  });
}

describe('frame codec', () => {
  it('round-trips an encrypted envelope', async () => {
    const original = envelope();
    const frame = await encodeFrame(original, { key: KEY });
    const decoded = await decodeFrame(frame, { keys: KEYS });

    expect(decoded.envelope).toEqual(original);
    expect(decoded.encrypted).toBe(true);
    expect(decoded.keyId).toBe(KEY.id);
    expect(decoded.wireBytes).toBe(frame.length);
  });

  it('round-trips a plaintext envelope when no key is supplied', async () => {
    const original = envelope();
    const frame = await encodeFrame(original);
    const decoded = await decodeFrame(frame);
    expect(decoded.envelope).toEqual(original);
    expect(decoded.encrypted).toBe(false);
  });

  it('keeps the envelope header out of the clear text', async () => {
    const frame = await encodeFrame(envelope({ channel: 'top-secret-channel' }), { key: KEY });
    expect(Buffer.from(frame).includes('top-secret-channel')).toBe(false);
    expect(Buffer.from(frame).includes('peer-a')).toBe(false);
  });

  it('compresses large compressible payloads and round-trips them', async () => {
    const payload = Buffer.alloc(64 * 1024, 0x41);
    const frame = await encodeFrame(envelope({ payload }), { key: KEY });
    expect(frame.length).toBeLessThan(payload.length / 4);
    const decoded = await decodeFrame(frame, { keys: KEYS });
    expect(decoded.compressed).toBe(true);
    expect(Buffer.from(decoded.envelope.payload).equals(payload)).toBe(true);
  });

  it('does not compress incompressible payloads', async () => {
    const payload = randomBytes(32 * 1024);
    const frame = await encodeFrame(envelope({ payload }), { key: KEY });
    const decoded = await decodeFrame(frame, { keys: KEYS });
    expect(decoded.compressed).toBe(false);
    expect(Buffer.from(decoded.envelope.payload).equals(payload)).toBe(true);
  });

  it('handles empty payloads', async () => {
    const frame = await encodeFrame(envelope({ payload: new Uint8Array(0) }), { key: KEY });
    const decoded = await decodeFrame(frame, { keys: KEYS });
    expect(decoded.envelope.payload).toHaveLength(0);
  });

  it('rejects a tampered ciphertext', async () => {
    const frame = Buffer.from(await encodeFrame(envelope(), { key: KEY }));
    frame[frame.length - 20] ^= 0xff;
    await expect(decodeFrame(frame, { keys: KEYS })).rejects.toMatchObject({
      code: 'DECRYPT_FAILED',
    });
  });

  it('rejects a tampered auth tag', async () => {
    const frame = Buffer.from(await encodeFrame(envelope(), { key: KEY }));
    frame[frame.length - 1] ^= 0x01;
    await expect(decodeFrame(frame, { keys: KEYS })).rejects.toMatchObject({
      code: 'DECRYPT_FAILED',
    });
  });

  it('rejects tampered additional data (the flags byte is authenticated)', async () => {
    const frame = Buffer.from(await encodeFrame(envelope(), { key: KEY }));
    frame[4] ^= 0b0000_0010;
    await expect(decodeFrame(frame, { keys: KEYS })).rejects.toBeInstanceOf(BridgeError);
  });

  it('rejects a frame sealed with a different workspace secret', async () => {
    const frame = await encodeFrame(envelope(), {
      key: deriveWorkspaceKey(generateWorkspaceSecret(), 'demo'),
    });
    await expect(decodeFrame(frame, { keys: KEYS })).rejects.toMatchObject({
      code: 'DECRYPT_FAILED',
    });
  });

  it('rejects a frame sealed for a different workspace name', async () => {
    // Same secret, different workspace: HKDF salting must keep the keys apart.
    const other = deriveWorkspaceKey(SECRET, 'other-workspace');
    const frame = await encodeFrame(envelope(), { key: other });
    await expect(decodeFrame(frame, { keys: KEYS })).rejects.toMatchObject({
      code: 'DECRYPT_FAILED',
    });
  });

  it('accepts frames sealed with a previous key during rotation', async () => {
    const oldSecret = generateWorkspaceSecret();
    const oldKey = deriveWorkspaceKey(oldSecret, 'demo');
    const ring = KeyRing.fromSecrets('demo', [SECRET, oldSecret]);
    const frame = await encodeFrame(envelope(), { key: oldKey });
    await expect(decodeFrame(frame, { keys: ring })).resolves.toMatchObject({ keyId: oldKey.id });
    expect(ring.keyIds).toHaveLength(2);
  });

  it('refuses plaintext frames on an encrypted workspace', async () => {
    const frame = await encodeFrame(envelope());
    await expect(decodeFrame(frame, { keys: KEYS })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('rejects garbage, truncated and oversized input', async () => {
    await expect(decodeFrame(Buffer.from('hello'))).rejects.toMatchObject({
      code: 'DECODE_FAILED',
    });
    const frame = await encodeFrame(envelope(), { key: KEY });
    await expect(decodeFrame(frame.slice(0, 8), { keys: KEYS })).rejects.toBeInstanceOf(
      BridgeError,
    );
    await expect(
      decodeFrame(await encodeFrame(envelope({ payload: Buffer.alloc(4096, 1) })), {
        maxFrameBytes: 64,
      }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('rejects frames that set unknown flag bits', async () => {
    const frame = Buffer.from(await encodeFrame(envelope()));
    frame[4] |= 0b1000_0000;
    await expect(decodeFrame(frame)).rejects.toMatchObject({ code: 'DECODE_FAILED' });
  });

  it('rejects an encrypted frame when no keys are configured', async () => {
    const frame = await encodeFrame(envelope(), { key: KEY });
    await expect(decodeFrame(frame)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
  });

  it('reports an unknown key id rather than trying every key', async () => {
    const frame = await encodeFrame(envelope(), {
      key: deriveWorkspaceKey(generateWorkspaceSecret(), 'demo'),
    });
    await expect(decodeFrame(frame, { keys: KEYS })).rejects.toMatchObject({
      code: 'DECRYPT_FAILED',
    });
  });

  it('identifies Bridge frames', async () => {
    expect(looksLikeFrame(await encodeFrame(envelope()))).toBe(true);
    expect(looksLikeFrame(Buffer.from('README contents'))).toBe(false);
    expect(looksLikeFrame(new Uint8Array(2))).toBe(false);
  });

  it('produces a different ciphertext for identical plaintext', async () => {
    const fixed = envelope({ id: 'msg_0000000000000000000000000', ts: 1 });
    const a = await encodeFrame(fixed, { key: KEY });
    const b = await encodeFrame(fixed, { key: KEY });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});
