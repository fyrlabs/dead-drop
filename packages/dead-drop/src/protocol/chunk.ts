/**
 * Payload chunking.
 *
 * Object-store transports impose hard per-object limits (the GitHub contents
 * API rejects blobs over ~100 MB and is unhappy well before that). Chunking is
 * handled once here rather than in every adapter: a large envelope becomes N
 * envelopes sharing a `chunk.groupId`, and the receiving side reassembles them
 * before the message reaches any application code.
 */

import { createEnvelope, type Envelope } from './envelope.js';
import { DeadDropError } from './errors.js';
import { createGroupId } from './ids.js';

/** Headroom left for the JSON header and frame preamble inside a transport's object limit. */
export const CHUNK_HEADER_ALLOWANCE_BYTES = 2048;

/**
 * Splits an envelope so no chunk payload exceeds `maxPayloadBytes`.
 * Returns the original envelope untouched when it already fits.
 */
export function chunkEnvelope(envelope: Envelope, maxPayloadBytes: number): Envelope[] {
  if (maxPayloadBytes <= 0) {
    throw new DeadDropError('CONFIG_INVALID', 'maxPayloadBytes must be positive');
  }
  if (envelope.chunk) {
    throw new DeadDropError('INTERNAL', 'cannot chunk an envelope that is already a chunk');
  }
  const total = envelope.payload.length;
  if (total <= maxPayloadBytes) return [envelope];

  const count = Math.ceil(total / maxPayloadBytes);
  const groupId = createGroupId(envelope.ts);
  const chunks: Envelope[] = [];
  for (let index = 0; index < count; index++) {
    const start = index * maxPayloadBytes;
    chunks.push(
      createEnvelope({
        ...envelope,
        // Each chunk is an independent message on the wire and needs its own id;
        // the group id is what ties them back together.
        id: undefined,
        idempotencyKey: `${groupId}:${index}`,
        payload: new Uint8Array(envelope.payload.subarray(start, start + maxPayloadBytes)),
        chunk: { groupId, index, count, totalBytes: total },
      }),
    );
  }
  return chunks;
}

export interface ChunkAssemblerOptions {
  /** Abandon a partial group after this long without a new chunk. Default 5 minutes. */
  groupTtlMs?: number;
  /** Refuse groups whose declared size exceeds this. Default 64 MiB. */
  maxMessageBytes?: number;
  /** Cap on simultaneously tracked groups, oldest evicted first. Default 256. */
  maxGroups?: number;
  now?: () => number;
}

interface PendingGroup {
  parts: Array<Uint8Array | undefined>;
  received: number;
  bytes: number;
  totalBytes: number;
  template: Envelope;
  updatedAt: number;
}

/**
 * Reassembles chunked envelopes. Not safe to share between workspaces: group
 * ids are only unique within a sender.
 */
export class ChunkAssembler {
  private readonly groups = new Map<string, PendingGroup>();
  private readonly groupTtlMs: number;
  private readonly maxMessageBytes: number;
  private readonly maxGroups: number;
  private readonly now: () => number;

  constructor(options: ChunkAssemblerOptions = {}) {
    this.groupTtlMs = options.groupTtlMs ?? 5 * 60_000;
    this.maxMessageBytes = options.maxMessageBytes ?? 64 * 1024 * 1024;
    this.maxGroups = options.maxGroups ?? 256;
    this.now = options.now ?? Date.now;
  }

  /**
   * Feeds one envelope in. Returns the reassembled envelope once the final
   * chunk arrives, `undefined` while the group is incomplete, and the envelope
   * itself when it was never chunked.
   */
  add(envelope: Envelope): Envelope | undefined {
    const chunk = envelope.chunk;
    if (!chunk) return envelope;

    this.evictExpired();
    if (chunk.totalBytes > this.maxMessageBytes) {
      throw new DeadDropError(
        'PAYLOAD_TOO_LARGE',
        `chunked message declares ${chunk.totalBytes} bytes, limit is ${this.maxMessageBytes}`,
        { details: { groupId: chunk.groupId } },
      );
    }

    let group = this.groups.get(chunk.groupId);
    if (!group) {
      if (this.groups.size >= this.maxGroups) this.evictOldest();
      group = {
        parts: new Array<Uint8Array | undefined>(chunk.count),
        received: 0,
        bytes: 0,
        totalBytes: chunk.totalBytes,
        template: envelope,
        updatedAt: this.now(),
      };
      this.groups.set(chunk.groupId, group);
    }
    if (group.parts.length !== chunk.count || group.totalBytes !== chunk.totalBytes) {
      this.groups.delete(chunk.groupId);
      throw new DeadDropError('DECODE_FAILED', 'chunk group metadata is inconsistent', {
        details: { groupId: chunk.groupId },
      });
    }
    if (group.parts[chunk.index] !== undefined) return undefined; // duplicate delivery

    group.parts[chunk.index] = envelope.payload;
    group.received += 1;
    group.bytes += envelope.payload.length;
    group.updatedAt = this.now();
    if (group.bytes > this.maxMessageBytes) {
      this.groups.delete(chunk.groupId);
      throw new DeadDropError('PAYLOAD_TOO_LARGE', 'chunk group exceeded the message size limit');
    }
    if (group.received < chunk.count) return undefined;

    this.groups.delete(chunk.groupId);
    if (group.bytes !== group.totalBytes) {
      throw new DeadDropError(
        'CHUNK_INCOMPLETE',
        `reassembled ${group.bytes} bytes but the group declared ${group.totalBytes}`,
        { details: { groupId: chunk.groupId } },
      );
    }
    const payload = new Uint8Array(group.totalBytes);
    let offset = 0;
    for (const part of group.parts) {
      if (!part) throw new DeadDropError('CHUNK_INCOMPLETE', 'missing chunk during reassembly');
      payload.set(part, offset);
      offset += part.length;
    }
    const { chunk: _chunk, ...rest } = group.template;
    // The original message id does not survive chunking, so the group id becomes
    // the dedupe key: a full redelivery of the group collapses to one message.
    return { ...rest, idempotencyKey: chunk.groupId, payload };
  }

  /** Groups still waiting for chunks. Exposed for metrics and tests. */
  get pendingGroups(): number {
    return this.groups.size;
  }

  private evictExpired(): void {
    const cutoff = this.now() - this.groupTtlMs;
    for (const [id, group] of this.groups) {
      if (group.updatedAt < cutoff) this.groups.delete(id);
    }
  }

  private evictOldest(): void {
    // Map iteration is insertion-ordered, so the first entry is the oldest.
    const oldest = this.groups.keys().next();
    if (!oldest.done) this.groups.delete(oldest.value);
  }
}
