/**
 * GitHub transport tests.
 *
 * The `gh` CLI is replaced with a scripted fake and the git layer is pointed at
 * a local bare repository, so every branch of the GitHub-specific logic runs
 * here with no network, no token and no GitHub account. What remains unproven
 * is the interaction with the real service; that is covered by the manual
 * checklist in docs/testing.md.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StoreTransport, TransportContext } from '@fyrlabs/dead-drop-transport-sdk';

import { githubTransport } from './index.js';
import { isValidRepo, parseRepoJson, type GhClient, type GhRepoInfo } from './gh.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function bareRemote(): Promise<string> {
  const dir = await temp('deaddrop-gh-remote-');
  await execFileAsync('git', ['init', '--bare', '--quiet', '--initial-branch=main', dir]);
  return dir;
}

function context(overrides: Partial<TransportContext> = {}): TransportContext {
  return {
    workspace: 'demo',
    peerId: 'peer-a',
    instance: 'github',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    now: () => Date.now(),
    ...overrides,
  };
}

function fakeGh(overrides: Partial<GhClient> & { url?: string } = {}): GhClient {
  const info: GhRepoInfo = {
    nameWithOwner: 'acme/deaddrop-data',
    url: overrides.url ?? 'https://github.com/acme/deaddrop-data.git',
    isPrivate: true,
    defaultBranch: 'main',
  };
  return {
    authStatus: overrides.authStatus ?? (async () => ({ authenticated: true, message: 'ok' })),
    repoInfo: overrides.repoInfo ?? (async () => info),
    createRepo: overrides.createRepo ?? (async () => info),
    rateLimit: overrides.rateLimit ?? (async () => undefined),
  };
}

async function store(
  gh: GhClient,
  overrides: Partial<Parameters<typeof githubTransport>[0]> = {},
): Promise<StoreTransport> {
  return githubTransport.definition.create(
    {
      repo: 'acme/deaddrop-data',
      workDir: await temp('deaddrop-gh-work-'),
      gh,
      batchWindowMs: 0,
      freshnessMs: 0,
      ...overrides,
    },
    context(),
  ) as StoreTransport;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('github transport', () => {
  it('resolves the repository through gh and moves data over git', async () => {
    const remote = await bareRemote();
    const transport = await store(fakeGh({ url: remote }));

    await transport.put('inbox/peer-b/1.ddf', new TextEncoder().encode('hello github'));
    const read = await transport.get('inbox/peer-b/1.ddf');
    expect(read && Buffer.from(read).toString()).toBe('hello github');
  }, 60_000);

  it('refuses to run when gh is not authenticated', async () => {
    const transport = await store(
      fakeGh({ authStatus: async () => ({ authenticated: false, message: 'not logged in' }) }),
    );
    await expect(transport.get('inbox/peer-b/1.ddf')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(transport.get('inbox/peer-b/1.ddf')).rejects.toThrowError(/gh auth login/);
  });

  it('explains what to do when the repository is missing', async () => {
    const transport = await store(fakeGh({ repoInfo: async () => undefined }));
    await expect(transport.get('inbox/peer-b/1.ddf')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(transport.get('inbox/peer-b/1.ddf')).rejects.toThrowError(/createIfMissing/);
  });

  it('creates the repository privately when asked to', async () => {
    const remote = await bareRemote();
    const created: Array<{ repo: string; private: boolean }> = [];
    const gh = fakeGh({
      repoInfo: async () =>
        created.length === 0
          ? undefined
          : {
              nameWithOwner: 'acme/deaddrop-data',
              url: remote,
              isPrivate: true,
              defaultBranch: 'main',
            },
      createRepo: async (repo, options) => {
        created.push({ repo, private: options.private });
        return {
          nameWithOwner: repo,
          url: remote,
          isPrivate: options.private,
          defaultBranch: 'main',
        };
      },
    });

    const transport = await store(gh, { createIfMissing: true });
    await transport.put('inbox/peer-b/1.ddf', new Uint8Array([1]));
    expect(created).toEqual([{ repo: 'acme/deaddrop-data', private: true }]);
  }, 60_000);

  it('reports the API rate limit and degrades when it runs low', async () => {
    const remote = await bareRemote();
    const healthy = await store(
      fakeGh({
        url: remote,
        rateLimit: async () => ({ limit: 5000, remaining: 4000, resetAt: 0 }),
      }),
    );
    const health = await healthy.health();
    expect(health.rateLimit).toEqual({ limit: 5000, remaining: 4000, resetAt: 0 });
    expect(health.status).toBe('healthy');

    const throttled = await store(
      fakeGh({
        url: remote,
        rateLimit: async () => ({ limit: 5000, remaining: 100, resetAt: 0 }),
      }),
    );
    const low = await throttled.health();
    expect(low.status).toBe('degraded');
    expect(low.message).toMatch(/rate limit/i);
  }, 60_000);

  it('caches the rate limit between health probes', async () => {
    const remote = await bareRemote();
    const rateLimit = vi.fn(async () => ({ limit: 5000, remaining: 4000, resetAt: 0 }));
    const transport = await store(fakeGh({ url: remote, rateLimit }), {
      rateLimitIntervalMs: 600_000,
    });
    await transport.health();
    await transport.health();
    expect(rateLimit).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('reports unavailable rather than throwing when setup fails', async () => {
    const transport = await store(
      fakeGh({ authStatus: async () => ({ authenticated: false, message: 'nope' }) }),
    );
    const health = await transport.health();
    expect(health.status).toBe('unavailable');
    expect(health.message).toMatch(/gh auth login/);
  });

  it('validates configuration', () => {
    expect(() => githubTransport({ repo: 'no-slash', workDir: '/tmp/x' })).toThrowError(
      /owner\/name/,
    );
    expect(() => githubTransport({ repo: 'a/b', workDir: '' })).toThrowError(/workDir/);
    expect(() => githubTransport('nope' as never)).toThrowError(/must be an object/);
    expect(githubTransport({ repo: 'acme/deaddrop', workDir: '/tmp/x' }).config.repo).toBe(
      'acme/deaddrop',
    );
  });
});

describe('gh helpers', () => {
  it('validates owner/name and rejects anything flag-like', () => {
    expect(isValidRepo('acme/deaddrop-data')).toBe(true);
    expect(isValidRepo('acme/deaddrop.data_1')).toBe(true);
    expect(isValidRepo('acme')).toBe(false);
    expect(isValidRepo('--flag/x')).toBe(false);
    expect(isValidRepo('acme/deaddrop; rm -rf /')).toBe(false);
    expect(isValidRepo('acme/../etc')).toBe(false);
  });

  it('parses gh repo view output and tolerates junk', () => {
    expect(
      parseRepoJson(
        JSON.stringify({
          nameWithOwner: 'acme/x',
          url: 'https://github.com/acme/x',
          isPrivate: true,
          defaultBranchRef: { name: 'trunk' },
        }),
      ),
    ).toEqual({
      nameWithOwner: 'acme/x',
      url: 'https://github.com/acme/x',
      isPrivate: true,
      defaultBranch: 'trunk',
    });
    expect(parseRepoJson('{"nameWithOwner":"a/b","url":"u"}')?.defaultBranch).toBe('main');
    expect(parseRepoJson('not json')).toBeUndefined();
    expect(parseRepoJson('{}')).toBeUndefined();
  });
});
