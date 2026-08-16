/**
 * Git transport tests.
 *
 * These run against a real `git` binary and a real bare repository on disk, so
 * clone, commit, push, fetch, reset and the push-race path are all genuinely
 * exercised. No network and no credentials are involved: a local bare repo is
 * a perfectly ordinary git remote.
 */

import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { registerConformanceTests } from '@fyrlabs/dead-drop-transport-sdk/testing';
import type { StoreTransport, TransportContext } from '@fyrlabs/dead-drop-transport-sdk';

import { gitTransport } from '#dead-drop/transports/git/index.js';
import { isNonFastForward, isRetryableGitError, redactUrl } from '#dead-drop/transports/git/git.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const opened: StoreTransport[] = [];

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
  const created = gitTransport.definition.create(
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
  opened.push(created);
  return created;
}

afterEach(async () => {
  // Close before deleting, or the directory is removed out from under git.
  // A resolved `put` does not mean the store is idle: compaction deliberately
  // runs *after* the write resolves, so the caller never waits on housekeeping,
  // and it is still shelling out to git when the test body ends. `close` is
  // what waits for the flush lock, and deleting `.git/objects` while git is
  // writing into it fails with ENOTEMPTY, intermittently and only sometimes.
  await Promise.all(opened.splice(0).map((transport) => transport.close().catch(() => undefined)));
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
  it('recovers from a clone that failed once', async () => {
    // The clone is memoised so concurrent callers do not each run it. Memoising
    // the *rejection* is what made a transient failure permanent: one
    // unreachable remote at start-up and every later put, get, list and health
    // probe re-threw that same error for the life of the process, so the
    // circuit breaker in front of it could never close -- its half-open probe
    // came straight back here and got the cached failure. The retry also has to
    // survive the working-directory lock the failed attempt already took.
    const parent = await temp('deaddrop-git-late-');
    const remote = join(parent, 'remote.git');
    const transport = await store(remote);

    await expect(transport.put('inbox/peer-b/1.ddf', bytes('first'))).rejects.toMatchObject({
      code: 'TRANSPORT_ERROR',
    });

    await execFileAsync('git', ['init', '--bare', '--quiet', '--initial-branch=main', remote]);

    await transport.put('inbox/peer-b/1.ddf', bytes('second'));
    const read = await transport.get('inbox/peer-b/1.ddf');
    expect(read && Buffer.from(read).toString()).toBe('second');
  }, 60_000);

  it('creates an orphan data branch on a fresh remote', async () => {
    const remote = await bareRemote();
    const transport = await store(remote);
    await transport.put('inbox/peer-b/1.ddf', bytes('hello'));

    const branches = await execFileAsync('git', ['branch', '--list'], { cwd: remote });
    expect(branches.stdout).toContain('deaddrop-data');
    // The repository's own main branch is untouched.
    expect(branches.stdout).not.toContain('* main');
  }, 60_000);

  // `authorName` and `authorEmail` had no test of any kind and no e2e scenario
  // set them, which is how a field ends up documented and inert. Read back off
  // the remote rather than out of the local clone, because what a reader of the
  // repository sees is the assertion, and asserting the local `git config`
  // would pass against a transport that set the identity and never used it.
  it('commits under the configured author, and its own name when none is given', async () => {
    const remote = await bareRemote();
    const named = await store(remote, {
      authorName: 'Release Bot',
      authorEmail: 'bot@example.com',
    });
    await named.put('inbox/peer-b/1.ddf', bytes('signed'));

    const log = await execFileAsync('git', ['log', '-1', '--format=%an <%ae>', 'deaddrop-data'], {
      cwd: remote,
    });
    expect(log.stdout.trim()).toBe('Release Bot <bot@example.com>');

    // The default matters as much as the override: without one, git falls back
    // to the machine's own `user.email`, and every object this transport writes
    // would carry the operator's personal address into a repository their peers
    // can read.
    const plainRemote = await bareRemote();
    const defaulted = await store(plainRemote);
    await defaulted.put('inbox/peer-b/1.ddf', bytes('unsigned'));

    const plainLog = await execFileAsync(
      'git',
      ['log', '-1', '--format=%an <%ae>', 'deaddrop-data'],
      { cwd: plainRemote },
    );
    expect(plainLog.stdout.trim()).toBe('dead-drop Runtime <ddrop@localhost>');
  }, 60_000);

  it('does not hijack a repository that encloses its workDir', async () => {
    // `git rev-parse --git-dir` succeeds from inside *any* enclosing repository,
    // so a workDir nested in the user's own project used to be read as this
    // store's clone. The transport then repointed that project's `origin`,
    // rewrote its commit identity and checked out an orphan branch over the
    // user's work. Reachable from the documented quick start, which suggests a
    // relative `workDir` and is run inside a checkout.
    const outer = await temp('deaddrop-git-outer-');
    const inOuter = (args: string[]) => execFileAsync('git', args, { cwd: outer });
    await execFileAsync('git', ['init', '--quiet', '--initial-branch=main', outer]);
    await inOuter(['config', 'user.name', 'Outer Author']);
    await inOuter(['config', 'user.email', 'outer@example.com']);
    await inOuter(['remote', 'add', 'origin', 'git@example.com:outer/project.git']);
    await writeFile(join(outer, 'source.txt'), 'work that must survive\n');
    await inOuter(['add', '--', 'source.txt']);
    await inOuter(['commit', '--quiet', '-m', 'initial']);
    const headBefore = (await inOuter(['rev-parse', 'HEAD'])).stdout.trim();

    const transport = await store(await bareRemote(), {
      workDir: join(outer, '.deaddrop', 'git-work'),
    });
    await transport.put('inbox/peer-b/1.ddf', bytes('nested but harmless'));

    expect((await inOuter(['remote', 'get-url', 'origin'])).stdout.trim()).toBe(
      'git@example.com:outer/project.git',
    );
    expect((await inOuter(['symbolic-ref', 'HEAD'])).stdout.trim()).toBe('refs/heads/main');
    expect((await inOuter(['rev-parse', 'HEAD'])).stdout.trim()).toBe(headBefore);
    expect((await inOuter(['config', 'user.email'])).stdout.trim()).toBe('outer@example.com');
    expect((await inOuter(['branch', '--list'])).stdout).not.toContain('deaddrop-data');

    // The store is still a working clone in its own right, in its own directory.
    const read = await transport.get('inbox/peer-b/1.ddf');
    expect(read && Buffer.from(read).toString()).toBe('nested but harmless');
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

describe('data branch compaction', () => {
  it('keeps the history bounded by the threshold, and every live object', async () => {
    const remote = await bareRemote();
    const transport = await store(remote, { compactAfterCommits: 5 });

    for (let i = 0; i < 10; i++) {
      await transport.put(`inbox/peer-b/${i}.ddf`, bytes(`payload ${i}`));
    }

    // Uncompacted this is 11 commits: the branch marker plus one per write.
    // The threshold is the rule being asserted, not the resulting number.
    expect(await commitCount(remote)).toBeLessThanOrEqual(5);
    const listed = await transport.list('inbox/peer-b');
    expect(listed.entries).toHaveLength(10);
    expect(Buffer.from((await transport.get('inbox/peer-b/0.ddf'))!).toString()).toBe('payload 0');
  }, 120_000);

  it('drops an object the branch no longer holds, rather than resurrecting it', async () => {
    const remote = await bareRemote();
    const transport = await store(remote, { compactAfterCommits: 3 });

    await transport.put('inbox/peer-b/gone.ddf', bytes('delivered'));
    await transport.delete('inbox/peer-b/gone.ddf');
    for (let i = 0; i < 6; i++) {
      await transport.put(`inbox/peer-b/${i}.ddf`, bytes(`payload ${i}`));
    }

    // Compaction snapshots the tree, so a delete stays a delete. Snapshotting
    // anything else would hand a delivered message back to the mailbox.
    expect(await transport.get('inbox/peer-b/gone.ddf')).toBeUndefined();
  }, 120_000);

  it('never compacts when it is switched off', async () => {
    const remote = await bareRemote();
    const transport = await store(remote, { compactAfterCommits: 0 });

    for (let i = 0; i < 10; i++) {
      await transport.put(`inbox/peer-b/${i}.ddf`, bytes(`payload ${i}`));
    }

    expect(await commitCount(remote)).toBe(11);
  }, 120_000);

  it('leaves a peer holding the replaced history able to read and write', async () => {
    const remote = await bareRemote();
    const alpha = await store(remote, { compactAfterCommits: 4 });
    const beta = await store(remote);

    await alpha.put('inbox/peer-b/first.ddf', bytes('first'));
    // beta clones the pre-compaction history and holds it.
    expect(Buffer.from((await beta.get('inbox/peer-b/first.ddf'))!).toString()).toBe('first');

    for (let i = 0; i < 8; i++) await alpha.put(`inbox/peer-b/${i}.ddf`, bytes(`payload ${i}`));
    expect(await commitCount(remote)).toBeLessThanOrEqual(4);

    // beta's history is now unreachable on the remote, and beta needs no repair
    // code to survive that: `sync` is a fetch plus a hard reset, and a hard
    // reset adopts an unrelated history as readily as a descendant one.
    expect(Buffer.from((await beta.get('inbox/peer-b/first.ddf'))!).toString()).toBe('first');
    await beta.put('inbox/peer-b/after.ddf', bytes('after'));
    expect(Buffer.from((await alpha.get('inbox/peer-b/after.ddf'))!).toString()).toBe('after');
  }, 120_000);

  it('preserves a workspace sharing the branch under another prefix', async () => {
    const remote = await bareRemote();
    const alpha = await store(remote, { prefix: 'alpha', compactAfterCommits: 4 });
    const beta = await store(remote, { prefix: 'beta' });

    await beta.put('inbox/peer-b/keep.ddf', bytes('beta data'));
    for (let i = 0; i < 8; i++) await alpha.put(`inbox/peer-b/${i}.ddf`, bytes(`payload ${i}`));
    expect(await commitCount(remote)).toBeLessThanOrEqual(4);

    // alpha compacts the whole branch tree, never its own prefix subtree, or it
    // would drop every other workspace in the repository on the floor.
    expect(Buffer.from((await beta.get('inbox/peer-b/keep.ddf'))!).toString()).toBe('beta data');
  }, 120_000);

  // Needs an executable wrapper script, so it cannot run on Windows. The
  // property it guards is platform-independent, and CI covers it everywhere else.
  it.skipIf(process.platform === 'win32')(
    'refuses to compact over a write that landed after its snapshot',
    async () => {
      const remote = await bareRemote();
      const transport = await store(remote, { compactAfterCommits: 4 });
      await transport.put('inbox/peer-b/first.ddf', bytes('first'));

      // A second clone, standing in for a peer that writes in the window
      // between the snapshot and the compaction push.
      const side = await temp('deaddrop-git-side-');
      await execFileAsync('git', ['init', '--quiet', side]);
      await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: side });
      await execFileAsync('git', ['fetch', '--quiet', 'origin', 'deaddrop-data'], { cwd: side });
      await execFileAsync('git', ['checkout', '--quiet', '-B', 'deaddrop-data', 'origin/deaddrop-data', '--'], { cwd: side }); // prettier-ignore
      await execFileAsync('git', ['config', 'user.email', 'side@localhost'], { cwd: side });
      await execFileAsync('git', ['config', 'user.name', 'side'], { cwd: side });

      // A git that lands that peer's commit on the first `commit-tree` it sees,
      // which is the one command only compaction runs.
      // Both live in a directory the suite cleans up. A fire-once flag written
      // anywhere longer-lived makes the *second* run of this test a no-op.
      const wrapDir = await temp('deaddrop-git-wrap-');
      const fired = join(wrapDir, 'race-fired');
      const wrapper = join(wrapDir, 'git-racing.cjs');
      await writeFile(
        wrapper,
        `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'commit-tree' && !fs.existsSync(${JSON.stringify(fired)})) {
  fs.writeFileSync(${JSON.stringify(fired)}, 'fired');
  const side = ${JSON.stringify(side)};
  // Catch up first: the store has pushed since this clone was made, and a
  // stale peer's write would be refused for the ordinary reason instead.
  spawnSync('git', ['fetch', '--quiet', 'origin', 'deaddrop-data'], { cwd: side });
  spawnSync('git', ['reset', '--quiet', '--hard', 'origin/deaddrop-data'], { cwd: side });
  fs.writeFileSync(side + '/raced.ddf', 'a message written in the window');
  spawnSync('git', ['add', '--all', '--', '.'], { cwd: side });
  spawnSync('git', ['commit', '--quiet', '-m', 'ddrop: 1 object'], { cwd: side });
  const push = spawnSync('git', ['push', '--quiet', 'origin', 'HEAD:deaddrop-data'], { cwd: side });
  fs.writeFileSync(${JSON.stringify(fired)} + '.code', String(push.status));
}
const r = spawnSync('git', args, { encoding: 'utf8' });
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
process.exit(r.status === null ? 1 : r.status);
`,
      );
      await chmod(wrapper, 0o755);

      const racing = await store(remote, { compactAfterCommits: 4, gitPath: wrapper });
      for (let i = 0; i < 6; i++) await racing.put(`inbox/peer-b/${i}.ddf`, bytes(`payload ${i}`));

      // Without this the test could pass by never racing at all.
      expect(await readFile(`${fired}.code`, 'utf8').catch(() => 'never fired')).toBe('0');

      // The lease carries the tip the tree was read from, so a branch that
      // moved in the window refuses the push. With a bare `--force-with-lease`
      // or a plain `--force`, the raced message is destroyed instead: this
      // assertion is the whole reason the expected value is spelled out.
      const survived = await execFileAsync('git', ['cat-file', '-e', 'deaddrop-data:raced.ddf'], {
        cwd: remote,
      }).then(
        () => true,
        () => false,
      );
      expect(survived).toBe(true);
      // The branch is left exactly as it was, which is a state that works.
      expect(await commitCount(remote)).toBeGreaterThan(1);
      expect(Buffer.from((await racing.get('inbox/peer-b/0.ddf'))!).toString()).toBe('payload 0');
    },
    120_000,
  );
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
