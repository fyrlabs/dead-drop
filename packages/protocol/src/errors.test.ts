import { describe, expect, it } from 'vitest';

import { BridgeError, isBridgeErrorCode } from './errors.js';
import { decodeJson, encodeJson, isErrorPayload } from './json.js';

describe('BridgeError', () => {
  it('marks transport-ish codes retryable and others not', () => {
    expect(new BridgeError('TIMEOUT', 'slow').retryable).toBe(true);
    expect(new BridgeError('RATE_LIMITED', 'slow down').retryable).toBe(true);
    expect(new BridgeError('BAD_REQUEST', 'nope').retryable).toBe(false);
    expect(new BridgeError('BAD_REQUEST', 'nope', { retryable: true }).retryable).toBe(true);
  });

  it('serialises to a wire shape without the cause chain', () => {
    const error = new BridgeError('RATE_LIMITED', 'slow down', {
      cause: new Error('secret internals'),
      details: { transport: 'github' },
      retryAfterMs: 5000,
    });
    const json = error.toJSON();
    expect(json).toEqual({
      name: 'BridgeError',
      code: 'RATE_LIMITED',
      message: 'slow down',
      retryable: true,
      details: { transport: 'github' },
      retryAfterMs: 5000,
    });
    expect(JSON.stringify(json)).not.toContain('secret internals');
  });

  it('round-trips through JSON and tolerates junk', () => {
    const original = new BridgeError('NOT_FOUND', 'missing', { details: { key: 'a' } });
    const restored = BridgeError.fromJSON(JSON.parse(JSON.stringify(original.toJSON())));
    expect(restored.code).toBe('NOT_FOUND');
    expect(restored.details).toEqual({ key: 'a' });

    expect(BridgeError.fromJSON('garbage').code).toBe('INTERNAL');
    expect(BridgeError.fromJSON({ code: 'MADE_UP', message: 'x' }).code).toBe('INTERNAL');
  });

  it('coerces arbitrary throwables, mapping aborts to CANCELLED', () => {
    const original = new BridgeError('TIMEOUT', 'x');
    expect(BridgeError.from(original)).toBe(original);
    expect(BridgeError.from('boom').code).toBe('INTERNAL');
    expect(BridgeError.from(new Error('boom'), 'TRANSPORT_ERROR').code).toBe('TRANSPORT_ERROR');

    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(BridgeError.from(abort).code).toBe('CANCELLED');
  });

  it('recognises its own codes', () => {
    expect(isBridgeErrorCode('TIMEOUT')).toBe(true);
    expect(isBridgeErrorCode('NOPE')).toBe(false);
    expect(isBridgeErrorCode(7)).toBe(false);
  });
});

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
