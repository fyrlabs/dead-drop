import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_DATA_DIR,
  expandEnv,
  loadRuntimeConfig,
  parseRuntimeConfig,
} from '#dead-drop/runtime/config.js';
import {
  BUILT_IN,
  extractDefinition,
  loadTransport,
  resolveSpecifier,
} from '#dead-drop/runtime/plugins.js';
import { resolveWithinRoot, statusForError } from '#dead-drop/runtime/exposure.js';
import { memoryTransport } from '#dead-drop/transports/memory/index.js';
import { DeadDropError } from '#dead-drop/protocol/index.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const valid = {
  workspaces: [
    {
      name: 'demo',
      secrets: ['ddk1_' + 'A'.repeat(43)],
      transports: [{ use: 'memory' }],
    },
  ],
};

describe('expandEnv', () => {
  it('substitutes referenced variables', () => {
    expect(expandEnv('${env:FOO}/x', { FOO: 'bar' })).toBe('bar/x');
    expect(expandEnv('no references', {})).toBe('no references');
  });

  it('fails loudly on an unset variable rather than silently emptying it', () => {
    expect(() => expandEnv('${env:MISSING}', {})).toThrowError(
      /unset environment variable MISSING/,
    );
  });
});

describe('${file:...} references', () => {
  async function withSecretFile(contents: string): Promise<{ dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'deaddrop-config-file-'));
    dirs.push(dir);
    await writeFile(join(dir, 'secret'), contents);
    return { dir };
  }

  it('reads a secret from beside the config instead of the environment', async () => {
    const secret = 'ddk1_' + 'B'.repeat(43);
    const { dir } = await withSecretFile(`${secret}\n`);
    const config = parseRuntimeConfig(
      {
        workspaces: [
          { name: 'demo', secrets: ['${file:secret}'], transports: [{ use: 'memory' }] },
        ],
      },
      { baseDir: dir },
    );
    // Trailing newline stripped: a shell redirect or an editor adds one, and a
    // key with a newline on the end is not the key.
    expect(config.workspaces[0]?.secrets).toEqual([secret]);
  });

  it('names the path it could not read rather than failing later as a bad key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deaddrop-config-file-'));
    dirs.push(dir);
    expect(() =>
      parseRuntimeConfig(
        {
          workspaces: [
            { name: 'demo', secrets: ['${file:missing}'], transports: [{ use: 'memory' }] },
          ],
        },
        { baseDir: dir },
      ),
    ).toThrowError(/missing, which could not be read/);
  });

  it('does not rescan what a reference expanded to', async () => {
    // A secret file whose contents look like another reference is data, not a
    // second lookup. One pass is what guarantees that.
    const { dir } = await withSecretFile('${env:SHOULD_NOT_EXPAND}');
    const config = parseRuntimeConfig(
      {
        workspaces: [
          {
            name: 'demo',
            secrets: ['x'],
            transports: [{ use: 'memory', config: { note: '${file:secret}' } }],
          },
        ],
      },
      { baseDir: dir, env: {} },
    );
    expect((config.workspaces[0]?.transports[0]?.config as { note: string }).note).toBe(
      '${env:SHOULD_NOT_EXPAND}',
    );
  });
});

describe('placeholders left by ddrop init', () => {
  it('fails at load, naming the field, rather than starting a peer nobody can reach', () => {
    expect(() =>
      parseRuntimeConfig({
        workspaces: [
          {
            name: 'demo',
            secrets: ['ddk1_' + 'A'.repeat(43)],
            transports: [{ use: 'filesystem', config: { root: 'REPLACE-ME (a folder)' } }],
          },
        ],
      }),
    ).toThrowError(
      /config\.workspaces\[0\]\.transports\[0\]\.config\.root is still the placeholder/,
    );
  });
});

