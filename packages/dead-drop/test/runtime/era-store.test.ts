/**
 * Remembering which era a peer seals under, across a restart.
 *
 * The file exists to close two things at once: the window after a restart in
 * which a peer would seal under the secret-derived era again, and the rotation
 * counter, which without this is a property of one process rather than of the
 * peer. Both are stated in `era-store.ts`; the tests below are about the
 * discard rules, which are where a wrong answer is silent.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { generateEraKey } from '@fyrlabs/dead-drop/protocol';
import { createLogger, MemoryLogSink } from '#dead-drop/core/observability/logger.js';
import { loadEra, saveEra } from '#dead-drop/runtime/era-store.js';

const isWindows = process.platform === 'win32';

const dirs: string[] = [];

async function workdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ddrop-era-'));
  dirs.push(dir);
  return dir;
}

const logs = () => {
  const sink = new MemoryLogSink();
  return { sink, logger: createLogger({ level: 'warn', sink: sink.sink }) };
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadEra and saveEra', () => {
  it('round-trips the era and its rotation counter', async () => {
    const path = join(await workdir(), 'demo.era');
    const era = generateEraKey();
    await saveEra(path, { key: era, seq: 4 });

    const loaded = await loadEra(path);
    expect(loaded?.seq).toBe(4);
    expect(loaded?.key.id).toBe(era.id);
    // The material, not just the label: a peer that reloads a different key
    // under the right id seals frames nobody can open.
    expect(loaded?.key.key.export()).toEqual(era.key.export());
  });

  it('reports nothing at all when the file has never been written', async () => {
    expect(await loadEra(join(await workdir(), 'demo.era'))).toBeUndefined();
  });

  // Same platform fact as `identity-store.test.ts` and `control-plane.test.ts`:
  // `writeFile({ mode })` does not narrow permissions on Windows.
  it.skipIf(isWindows)('writes 0600, because it is key material', async () => {
    const path = join(await workdir(), 'demo.era');
    await saveEra(path, { key: generateEraKey(), seq: 1 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('discards a file whose label and material disagree', async () => {
    // The case worth catching: an era id is derived from the key, so a file
    // where they differ has been edited or corrupted and neither half can be
    // trusted. Taking the label would leave this peer sealing under a key id
    // no recipient holds.
    const path = join(await workdir(), 'demo.era');
    const era = generateEraKey();
    await writeFile(
      path,
      JSON.stringify({
        eraId: 'deadbeef',
        seq: 2,
        key: era.key.export().toString('base64url'),
      }),
    );

    const { sink, logger } = logs();
    expect(await loadEra(path, logger)).toBeUndefined();
    expect(sink.find((record) => record.message.includes('unreadable stored era'))).toBeDefined();
  });

  // Each case has to be rejected by the rule it names and by nothing else, so
  // the counter cases carry material and a label that are otherwise valid.
  // A first draft used a one-byte key in them, and they passed against a build
  // with no counter check at all because the key length refused them first.
  const valid = generateEraKey();
  const wellFormed = { eraId: valid.id, key: valid.key.export().toString('base64url') };

  it.each([
    ['not json at all', 'not json'],
    ['a missing key', JSON.stringify({ eraId: 'deadbeef', seq: 1 })],
    ['a negative counter', JSON.stringify({ ...wellFormed, seq: -1 })],
    ['a fractional counter', JSON.stringify({ ...wellFormed, seq: 1.5 })],
    ['a counter that is not a number', JSON.stringify({ ...wellFormed, seq: '2' })],
    ['key material of the wrong length', JSON.stringify({ eraId: 'x', seq: 1, key: 'AAAA' })],
  ])('discards %s rather than failing the start-up', async (_label, body) => {
    const path = join(await workdir(), 'demo.era');
    await writeFile(path, body);
    // Deliberately the opposite of how a corrupt identity is treated. An
    // unreadable identity is unrecoverable and must be loud; an unreadable era
    // costs one enrollment pass to rebuild from the store, so refusing to start
    // over it would trade a real outage for a recoverable inconvenience.
    expect(await loadEra(path, logs().logger)).toBeUndefined();
  });

  it('overwrites the previous era rather than appending to it', async () => {
    const path = join(await workdir(), 'demo.era');
    await saveEra(path, { key: generateEraKey(), seq: 1 });
    const second = generateEraKey();
    await saveEra(path, { key: second, seq: 2 });

    expect((await loadEra(path))?.key.id).toBe(second.id);
    expect(JSON.parse((await readFile(path)).toString('utf8'))).toMatchObject({ seq: 2 });
  });
});
