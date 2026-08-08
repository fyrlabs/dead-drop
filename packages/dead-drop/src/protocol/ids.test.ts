import { describe, expect, it } from 'vitest';

import { MAX_ID_TIME, createId, createMessageId, idTime, isValidId } from './ids.js';

describe('createId', () => {
  it('produces 26-character Crockford base32 ids', () => {
    const id = createId();
    expect(id).toHaveLength(26);
    expect(isValidId(id)).toBe(true);
  });

  it('sorts lexicographically by creation time', () => {
    const early = createId(1_000_000);
    const late = createId(2_000_000);
    expect(early < late).toBe(true);
  });

  it('stays monotonic within a single millisecond', () => {
    const ids = Array.from({ length: 500 }, () => createId(1_700_000_000_000));
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('round-trips the timestamp', () => {
    const now = 1_735_689_600_000;
    expect(idTime(createId(now))).toBe(now);
    expect(idTime(createMessageId(now))).toBe(now);
  });

  it('clamps out-of-range timestamps instead of corrupting the encoding', () => {
    expect(idTime(createId(-1))).toBe(0);
    expect(idTime(createId(MAX_ID_TIME + 5000))).toBe(MAX_ID_TIME);
  });

  it('rejects non-ids', () => {
    expect(isValidId('nope')).toBe(false);
    expect(isValidId('U'.repeat(26))).toBe(false); // U is not in the alphabet
    expect(idTime('not-an-id')).toBeUndefined();
  });

  it('generates unique ids across many milliseconds', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i++) ids.add(createId());
    expect(ids.size).toBe(5000);
  });
});