describe('parseRuntimeConfig', () => {
  it('accepts a minimal config and applies defaults', () => {
    const config = parseRuntimeConfig(valid);
    expect(config.dataDir).toBe(DEFAULT_DATA_DIR);
    expect(config.logLevel).toBe('info');
    expect(config.workspaces[0]?.name).toBe('demo');
  });

  it('expands environment references anywhere in the tree', () => {
    const config = parseRuntimeConfig(
      {
        workspaces: [
          {
            name: 'demo',
            secrets: ['${env:DEADDROP_SECRET}'],
            transports: [{ use: 'filesystem', config: { root: '${env:STORE}' } }],
          },
        ],
      },
      { env: { DEADDROP_SECRET: 'ddk1_secret', STORE: '/srv/store' } },
    );
    expect(config.workspaces[0]?.secrets).toEqual(['ddk1_secret']);
    expect((config.workspaces[0]?.transports[0]?.config as { root: string }).root).toBe(
      '/srv/store',
    );
  });

  it('resolves relative paths against the config directory', () => {
    const config = parseRuntimeConfig(
      {
        dataDir: 'state',
        workspaces: [
          {
            name: 'demo',
            secrets: ['s'],
            transports: [{ use: 'filesystem', config: { root: './store' } }],
            exposures: [{ name: 'site', type: 'static', directory: './public' }],
          },
        ],
      },
      { baseDir: '/srv/project' },
    );
    expect(config.dataDir).toBe(resolve('/srv/project/state'));
    expect((config.workspaces[0]?.transports[0]?.config as { root: string }).root).toBe(
      resolve('/srv/project/store'),
    );
    expect(config.workspaces[0]?.exposures?.[0]?.directory).toBe(resolve('/srv/project/public'));
  });

  // A config file is not a shell, so `~` would otherwise resolve to a literal
  // directory named "~" next to the config: wrong, and silently so.
  it('expands a leading ~ to the home directory', () => {
    const config = parseRuntimeConfig(
      {
        dataDir: '~/.deaddrop',
        controlSocket: '~/run/deaddrop.sock',
        workspaces: [
          {
            name: 'demo',
            secrets: ['s'],
            transports: [{ use: 'filesystem', config: { root: '~/shared/store' } }],
            exposures: [{ name: 'site', type: 'static', directory: '~/public' }],
          },
        ],
      },
      { baseDir: '/srv/project' },
    );
    expect(config.dataDir).toBe(resolve(homedir(), '.deaddrop'));
    expect(config.controlSocket).toBe(resolve(homedir(), 'run/deaddrop.sock'));
    expect((config.workspaces[0]?.transports[0]?.config as { root: string }).root).toBe(
      resolve(homedir(), 'shared/store'),
    );
    expect(config.workspaces[0]?.exposures?.[0]?.directory).toBe(resolve(homedir(), 'public'));
  });

  it('carries retry and breaker tuning through to the workspace', () => {
    const config = parseRuntimeConfig({
      workspaces: [
        {
          ...valid.workspaces[0],
          retry: { maxAttempts: 2, initialDelayMs: 50, jitter: 'none' },
          breaker: { resetTimeoutMs: 1000, failureThreshold: 2 },
        },
      ],
    });
    expect(config.workspaces[0]?.retry).toEqual({
      maxAttempts: 2,
      initialDelayMs: 50,
      jitter: 'none',
    });
    expect(config.workspaces[0]?.breaker).toEqual({ resetTimeoutMs: 1000, failureThreshold: 2 });
  });

  it('carries the health sweep interval through to the workspace', () => {
    const config = parseRuntimeConfig({
      workspaces: [{ ...valid.workspaces[0], healthIntervalMs: 1000 }],
    });
    expect(config.workspaces[0]?.healthIntervalMs).toBe(1000);
  });

  it('carries the presence beacon interval through to the workspace', () => {
    const config = parseRuntimeConfig({
      workspaces: [{ ...valid.workspaces[0], presenceIntervalMs: 5000 }],
    });
    expect(config.workspaces[0]?.presenceIntervalMs).toBe(5000);
  });

  it('carries the orphaned-inbox window through to the workspace', () => {
    const config = parseRuntimeConfig({
      workspaces: [{ ...valid.workspaces[0], inboxOrphanMs: 86_400_000 }],
    });
    expect(config.workspaces[0]?.inboxOrphanMs).toBe(86_400_000);
  });

  it('accepts an orphaned-inbox window of zero, which turns reaping off', () => {
    // Zero is a real setting here, unlike every interval beside it: it is how a
    // deployment says it would rather leak storage than ever lose late mail.
    const config = parseRuntimeConfig({
      workspaces: [{ ...valid.workspaces[0], inboxOrphanMs: 0 }],
    });
    expect(config.workspaces[0]?.inboxOrphanMs).toBe(0);
  });

  it('carries delivery concurrency through to the workspace', () => {
    const config = parseRuntimeConfig({
      workspaces: [{ ...valid.workspaces[0], concurrency: 4 }],
    });
    expect(config.workspaces[0]?.concurrency).toBe(4);
  });

  it('leaves concurrency unset so the mailbox default of 1 applies', () => {
    const config = parseRuntimeConfig(valid);
    expect(config.workspaces[0]?.concurrency).toBeUndefined();
  });

  const rejections: Array<[string, unknown, RegExp]> = [
    ['a non-object', 'nope', /must be a JSON object/],
    // These are the numbers reached for when something is timing out. A typo
    // that silently fell back to the default would be indistinguishable from
    // the knob not working at all.
    [
      'a retry option that is not a number',
      { workspaces: [{ ...valid.workspaces[0], retry: { maxAttempts: '5' } }] },
      /retry\.maxAttempts must be a number greater than zero/,
    ],
    [
      'a misspelled retry option',
      { workspaces: [{ ...valid.workspaces[0], retry: { maxAttempt: 5 } }] },
      /retry\.maxAttempt is not a known option/,
    ],
    [
      'a jitter mode that does not exist',
      { workspaces: [{ ...valid.workspaces[0], retry: { jitter: 'chaotic' } }] },
      /retry\.jitter must be one of none, full, equal/,
    ],
    [
      'a breaker threshold of zero, which would trip on nothing',
      { workspaces: [{ ...valid.workspaces[0], breaker: { failureThreshold: 0 } }] },
      /breaker\.failureThreshold must be a number greater than zero/,
    ],
    [
      'a presence interval of zero, which would beacon forever',
      { workspaces: [{ ...valid.workspaces[0], presenceIntervalMs: 0 }] },
      /presenceIntervalMs must be a positive number/,
    ],
    [
      'a negative orphan window, which would reap every message on sight',
      { workspaces: [{ ...valid.workspaces[0], inboxOrphanMs: -1 }] },
      /inboxOrphanMs must be zero or a positive number/,
    ],
    [
      'a health interval of zero, which would sweep forever',
      { workspaces: [{ ...valid.workspaces[0], healthIntervalMs: 0 }] },
      /healthIntervalMs must be a positive number/,
    ],
    [
      'a concurrency of zero, which would deliver nothing',
      { workspaces: [{ ...valid.workspaces[0], concurrency: 0 }] },
      /concurrency must be a whole number of at least 1/,
    ],
    [
      'a fractional concurrency',
      { workspaces: [{ ...valid.workspaces[0], concurrency: 2.5 }] },
      /concurrency must be a whole number of at least 1/,
    ],
    ['no workspaces', { workspaces: [] }, /at least one workspace/],
    ['a bad log level', { ...valid, logLevel: 'loud' }, /logLevel must be/],
    [
      'a duplicate workspace name',
      { workspaces: [valid.workspaces[0], valid.workspaces[0]] },
      /duplicate workspace name/,
    ],
    [
      'a workspace name with a slash',
      { workspaces: [{ ...valid.workspaces[0], name: 'a/b' }] },
      /name must be alphanumeric/,
    ],
    [
      'no secrets',
      { workspaces: [{ ...valid.workspaces[0], secrets: [] }] },
      /at least one secret/,
    ],
    [
      'no transports',
      { workspaces: [{ ...valid.workspaces[0], transports: [] }] },
      /at least one transport/,
    ],
    [
      'a transport without use',
      { workspaces: [{ ...valid.workspaces[0], transports: [{}] }] },
      /needs a "use" specifier/,
    ],
    [
      'an http exposure without a target',
      {
        workspaces: [{ ...valid.workspaces[0], exposures: [{ name: 'api', type: 'http' }] }],
      },
      /need a "target" url/,
    ],
    [
      'an exposure target that is not a url',
      {
        workspaces: [
          { ...valid.workspaces[0], exposures: [{ name: 'api', type: 'http', target: 'nope' }] },
        ],
      },
      /must be an absolute url/,
    ],
    [
      'an exposure target with a non-http scheme',
      {
        workspaces: [
          {
            ...valid.workspaces[0],
            exposures: [{ name: 'api', type: 'http', target: 'file:///etc/passwd' }],
          },
        ],
      },
      /must be http or https/,
    ],
    [
      'a static exposure without a directory',
      {
        workspaces: [{ ...valid.workspaces[0], exposures: [{ name: 'site', type: 'static' }] }],
      },
      /need a "directory"/,
    ],
    [
      'an unknown exposure type',
      {
        workspaces: [{ ...valid.workspaces[0], exposures: [{ name: 'x', type: 'ftp' }] }],
      },
      /must be "http" or "static"/,
    ],
    [
      'a negative request timeout',
      { workspaces: [{ ...valid.workspaces[0], requestTimeoutMs: -1 }] },
      /positive number/,
    ],
    [
      'an unknown policy mode',
      { workspaces: [{ ...valid.workspaces[0], policy: { mode: 'random' } }] },
      /policy.mode must be/,
    ],
    // `polling` and `policy` were checked for shape and then trusted, which is
    // the one place this parser did not hold to its own standard: a mistyped
    // knob failed somewhere else later, or silently did nothing.
    [
      'a polling interval that is not a number',
      { workspaces: [{ ...valid.workspaces[0], polling: { minIntervalMs: '250' } }] },
      /polling.minIntervalMs must be a number/,
    ],
    [
      'a misspelled polling option',
      { workspaces: [{ ...valid.workspaces[0], polling: { intervalMs: 250 } }] },
      /polling.intervalMs is not a known option/,
    ],
    [
      'a polling minimum above its maximum',
      {
        workspaces: [
          { ...valid.workspaces[0], polling: { minIntervalMs: 15_000, maxIntervalMs: 250 } },
        ],
      },
      /must not be greater than polling.maxIntervalMs/,
    ],
    [
      'a policy primary that is not a transport name',
      { workspaces: [{ ...valid.workspaces[0], policy: { primary: 7 } }] },
      /policy.primary must be a transport name/,
    ],
    [
      'a policy fallback that is not an array',
      { workspaces: [{ ...valid.workspaces[0], policy: { fallback: 'other' } }] },
      /policy.fallback must be an array/,
    ],
    [
      'a policy fallback holding something that is not a name',
      { workspaces: [{ ...valid.workspaces[0], policy: { fallback: ['a', 3] } }] },
      /policy.fallback must contain only transport names/,
    ],
    [
      'a misspelled policy option',
      { workspaces: [{ ...valid.workspaces[0], policy: { primaries: 'a' } }] },
      /policy.primaries is not a known option/,
    ],
  ];

  it.each(rejections)('rejects %s', (_label, input, pattern) => {
    expect(() => parseRuntimeConfig(input)).toThrowError(pattern);
  });
});

