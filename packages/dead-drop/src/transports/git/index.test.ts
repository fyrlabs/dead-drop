/**
 * Git transport tests.
 *
 * These run against a real `git` binary and a real bare repository on disk, so
 * clone, commit, push, fetch, reset and the push-race path are all genuinely
 * exercised. No network and no credentials are involved: a local bare repo is
 * a perfectly ordinary git remote.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { registerConformanceTests } from '@fyrlabs/dead-drop-transport-sdk/testing';
import type { StoreTransport, TransportContext } from '@fyrlabs/dead-drop-transport-sdk';

import { gitTransport } from './index.js';
import { isNonFastForward, isRetryableGitError, redactUrl } from './git.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Creates a bare repository to act as the shared remote. */
async function bareRemote(): Promise<string> {
  const dir = await temp('deaddrop-git-remote-');
  await execFileAsync('git', ['init', '--bare', '--quiet', '--initial-branch=main', dir]);
  return dir;
}

function context(overrides: Partial<TransportContext> = {}): TransportContext {
  return {
    workspace: 'demo',
    peerId: 'peer-a',
    instance: 'git',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    now: () => Date.now(),
    ...overrides,
  };
}

async function store(
  remote: string,
  overrides: Partial<Parameters<typeof gitTransport>[0]> = {},
  ctx: TransportContext = context(),
): Promise<StoreTransport> {
  return gitTransport.definition.create(
    {
      remote,
      workDir: await temp('deaddrop-git-work-'),
      // Batching is the point in production but makes tests slower to reason
      // about, so collapse the window.
      batchWindowMs: 0,
      freshnessMs: 0,
      ...overrides,
    },
    ctx,
  ) as StoreTransport;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

registerConformanceTests({ describe, it }, 'git', {
  capabilities: gitTransport.definition.capabilities,
  async create() {
    return store(await bareRemote());
  },
});

describe('git transport specifics', () => {
  it('creates an orphan data branch on a fresh remote', async () => {
    const remote = await bareRemote();
    const transport = await store(remote);
    await transport.put('inbox/peer-b/1.ddf', bytes('hello'));

    const branches = await execFileAsync('git', ['branch', '--list'], { cwd: remote });
    expect(branches.stdout).toContain('deaddrop-data');
    // The repository's own main branch is untouched.
    expect(branches.stdout).not.toContain('* main');
  }, 60_000);

  it('shares objects between two clones of the same remote', async () => {
    const remote = await bareRemote();
    const writer = await store(remote);
    const reader = await store(remote);

    await writer.put('inbox/peer-b/1.ddf', bytes('across the wire'));
    const read = await reader.get('inbox/peer-b/1.ddf');
    expect(read && Buffer.from(read).toString()).toBe('across the wire');
  }, 60_000);

  it('propagates a delete to the other clone', async () => {
    const remote = await bareRemote();
    const writer = await store(remote);
    const reader = await store(remote);

    await writer.put('inbox/peer-b/1.ddf', bytes('temporary'));
    expect(await reader.get('inbox/peer-b/1.ddf')).toBeDefined();
    await writer.delete('inbox/peer-b/1.ddf');
    expect(await reader.get('inbox/peer-b/1.ddf')).toBeUndefined();
  }, 60_000);

  it('resolves a push race between two writers without losing either write', async () => {
    const remote = await bareRemote();
    const first = await store(remote);
    const second = await store(remote);

    // Both clones start from the same commit, then write concurrently: exactly
    // the non-fast-forward case the retry loop exists for.
    await Promise.all([
      first.put('inbox/peer-b/from-first.ddf', bytes('first')),
      second.put('inbox/peer-b/from-second.ddf', bytes('second')),
    ]);

    const observer = await store(remote);
    const listed = await observer.list('inbox/peer-b');
    expect(listed.entries.map((entry) => entry.key).sort()).toEqual([
      'inbox/peer-b/from-first.ddf',
      'inbox/peer-b/from-second.ddf',
    ]);
  }, 90_000);

  // Reproducing this needs a fake `git` on PATH that interferes between the
  // commit and the push, and a fake `git` has to be an executable script.
  // Windows cannot spawn one: `execFile` refuses a shell script, and it refuses
  // `.cmd` without a shell. The defect and the fix are platform-independent, so
  // the two Linux jobs carry this one.
  it.skipIf(process.platform === 'win32')(
    'does not report a push as published when the commit never left the clone',
    async () => {
      // Two runtimes sharing one working directory is not hypothetical: `ddrop
      // connect` starts a second runtime from the same config file, so its clone
      // is the running peer's clone. When the other process runs `reset --hard
      // origin/<branch>` between our commit and our push, git answers the push
      // with "Everything up-to-date" and exit 0. Treating that as success
      // resolved the write and dropped the message with no error anywhere; a
      // live GitHub run lost 10 of 50 requests exactly this way.
      const remote = await bareRemote();
      const workDir = await temp('deaddrop-git-shared-');
      const armed = join(workDir, '..', 'reset-armed');

      // Stands in for the other process: it discards the pending commit once,
      // the first time a push is attempted while armed.
      const shim = join(await temp('deaddrop-git-shim-'), 'git-shim.sh');
      await writeFile(
        shim,
        '#!/bin/sh\n' +
          'for arg in "$@"; do\n' +
          `  if [ "$arg" = "push" ] && [ -f "${armed}" ]; then\n` +
          `    rm -f "${armed}"\n` +
          '    git reset --quiet --hard origin/deaddrop-data\n' +
          '    break\n' +
          '  fi\n' +
          'done\n' +
          'exec git "$@"\n',
        { mode: 0o755 },
      );

      const transport = await store(remote, { workDir, gitPath: shim });
      await transport.put('inbox/peer-b/warm.ddf', bytes('warm up'));

      await writeFile(armed, '');
      await transport.put('inbox/peer-b/must-survive.ddf', bytes('must survive'));

      const observer = await store(remote);
      const read = await observer.get('inbox/peer-b/must-survive.ddf');
      expect(read && Buffer.from(read).toString()).toBe('must survive');
    },
    90_000,
  );

  it('gives a second store its own clone instead of sharing a working tree', async () => {
    const remote = await bareRemote();
    const workDir = await temp('deaddrop-git-contended-');

    // Same config, same directory: what `ddrop connect` does to the peer that
    // is already running, since it builds its runtime from the same file.
    const first = await store(remote, { workDir });
    const second = await store(remote, { workDir }, context({ peerId: 'peer-b' }));

    await first.put('inbox/peer-b/from-first.ddf', bytes('first'));
    await second.put('inbox/peer-a/from-second.ddf', bytes('second'));

    // The loser clones beside the directory, never inside it: a clone nested in
    // the working tree would be committed to the data branch by `add --all`.
    const nested = await readdir(workDir);
    expect(nested).not.toContain('.peers');
    const clones = (await readdir(`${workDir}.peers`)).filter((name) => !name.endsWith('.owner'));
    expect(clones).toEqual(['demo-peer-b-git']);

    const observer = await store(remote);
    const listed = await observer.list('inbox');
    expect(listed.entries.map((entry) => entry.key).sort()).toEqual([
      'inbox/peer-a/from-second.ddf',
      'inbox/peer-b/from-first.ddf',
    ]);
  }, 90_000);

  it('keeps the configured directory for a single store, and reclaims it after close', async () => {
    const remote = await bareRemote();
    const workDir = await temp('deaddrop-git-solo-');

    const first = await store(remote, { workDir });
    await first.put('inbox/peer-b/1.ddf', bytes('one'));
    // No fallback directory: the ordinary setup is laid out exactly as before.
    expect(await readdir(`${workDir}.peers`).catch(() => undefined)).toBeUndefined();
    await first.close();

    // A restart takes the directory back rather than piling up clones.
    const second = await store(remote, { workDir });
    await second.put('inbox/peer-b/2.ddf', bytes('two'));
    expect(await readdir(`${workDir}.peers`).catch(() => undefined)).toBeUndefined();
  }, 90_000);

  it('batches concurrent writes into a single commit', async () => {
    const remote = await bareRemote();
    const transport = await store(remote, { batchWindowMs: 20 });
    await transport.put('inbox/peer-b/warm.ddf', bytes('warm up'));

    const before = await commitCount(remote);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        transport.put(`inbox/peer-b/batch-${i}.ddf`, bytes(`payload ${i}`)),
      ),
    );
    const after = await commitCount(remote);

    // Eight writes must not cost eight pushes; that is the whole reason the
    // batching queue exists.
    expect(after - before).toBeLessThan(8);
    const listed = await transport.list('inbox/peer-b');
    expect(listed.entries).toHaveLength(9);
  }, 90_000);

  it('isolates workspaces that share one repository through a prefix', async () => {
    const remote = await bareRemote();
    const alpha = await store(remote, { prefix: 'alpha' });
    const beta = await store(remote, { prefix: 'beta' });

    await alpha.put('inbox/peer-b/1.ddf', bytes('alpha data'));
    await beta.put('inbox/peer-b/1.ddf', bytes('beta data'));

    expect(Buffer.from((await alpha.get('inbox/peer-b/1.ddf'))!).toString()).toBe('alpha data');
    expect(Buffer.from((await beta.get('inbox/peer-b/1.ddf'))!).toString()).toBe('beta data');
  }, 90_000);

  it('reuses an existing clone and repoints a changed remote', async () => {
    const remote = await bareRemote();
    const workDir = await temp('deaddrop-git-reuse-');
    const first = (await gitTransport.definition.create(
      { remote, workDir, batchWindowMs: 0, freshnessMs: 0 },
      context(),
    )) as StoreTransport;
    await first.put('inbox/peer-b/1.ddf', bytes('kept'));
    await first.close();

    const second = (await gitTransport.definition.create(
      { remote, workDir, batchWindowMs: 0, freshnessMs: 0 },
      context(),
    )) as StoreTransport;
    expect(await second.get('inbox/peer-b/1.ddf')).toBeDefined();
  }, 60_000);

  it('reports healthy against a reachable remote and unavailable otherwise', async () => {
    const transport = await store(await bareRemote());
    expect((await transport.health()).status).toBe('healthy');

    const broken = await store(join(tmpdir(), 'definitely-not-a-repo-12345'));
    const health = await broken.health();
    expect(health.status).toBe('unavailable');
    expect(health.message).toBeDefined();
  }, 60_000);

  it('refuses objects larger than the git blob limit', async () => {
    const transport = await store(await bareRemote());
    await expect(
      transport.put('inbox/peer-b/huge.ddf', new Uint8Array(41 * 1024 * 1024)),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  }, 60_000);

  it('keeps the README marker out of listings', async () => {
    const remote = await bareRemote();
    const transport = await store(remote);
    await transport.put('inbox/peer-b/1.ddf', bytes('x'));
    const listed = await transport.list('');
    expect(listed.entries.map((entry) => entry.key)).toEqual(['inbox/peer-b/1.ddf']);
  }, 60_000);

  it('writes objects the operator can actually find in the repository', async () => {
    const remote = await bareRemote();
    const transport = await store(remote, { workDir: await temp('deaddrop-git-inspect-') });
    await transport.put('inbox/peer-b/1.ddf', bytes('x'));

    const inspect = await temp('deaddrop-git-clone-');
    await execFileAsync('git', ['clone', '--quiet', '--branch', 'deaddrop-data', remote, inspect]);
    const entries = await readdir(join(inspect, 'inbox', 'peer-b'));
    expect(entries).toContain('1.ddf');
  }, 60_000);

  it('validates configuration', () => {
    expect(() => gitTransport({ remote: '', workDir: '/tmp/x' })).toThrowError(/requires "remote"/);
    expect(() => gitTransport({ remote: 'x', workDir: '' })).toThrowError(/requires "workDir"/);
    expect(() =>
      gitTransport({ remote: 'x', workDir: '/tmp/x', branch: 'bad branch' }),
    ).toThrowError(/branch name is invalid/);
    expect(() => gitTransport('nope' as never)).toThrowError(/must be an object/);
  });
});

describe('git helpers', () => {
  it('classifies retryable transport errors', () => {
    expect(isRetryableGitError('fatal: unable to access https://x: Could not resolve host')).toBe(
      true,
    );
    expect(isRetryableGitError('error: RPC failed; curl 92')).toBe(true);
    expect(isRetryableGitError('fatal: Authentication failed')).toBe(false);
  });

  it('detects a lost push race', () => {
    expect(isNonFastForward('! [rejected] main -> main (non-fast-forward)')).toBe(true);
    expect(isNonFastForward('hint: Updates were rejected because the remote contains work')).toBe(
      true,
    );
    expect(isNonFastForward('everything up-to-date')).toBe(false);
  });

  it('strips inline credentials from remote urls', () => {
    expect(redactUrl('https://user:ghp_secrettoken@github.com/a/b.git')).toBe(
      'https://[redacted]@github.com/a/b.git',
    );
    expect(redactUrl('git@github.com:a/b.git')).toBe('git@github.com:a/b.git');
  });
});

async function commitCount(remote: string): Promise<number> {
  const result = await execFileAsync('git', ['rev-list', '--count', 'deaddrop-data'], {
    cwd: remote,
  }).catch(() => ({ stdout: '0' }));
  return Number(result.stdout.trim());
}
