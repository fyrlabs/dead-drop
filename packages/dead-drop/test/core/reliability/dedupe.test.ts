import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { TestClock } from '#dead-drop/core/clock.js';
import { DedupeStore } from '#dead-drop/core/reliability/dedupe.js';

const dirs: string[] = [];
async function tempFile(name = 'dedupe.json'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'deaddrop-dedupe-'));
  dirs.push(dir);
  return join(dir, name);
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('DedupeStore', () => {
  it('claims a key once', () => {
    const store = new DedupeStore({ clock: new TestClock(0) });
    expect(store.claim('msg-1')).toBe(true);
    expect(store.claim('msg-1')).toBe(false);
    expect(store.has('msg-1')).toBe(true);
    expect(store.size).toBe(1);
  });

  it('forgets entries past the ttl', async () => {
    const clock = new TestClock(0);
    const store = new DedupeStore({ clock, ttlMs: 1000 });
    store.claim('msg-1');
    await clock.advance(500);
    expect(store.has('msg-1')).toBe(true);
    await clock.advance(1500);
    expect(store.has('msg-1')).toBe(false);
    expect(store.claim('msg-1')).toBe(true);
  });

  it('evicts the oldest entries past maxEntries', () => {
    const store = new DedupeStore({ clock: new TestClock(0), maxEntries: 3 });
    for (const key of ['a', 'b', 'c', 'd', 'e']) store.claim(key);
    expect(store.size).toBe(3);
    expect(store.has('a')).toBe(false);
    expect(store.has('e')).toBe(true);
  });

  it('releases a key so a failed handler can be retried', () => {
    const store = new DedupeStore({ clock: new TestClock(0) });
    store.claim('msg-1');
    store.delete('msg-1');
    expect(store.claim('msg-1')).toBe(true);
  });

  it('clears everything', () => {
    const store = new DedupeStore({ clock: new TestClock(0) });
    store.claim('a');
    store.clear();
    expect(store.size).toBe(0);
  });

  it('persists and reloads across processes', async () => {
    const path = await tempFile();
    const clock = new TestClock(1000);
    const first = new DedupeStore({ clock, persistPath: path });
    first.claim('msg-1');
    first.claim('msg-2');
    await first.flush(true);

    const second = new DedupeStore({ clock, persistPath: path });
    await second.load();
    expect(second.has('msg-1')).toBe(true);
    expect(second.claim('msg-2')).toBe(false);
  });

  it('drops persisted entries that are already expired', async () => {
    const path = await tempFile();
    const clock = new TestClock(0);
    const first = new DedupeStore({ clock, persistPath: path, ttlMs: 100 });
    first.claim('old');
    await first.flush(true);

    const later = new TestClock(10_000);
    const second = new DedupeStore({ clock: later, persistPath: path, ttlMs: 100 });
    await second.load();
    expect(second.has('old')).toBe(false);
  });

  it('starts empty when the persisted file is missing or corrupt', async () => {
    const missing = new DedupeStore({ persistPath: await tempFile('nope.json') });
    await missing.load();
    expect(missing.size).toBe(0);

    const path = await tempFile('corrupt.json');
    await writeFile(path, '{not json');
    const corrupt = new DedupeStore({ persistPath: path });
    await corrupt.load();
    expect(corrupt.size).toBe(0);

    const wrongVersion = await tempFile('v2.json');
    await writeFile(wrongVersion, JSON.stringify({ version: 2, entries: [['a', 1]] }));
    const skipped = new DedupeStore({ persistPath: wrongVersion });
    await skipped.load();
    expect(skipped.size).toBe(0);
  });

  it('rate-limits disk writes but honours force', async () => {
    const path = await tempFile();
    const clock = new TestClock(0);
    const store = new DedupeStore({ clock, persistPath: path, flushIntervalMs: 1000 });
    store.claim('a');
    await store.flush(true);
    store.claim('b');
    await store.flush(); // too soon, skipped
    expect(JSON.parse(await readFile(path, 'utf8')).entries).toHaveLength(1);

    await clock.advance(2000);
    await store.flush();
    expect(JSON.parse(await readFile(path, 'utf8')).entries).toHaveLength(2);
  });

  it('is a no-op without a persist path', async () => {
    const store = new DedupeStore({ clock: new TestClock(0) });
    await store.load();
    await store.flush(true);
    expect(store.size).toBe(0);
  });
});