describe('loadRuntimeConfig', () => {
  it('reads and parses a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deaddrop-config-'));
    dirs.push(dir);
    const path = join(dir, 'deaddrop.config.json');
    await writeFile(path, JSON.stringify(valid));
    const config = await loadRuntimeConfig(path);
    expect(config.workspaces[0]?.name).toBe('demo');
  });

  it('reports a missing or malformed file clearly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deaddrop-config-'));
    dirs.push(dir);
    await expect(loadRuntimeConfig(join(dir, 'nope.json'))).rejects.toThrowError(/cannot read/);
    const broken = join(dir, 'broken.json');
    await writeFile(broken, '{not json');
    await expect(loadRuntimeConfig(broken)).rejects.toThrowError(/not valid JSON/);
  });
});

describe('plugin loading', () => {
  it('maps built-in short names to packages and leaves others alone', () => {
    // Asserting the literal path would just restate the table. What matters is
    // that a short name is translated at all and that an unknown one is not.
    expect(resolveSpecifier('memory')).not.toBe('memory');
    expect(resolveSpecifier('fs')).toBe(resolveSpecifier('filesystem'));
    expect(resolveSpecifier('@acme/deaddrop-transport-foo')).toBe('@acme/deaddrop-transport-foo');
    // Built from the same primitives as the implementation: on Windows a
    // rooted path picks up the current drive, so a literal file:/// string
    // would only ever be right on POSIX.
    expect(resolveSpecifier('./local.js', '/srv')).toBe(
      pathToFileURL(resolve('/srv/local.js')).href,
    );
  });

  it('finds a definition behind a default export, a named export or the factory', () => {
    expect(extractDefinition({ default: memoryTransport }, 'x').id).toBe('memory');
    expect(extractDefinition({ memoryTransport }, 'x').id).toBe('memory');
    expect(extractDefinition({ thing: memoryTransport.definition }, 'x').id).toBe('memory');
  });

  it('explains what is wrong when a module is not a transport', () => {
    expect(() => extractDefinition({ hello: 'world' }, 'bad-module')).toThrowError(
      /does not export a transport created with defineTransport/,
    );
  });

  it('loads a transport and validates its config through the plugin', async () => {
    const registration = await loadTransport(
      { use: 'memory', name: 'mem-1', config: { namespace: 'x' } },
      { loader: async () => ({ memoryTransport }) },
    );
    expect(registration.name).toBe('mem-1');
    expect(registration.definition.id).toBe('memory');

    await expect(
      loadTransport(
        { use: 'memory', config: { namespace: 42 } },
        { loader: async () => ({ memoryTransport }) },
      ),
    ).rejects.toThrowError(/must be a string/);
  });

  it('says how to fix an unresolvable transport package', async () => {
    await expect(
      loadTransport(
        { use: '@acme/missing' },
        {
          loader: async () => {
            throw new Error('Cannot find package');
          },
        },
      ),
    ).rejects.toThrowError(/Is the package installed/);
  });
});

