import { describe, expect, it } from 'vitest';

import { DeadDropError } from '#dead-drop/protocol/index.js';
import { HttpStreamReader } from '#dead-drop/runtime/stream-reader.js';

const chunk = (seq: number, text: string) =>
  ({ kind: 'chunk', seq, body: new Uint8Array(Buffer.from(text, 'utf8')) }) as const;

const text = (parts: Uint8Array[]) => Buffer.concat(parts.map((p) => Buffer.from(p))).toString();

describe('reordering a streamed body', () => {
  it('releases bytes in order however they arrive', () => {
    const reader = new HttpStreamReader(0);

    // Deliberately shuffled: best-effort ordering means a retried part lands late.
    expect(text(reader.accept(chunk(2, 'c'), 0).ready)).toBe('');
    expect(text(reader.accept(chunk(0, 'a'), 0).ready)).toBe('a');
    const filled = reader.accept(chunk(1, 'b'), 0);
    expect(text(filled.ready)).toBe('bc');
    expect(filled.done).toBe(false);

    const ended = reader.accept({ kind: 'end', seq: 3 }, 0);
    expect(ended.done).toBe(true);
    expect(reader.bytesDelivered).toBe(3);
  });

  it('completes when end arrives before the chunks it closes', () => {
    const reader = new HttpStreamReader(0);
    expect(reader.accept({ kind: 'end', seq: 2 }, 0).done).toBe(false);
    expect(text(reader.accept(chunk(1, 'y'), 0).ready)).toBe('');
    const last = reader.accept(chunk(0, 'x'), 0);
    expect(text(last.ready)).toBe('xy');
    expect(last.done).toBe(true);
  });

  it('drops a duplicate silently, because delivery is at-least-once', () => {
    const reader = new HttpStreamReader(0);
    expect(text(reader.accept(chunk(0, 'a'), 0).ready)).toBe('a');
    // The same part again, and a part already delivered. Neither is an error.
    expect(text(reader.accept(chunk(0, 'a'), 0).ready)).toBe('');
    expect(reader.bytesDelivered).toBe(1);
  });

  it('raises the remote failure an error part describes', () => {
    const reader = new HttpStreamReader(0);
    expect(() =>
      reader.accept({ kind: 'error', seq: 0, code: 'TIMEOUT', message: 'upstream stalled' }, 0),
    ).toThrowError(/upstream stalled/);
    expect(reader.isDone).toBe(true);
  });

  it('abandons a stream whose gap holds too many parts', () => {
    const reader = new HttpStreamReader(0, { maxBufferedChunks: 3 });
    // Nothing can be released while sequence 0 is missing, so these pile up.
    for (const seq of [1, 2, 3]) reader.accept(chunk(seq, 'x'), 0);
    expect(() => reader.accept(chunk(4, 'x'), 0)).toThrowError(DeadDropError);
    expect(reader.isDone).toBe(true);
  });

  it('abandons a stream whose gap holds too many bytes', () => {
    const reader = new HttpStreamReader(0, { maxBufferedBytes: 8 });
    reader.accept(chunk(1, 'aaaaa'), 0);
    expect(() => reader.accept(chunk(2, 'bbbbb'), 0)).toThrowError(/past its limit/);
  });

  it('enforces a ceiling on what one stream may deliver in total', () => {
    const reader = new HttpStreamReader(0, { maxTotalBytes: 4 });
    expect(text(reader.accept(chunk(0, 'abc'), 0).ready)).toBe('abc');
    expect(() => reader.accept(chunk(1, 'def'), 0)).toThrowError(DeadDropError);
  });

  it('fails a gap that stays open past the timeout, and only then', () => {
    const reader = new HttpStreamReader(0, { gapTimeoutMs: 1000 });
    reader.accept(chunk(1, 'later'), 0);
    expect(() => reader.checkTimeout(500)).not.toThrow();

    // Progress resets the clock, so a slow but moving stream is never killed.
    reader.accept(chunk(0, 'now'), 900);
    expect(() => reader.checkTimeout(1500)).not.toThrow();
    expect(() => reader.checkTimeout(2000)).toThrowError(/stalled waiting for part 2/);
  });

  it('refuses a part that arrives after the stream ended', () => {
    const reader = new HttpStreamReader(0);
    reader.accept({ kind: 'end', seq: 0 }, 0);
    expect(() => reader.accept(chunk(0, 'late'), 0)).toThrowError(DeadDropError);
  });

  it('refuses a part claiming a sequence beyond the declared end', () => {
    const reader = new HttpStreamReader(0);
    reader.accept({ kind: 'end', seq: 2 }, 0);
    expect(() => reader.accept(chunk(5, 'impossible'), 0)).toThrowError(/beyond the end/);
  });

  it('refuses two ends that disagree about where the body stops', () => {
    const reader = new HttpStreamReader(0);
    reader.accept({ kind: 'end', seq: 4 }, 0);
    expect(() => reader.accept({ kind: 'end', seq: 3 }, 0)).toThrowError(/ended twice/);
  });

  it('discards without complaint, more than once', () => {
    const reader = new HttpStreamReader(0);
    reader.accept(chunk(3, 'held'), 0);
    reader.discard();
    reader.discard();
    expect(reader.isDone).toBe(true);
    expect(() => reader.checkTimeout(999_999)).not.toThrow();
  });
});
