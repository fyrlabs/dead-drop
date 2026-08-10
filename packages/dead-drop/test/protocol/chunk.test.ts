import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { ChunkAssembler, chunkEnvelope } from '#dead-drop/protocol/chunk.js';
import { createEnvelope, type Envelope } from '#dead-drop/protocol/envelope.js';

function envelope(payload: Uint8Array): Envelope {
  return createEnvelope({
    workspace: 'demo',
    kind: 'request',
    channel: 'files.upload',
    from: 'peer-a',
    to: 'peer-b',
    contentType: 'application/octet-stream',
    payload,
  });
}

describe('chunkEnvelope', () => {
  it('returns the original envelope when it already fits', () => {
    const original = envelope(new Uint8Array(100));
    expect(chunkEnvelope(original, 1000)).toEqual([original]);
  });

  it('splits into chunks that each carry group metadata', () => {
    const chunks = chunkEnvelope(envelope(new Uint8Array(250)), 100);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.payload.length)).toEqual([100, 100, 50]);
    for (const [index, chunk] of chunks.entries()) {
      expect(chunk.chunk).toMatchObject({ index, count: 3, totalBytes: 250 });
      expect(chunk.chunk?.groupId).toBe(chunks[0]?.chunk?.groupId);
      expect(chunk.channel).toBe('files.upload');
    }
    expect(new Set(chunks.map((c) => c.id)).size).toBe(3);
  });

  it('refuses to chunk an already-chunked envelope or use a bad limit', () => {
    const [chunk] = chunkEnvelope(envelope(new Uint8Array(10)), 4);
    expect(() => chunkEnvelope(chunk as Envelope, 4)).toThrowError(/already a chunk/);
    expect(() => chunkEnvelope(envelope(new Uint8Array(10)), 0)).toThrowError(/must be positive/);
  });
});

describe('ChunkAssembler', () => {
  it('passes unchunked envelopes straight through', () => {
    const assembler = new ChunkAssembler();
    const original = envelope(new Uint8Array([1, 2, 3]));
    expect(assembler.add(original)).toBe(original);
  });

  it('reassembles chunks arriving out of order', () => {
    const payload = randomBytes(4096);
    const chunks = chunkEnvelope(envelope(payload), 1000);
    const assembler = new ChunkAssembler();
    const shuffled = [chunks[3], chunks[0], chunks[4], chunks[2], chunks[1]] as Envelope[];

    let result: Envelope | undefined;
    for (const chunk of shuffled) result = assembler.add(chunk);

    expect(result).toBeDefined();
    expect(Buffer.from(result!.payload).equals(payload)).toBe(true);
    expect(result!.chunk).toBeUndefined();
    expect(result!.channel).toBe('files.upload');
    expect(assembler.pendingGroups).toBe(0);
  });

  it('uses the group id as the dedupe key of the reassembled message', () => {
    const chunks = chunkEnvelope(envelope(new Uint8Array(10)), 4);
    const assembler = new ChunkAssembler();
    let result: Envelope | undefined;
    for (const chunk of chunks) result = assembler.add(chunk);
    expect(result?.idempotencyKey).toBe(chunks[0]?.chunk?.groupId);
  });

  it('ignores duplicate chunk deliveries', () => {
    const chunks = chunkEnvelope(envelope(new Uint8Array(30)), 10);
    const assembler = new ChunkAssembler();
    expect(assembler.add(chunks[0] as Envelope)).toBeUndefined();
    expect(assembler.add(chunks[0] as Envelope)).toBeUndefined();
    expect(assembler.add(chunks[1] as Envelope)).toBeUndefined();
    expect(assembler.add(chunks[2] as Envelope)).toBeDefined();
  });

  it('drops groups that go quiet for longer than the ttl', () => {
    let now = 0;
    const assembler = new ChunkAssembler({ groupTtlMs: 1000, now: () => now });
    const chunks = chunkEnvelope(envelope(new Uint8Array(30)), 10);
    assembler.add(chunks[0] as Envelope);
    expect(assembler.pendingGroups).toBe(1);

    now = 5000;
    // Adding an unrelated group triggers the sweep; the stale group is gone.
    assembler.add(chunkEnvelope(envelope(new Uint8Array(20)), 10)[0] as Envelope);
    expect(assembler.pendingGroups).toBe(1);
  });

  it('evicts the oldest group when too many are in flight', () => {
    const assembler = new ChunkAssembler({ maxGroups: 2 });
    for (let i = 0; i < 4; i++) {
      assembler.add(chunkEnvelope(envelope(new Uint8Array(30)), 10)[0] as Envelope);
    }
    expect(assembler.pendingGroups).toBe(2);
  });

  it('rejects a group larger than the message limit', () => {
    const assembler = new ChunkAssembler({ maxMessageBytes: 100 });
    const chunks = chunkEnvelope(envelope(new Uint8Array(500)), 100);
    expect(() => assembler.add(chunks[0] as Envelope)).toThrowError(/PAYLOAD|limit|bytes/i);
  });

  it('rejects chunks whose group metadata disagrees', () => {
    const assembler = new ChunkAssembler();
    const chunks = chunkEnvelope(envelope(new Uint8Array(30)), 10);
    assembler.add(chunks[0] as Envelope);
    const forged = {
      ...(chunks[1] as Envelope),
      chunk: { ...(chunks[1] as Envelope).chunk!, count: 9 },
    };
    expect(() => assembler.add(forged)).toThrowError(/inconsistent/);
  });

  it('detects a group whose parts do not add up to the declared size', () => {
    const assembler = new ChunkAssembler();
    const chunks = chunkEnvelope(envelope(new Uint8Array(30)), 10);
    assembler.add(chunks[0] as Envelope);
    assembler.add(chunks[1] as Envelope);
    const truncated = { ...(chunks[2] as Envelope), payload: new Uint8Array(3) };
    expect(() => assembler.add(truncated)).toThrowError(/declared/);
  });
});
