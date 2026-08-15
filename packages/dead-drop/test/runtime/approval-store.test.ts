/**
 * Where approvals are kept, and what happens when the file is nonsense.
 *
 * The load rules are the interesting half. An approval is the one input to
 * dead-drop that came from a human rather than from a proof, so a file that
 * will not parse must not become "everybody is approved" by accident: under the
 * `requireApproval` tier that would hand the next rotation to whoever the store
 * happens to be serving, which is the thing the tier exists to prevent.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createLogger, MemoryLogSink } from '#dead-drop/core/observability/logger.js';
import { loadApprovals, saveApprovals } from '#dead-drop/runtime/approval-store.js';

const isWindows = process.platform === 'win32';

const dirs: string[] = [];

async function workdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ddrop-approvals-'));
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

describe('loadApprovals and saveApprovals', () => {
  it('round-trips peer ids and the fingerprints approved for them', async () => {
    const path = join(await workdir(), 'demo.approvals.json');
    await saveApprovals(
      path,
      new Map([
        ['peer-b', '1111-2222-3333-4444'],
        ['peer-c', 'aaaa-bbbb-cccc-dddd'],
      ]),
    );

    const loaded = await loadApprovals(path);
    expect(loaded.get('peer-b')).toBe('1111-2222-3333-4444');
    expect(loaded.get('peer-c')).toBe('aaaa-bbbb-cccc-dddd');
    expect(loaded.size).toBe(2);
  });

  it('approves nobody when the file has never been written', async () => {
    const loaded = await loadApprovals(join(await workdir(), 'demo.approvals.json'));
    expect(loaded.size).toBe(0);
  });

  it('approves nobody, and says so, when the file will not parse', async () => {
    const path = join(await workdir(), 'demo.approvals.json');
    await writeFile(path, '{ not json');
    const { sink, logger } = logs();

    expect((await loadApprovals(path, logger)).size).toBe(0);
    // Silence here would be indistinguishable from "nobody has been approved
    // yet", which is a state an operator would wait out rather than repair.
    expect(sink.records.some((record) => record.message.includes('approvals file'))).toBe(true);
  });

  it('drops an entry that does not name a fingerprint, and keeps the rest', async () => {
    // Half-readable is the case that matters: dropping the malformed entry
    // rather than the file keeps every approval a human did make.
    const path = join(await workdir(), 'demo.approvals.json');
    await writeFile(path, JSON.stringify({ 'peer-b': true, 'peer-c': '', 'peer-d': 'aaaa-bbbb' }));

    const loaded = await loadApprovals(path);
    expect([...loaded.keys()]).toEqual(['peer-d']);
  });

  it('approves nobody when the file holds an array rather than an object', async () => {
    const path = join(await workdir(), 'demo.approvals.json');
    await writeFile(path, JSON.stringify(['peer-b']));
    expect((await loadApprovals(path, logs().logger)).size).toBe(0);
  });

  // Same platform fact as `era-store.test.ts`: `writeFile({ mode })` does not
  // narrow permissions on Windows.
  it.skipIf(isWindows)('writes 0600, for consistency with the state beside it', async () => {
    const path = join(await workdir(), 'demo.approvals.json');
    await saveApprovals(path, new Map([['peer-b', '1111-2222-3333-4444']]));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('writes readable json, because a human is expected to check it', async () => {
    const path = join(await workdir(), 'demo.approvals.json');
    await saveApprovals(path, new Map([['peer-b', '1111-2222-3333-4444']]));
    expect((await readFile(path, 'utf8')).trim()).toBe(
      '{\n  "peer-b": "1111-2222-3333-4444"\n}'.trim(),
    );
  });
});
