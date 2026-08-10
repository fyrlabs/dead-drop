import { describe, expect, it } from 'vitest';

import { decodeJson, encodeJson, isErrorPayload } from '#dead-drop/protocol/json.js';

describe('json helpers', () => {
  it('round-trips values and treats an empty payload as null', () => {
    expect(decodeJson(encodeJson({ a: 1 }))).toEqual({ a: 1 });
    expect(decodeJson(encodeJson(undefined))).toBeNull();
    expect(decodeJson(new Uint8Array(0))).toBeNull();
  });

  it('rejects unserialisable values and invalid payloads', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => encodeJson(cyclic)).toThrowError(/JSON-serialisable/);
    expect(() => decodeJson(Buffer.from('{oops'))).toThrowError(/valid JSON/);
  });

  it('detects error payloads', () => {
    expect(isErrorPayload({ error: { code: 'TIMEOUT', message: 'x' } })).toBe(true);
    expect(isErrorPayload({ error: 'TIMEOUT' })).toBe(false);
    expect(isErrorPayload(null)).toBe(false);
    expect(isErrorPayload({ ok: true })).toBe(false);
  });
});
