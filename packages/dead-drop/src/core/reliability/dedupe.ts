/**
 * Delivery deduplication.
 *
 * dead-drop promises at-least-once delivery, which means duplicates are normal:
 * a crash between "handler succeeded" and "message deleted" replays the
 * message, and so does any transport that briefly resurrects a deleted object.
 * This turns at-least-once into effectively-once for handlers that are not
 * themselves idempotent.
 *
 * Bounded by both count and age, and optionally persisted, because a dedupe
 * cache that dies with the process does nothing for the crash case above.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Clock } from '../clock.js';
import { systemClock } from '../clock.js';

export interface DedupeStoreOptions {
  /** Entries older than this are forgotten. Default 1 hour. */
  ttlMs?: number;
  /** Hard cap; the oldest entries are evicted first. Default 10_000. */
  maxEntries?: number;
  clock?: Clock;
  /** File the set is persisted to. Omit for memory-only. */
  persistPath?: string;
  /** Minimum gap between disk writes. Default 1000ms. */
  flushIntervalMs?: number;
}

interface Persisted {
  version: 1;
  entries: Array<[string, number]>;
}

export class DedupeStore {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly clock: Clock;
  private readonly persistPath: string | undefined;
  private readonly flushIntervalMs: number;
  private lastFlushAt = 0;
  private dirty = false;
  private flushing: Promise<void> | undefined;

  constructor(options: DedupeStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60 * 60_000;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.clock = options.clock ?? systemClock;
    this.persistPath = options.persistPath;
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
  }

  /** Loads a previously persisted set. Missing or corrupt files start empty. */
  async load(): Promise<void> {
    if (!this.persistPath) return;
    try {
      const raw = await readFile(this.persistPath, 'utf8');
      const parsed = JSON.parse(raw) as Persisted;
      if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return;
      const cutoff = this.clock.now() - this.ttlMs;
      for (const entry of parsed.entries) {
        if (!Array.isArray(entry)) continue;
        const [key, time] = entry;
        if (typeof key === 'string' && typeof time === 'number' && time > cutoff) {
          this.seen.set(key, time);
        }
      }
    } catch {
      // A missing or unreadable dedupe file is not fatal: worst case we redeliver.
    }
  }

  /** True if `key` was already recorded. Sweeps expired entries as it goes. */
  has(key: string): boolean {
    const recordedAt = this.seen.get(key);
    if (recordedAt === undefined) return false;
    if (this.clock.now() - recordedAt > this.ttlMs) {
      this.seen.delete(key);
      return false;
    }
    return true;
  }

  /** Records `key`. Returns false if it was already present. */
  add(key: string): boolean {
    if (this.has(key)) return false;
    this.seen.set(key, this.clock.now());
    this.dirty = true;
    this.evict();
    return true;
  }

  /**
   * Atomically checks and records. The common call site:
   * `if (!dedupe.claim(key)) { drop as duplicate }`.
   */
  claim(key: string): boolean {
    return this.add(key);
  }

  delete(key: string): void {
    if (this.seen.delete(key)) this.dirty = true;
  }

  get size(): number {
    return this.seen.size;
  }

  clear(): void {
    this.seen.clear();
    this.dirty = true;
  }

  /** Writes to disk if enough time has passed. `force` ignores the interval. */
  async flush(force = false): Promise<void> {
    if (!this.persistPath || (!this.dirty && !force)) return;
    if (!force && this.clock.now() - this.lastFlushAt < this.flushIntervalMs) return;
    // Serialise concurrent flushes; two temp-file renames racing can lose data.
    if (this.flushing) {
      await this.flushing;
      if (!this.dirty) return;
    }
    this.flushing = this.writeFile();
    try {
      await this.flushing;
    } finally {
      this.flushing = undefined;
    }
  }

  private async writeFile(): Promise<void> {
    const path = this.persistPath;
    if (!path) return;
    this.dirty = false;
    this.lastFlushAt = this.clock.now();
    const payload: Persisted = { version: 1, entries: [...this.seen.entries()] };
    const temp = `${path}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temp, JSON.stringify(payload));
      await rename(temp, path);
    } catch {
      // Persistence is best-effort; losing it only costs us redelivery.
      this.dirty = true;
    }
  }

  private evict(): void {
    const cutoff = this.clock.now() - this.ttlMs;
    for (const [key, time] of this.seen) {
      if (time <= cutoff) this.seen.delete(key);
      else break; // Map preserves insertion order and times are non-decreasing.
    }
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
  }
}
