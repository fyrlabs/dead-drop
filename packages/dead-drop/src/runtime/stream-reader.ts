/**
 * The receiving half of a streamed response: parts in, ordered bytes out.
 *
 * Parts arrive in whatever order the transport delivers them, and a retried
 * part arrives late by design (`docs/guarantees.md`). So this holds anything
 * ahead of the next expected sequence number and releases the contiguous run
 * each time the gap closes.
 *
 * Every limit here exists because the sender is remote and the gap may never
 * close. A stream that stalls one part in must not be able to hold memory, a
 * socket or a slot in the handler table until the process exits.
 */

import { DeadDropError } from '../protocol/index.js';
import type { HttpStreamPart } from '../protocol/stream.js';

export interface StreamReaderOptions {
  /** Parts held ahead of the gap before the stream is abandoned. Default 64. */
  maxBufferedChunks?: number;
  /** Bytes held ahead of the gap before the stream is abandoned. Default 8 MiB. */
  maxBufferedBytes?: number;
  /** Total bytes a single stream may deliver. Default 0, meaning no ceiling. */
  maxTotalBytes?: number;
  /** Longest a gap may stay open before the stream is abandoned. Default 60s. */
  gapTimeoutMs?: number;
}

export interface StreamReaderResult {
  /** Bytes now deliverable, in order. Empty when the part only filled a gap. */
  ready: Uint8Array[];
  /** True once `end` has been seen and every part before it has been delivered. */
  done: boolean;
}

const DEFAULTS = {
  maxBufferedChunks: 64,
  maxBufferedBytes: 8 * 1024 * 1024,
  maxTotalBytes: 0,
  gapTimeoutMs: 60_000,
};

export class HttpStreamReader {
  private readonly limits: Required<StreamReaderOptions>;
  private readonly pending = new Map<number, Uint8Array>();
  private next = 0;
  private bufferedBytes = 0;
  private deliveredBytes = 0;
  /** Sequence carrying `end`, once seen. Everything below it is a chunk. */
  private endsAt: number | undefined;
  private finished = false;
  private lastProgressAt: number;

  constructor(now: number, options: StreamReaderOptions = {}) {
    this.limits = { ...DEFAULTS, ...options };
    this.lastProgressAt = now;
  }

  /** Bytes released to the caller so far. */
  get bytesDelivered(): number {
    return this.deliveredBytes;
  }

  get isDone(): boolean {
    return this.finished;
  }

  /**
   * Takes one part and returns whatever became deliverable because of it.
   *
   * Throws rather than returning an error result, because every throw here is a
   * stream that has to be torn down: there is no way to carry on once a limit
   * is breached or the sender contradicts itself.
   */
  accept(part: HttpStreamPart, now: number): StreamReaderResult {
    if (this.finished) {
      throw new DeadDropError('BAD_REQUEST', 'stream part arrived after the stream ended');
    }
    if (part.kind === 'error') {
      this.finished = true;
      throw new DeadDropError('TRANSPORT_ERROR', `the remote stream failed: ${part.message}`, {
        details: { remoteCode: part.code },
      });
    }
    if (part.seq < this.next || this.pending.has(part.seq)) {
      // A duplicate is ordinary: delivery is at-least-once, so the same part can
      // legitimately arrive twice. Dropping it is the whole point of tracking
      // sequence numbers, and it must not look like an error.
      return { ready: [], done: false };
    }
    if (this.endsAt !== undefined && part.seq >= this.endsAt) {
      throw new DeadDropError('BAD_REQUEST', 'stream part claims a sequence beyond the end');
    }

    if (part.kind === 'end') {
      if (this.endsAt !== undefined && this.endsAt !== part.seq) {
        throw new DeadDropError('BAD_REQUEST', 'stream ended twice at different sequences');
      }
      this.endsAt = part.seq;
    } else {
      this.pending.set(part.seq, part.body);
      this.bufferedBytes += part.body.length;
      this.enforceBuffered();
    }

    this.lastProgressAt = now;
    return this.drain();
  }

  /**
   * Fails the stream when the gap it is waiting on has been open too long.
   *
   * Driven by the caller rather than a timer of its own, so a reader owns no
   * handle that could keep the process alive after the response is gone.
   */
  checkTimeout(now: number): void {
    if (this.finished) return;
    if (now - this.lastProgressAt < this.limits.gapTimeoutMs) return;
    this.finished = true;
    throw new DeadDropError(
      'TIMEOUT',
      `stream stalled waiting for part ${this.next} for ${now - this.lastProgressAt}ms`,
      { details: { waitingFor: this.next } },
    );
  }

  /** Drops everything held. Safe to call more than once. */
  discard(): void {
    this.finished = true;
    this.pending.clear();
    this.bufferedBytes = 0;
  }

  private enforceBuffered(): void {
    if (
      this.pending.size > this.limits.maxBufferedChunks ||
      this.bufferedBytes > this.limits.maxBufferedBytes
    ) {
      this.discard();
      throw new DeadDropError(
        'PAYLOAD_TOO_LARGE',
        `stream buffered ${this.pending.size} parts waiting for ${this.next}, past its limit`,
        { details: { waitingFor: this.next } },
      );
    }
  }

  private drain(): StreamReaderResult {
    const ready: Uint8Array[] = [];
    for (;;) {
      const chunk = this.pending.get(this.next);
      if (chunk === undefined) break;
      this.pending.delete(this.next);
      this.bufferedBytes -= chunk.length;
      this.deliveredBytes += chunk.length;
      if (this.limits.maxTotalBytes > 0 && this.deliveredBytes > this.limits.maxTotalBytes) {
        this.discard();
        throw new DeadDropError(
          'PAYLOAD_TOO_LARGE',
          `stream exceeded ${this.limits.maxTotalBytes} bytes`,
        );
      }
      ready.push(chunk);
      this.next += 1;
    }
    const done = this.endsAt !== undefined && this.next === this.endsAt;
    if (done) {
      this.finished = true;
      this.pending.clear();
      this.bufferedBytes = 0;
    }
    return { ready, done };
  }
}