describe('exposure helpers', () => {
  it('keeps resolved static paths inside the root', () => {
    expect(resolveWithinRoot('/srv/site', '/index.html')).toBe(resolve('/srv/site/index.html'));
    expect(resolveWithinRoot('/srv/site', 'assets/app.js')).toBe(
      resolve('/srv/site/assets/app.js'),
    );
    expect(resolveWithinRoot('/srv/site', '../secrets')).toBeUndefined();
    expect(resolveWithinRoot('/srv/site', 'a/../../b')).toBeUndefined();
    // A rooted path with leading `..` normalises against `/` and is then
    // clamped into the exposure root, which is safe: it can only ever name a
    // file that is genuinely inside the directory being served.
    expect(resolveWithinRoot('/srv/site', '/../../etc/passwd')).toBe(
      resolve('/srv/site/etc/passwd'),
    );
  });

  it('maps dead-drop error codes to sensible http statuses', () => {
    expect(statusForError(new DeadDropError('NOT_FOUND', 'x'))).toBe(404);
    expect(statusForError(new DeadDropError('TIMEOUT', 'x'))).toBe(504);
    expect(statusForError(new DeadDropError('UNAUTHORIZED', 'x'))).toBe(403);
    expect(statusForError(new DeadDropError('RATE_LIMITED', 'x'))).toBe(429);
    expect(statusForError(new DeadDropError('TRANSPORT_ERROR', 'x'))).toBe(502);
    expect(statusForError(new DeadDropError('INTERNAL', 'x'))).toBe(500);
  });
});

// Every built-in short name is a specifier relative to plugins.ts, handed
// straight to import(). Now that the transports live in this package, actually
// loading them is the check that can fail: a moved file or a renamed directory
// breaks the table silently otherwise.
describe('built-in transports', () => {
  it.each(Object.keys(BUILT_IN))('loads the %s transport', async (name) => {
    const module = await BUILT_IN[name]!();
    expect(extractDefinition(module, name).create).toBeTypeOf('function');
  });
});
