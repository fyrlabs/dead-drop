import { describe, expect, it } from 'vitest';

import { DeadDropError, isDeadDropErrorCode } from './errors.js';

describe('DeadDropError', () => {
  it('marks transport-ish codes retryable and others not', () => {
    expect(new DeadDropError('TIMEOUT', 'slow').retryable).toBe(true);
    expect(new DeadDropError('RATE_LIMITED', 'slow down').retryable).toBe(true);
    expect(new DeadDropError('BAD_REQUEST', 'nope').retryable).toBe(false);
    expect(new DeadDropError('BAD_REQUEST', 'nope', { retryable: true }).retryable).toBe(true);
  });

  it('serialises to a wire shape without the cause chain', () => {
    const error = new DeadDropError('RATE_LIMITED', 'slow down', {
      cause: new Error('secret internals'),
      details: { transport: 'github' },
      retryAfterMs: 5000,
    });
    const json = error.toJSON();
    expect(json).toEqual({
      name: 'DeadDropError',
      code: 'RATE_LIMITED',
      message: 'slow down',
      retryable: true,
      details: { transport: 'github' },
      retryAfterMs: 5000,
    });
    expect(JSON.stringify(json)).not.toContain('secret internals');
  });

  it('round-trips through JSON and tolerates junk', () => {
    const original = new DeadDropError('NOT_FOUND', 'missing', { details: { key: 'a' } });
    const restored = DeadDropError.fromJSON(JSON.parse(JSON.stringify(original.toJSON())));
    expect(restored.code).toBe('NOT_FOUND');
    expect(restored.details).toEqual({ key: 'a' });

    expect(DeadDropError.fromJSON('garbage').code).toBe('INTERNAL');
    expect(DeadDropError.fromJSON({ code: 'MADE_UP', message: 'x' }).code).toBe('INTERNAL');
  });

  it('coerces arbitrary throwables, mapping aborts to CANCELLED', () => {
    const original = new DeadDropError('TIMEOUT', 'x');
    expect(DeadDropError.from(original)).toBe(original);
    expect(DeadDropError.from('boom').code).toBe('INTERNAL');
    expect(DeadDropError.from(new Error('boom'), 'TRANSPORT_ERROR').code).toBe('TRANSPORT_ERROR');

    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(DeadDropError.from(abort).code).toBe('CANCELLED');
  });

  it('recognises its own codes', () => {
    expect(isDeadDropErrorCode('TIMEOUT')).toBe(true);
    expect(isDeadDropErrorCode('NOPE')).toBe(false);
    expect(isDeadDropErrorCode(7)).toBe(false);
  });
});
