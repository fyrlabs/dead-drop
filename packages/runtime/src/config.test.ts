import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_DATA_DIR, expandEnv, loadRuntimeConfig, parseRuntimeConfig } from './config.js';
import { extractDefinition, loadTransport, resolveSpecifier } from './plugins.js';
import { resolveWithinRoot, statusForError } from './exposure.js';
import { memoryTransport } from '@fyrlabs/dead-drop-transport-memory';
import { BridgeError } from '@fyrlabs/dead-drop-protocol';

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
            secrets: ['${env:BRIDGE_SECRET}'],
            transports: [{ use: 'filesystem', config: { root: '${env:STORE}' } }],
          },
        ],
      },
      { env: { BRIDGE_SECRET: 'ddk1_secret', STORE: '/srv/store' } },
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
        dataDir: '~/.bridge',
        controlSocket: '~/run/bridge.sock',
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
    expect(config.dataDir).toBe(resolve(homedir(), '.bridge'));
    expect(config.controlSocket).toBe(resolve(homedir(), 'run/bridge.sock'));
    expect((config.workspaces[0]?.transports[0]?.config as { root: string }).root).toBe(
      resolve(homedir(), 'shared/store'),
    );
    expect(config.workspaces[0]?.exposures?.[0]?.directory).toBe(resolve(homedir(), 'public'));
  });

  const rejections: Array<[string, unknown, RegExp]> = [
    ['a non-object', 'nope', /must be a JSON object/],
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
  ];

  it.each(rejections)('rejects %s', (_label, input, pattern) => {
    expect(() => parseRuntimeConfig(input)).toThrowError(pattern);
  });
});

describe('loadRuntimeConfig', () => {
  it('reads and parses a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-config-'));
    dirs.push(dir);
    const path = join(dir, 'bridge.config.json');
    await writeFile(path, JSON.stringify(valid));
    const config = await loadRuntimeConfig(path);
    expect(config.workspaces[0]?.name).toBe('demo');
  });

  it('reports a missing or malformed file clearly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-config-'));
    dirs.push(dir);
    await expect(loadRuntimeConfig(join(dir, 'nope.json'))).rejects.toThrowError(/cannot read/);
    const broken = join(dir, 'broken.json');
    await writeFile(broken, '{not json');
    await expect(loadRuntimeConfig(broken)).rejects.toThrowError(/not valid JSON/);
  });
});

describe('plugin loading', () => {
  it('maps built-in short names to packages and leaves others alone', () => {
    expect(resolveSpecifier('memory')).toBe('@fyrlabs/dead-drop-transport-memory');
    expect(resolveSpecifier('fs')).toBe('@fyrlabs/dead-drop-transport-filesystem');
    expect(resolveSpecifier('github')).toBe('@fyrlabs/dead-drop-transport-github');
    expect(resolveSpecifier('@acme/bridge-transport-foo')).toBe('@acme/bridge-transport-foo');
    expect(resolveSpecifier('./local.js', '/srv')).toMatch(/^file:\/\/\/srv\/local\.js$/);
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

  it('maps Bridge error codes to sensible http statuses', () => {
    expect(statusForError(new BridgeError('NOT_FOUND', 'x'))).toBe(404);
    expect(statusForError(new BridgeError('TIMEOUT', 'x'))).toBe(504);
    expect(statusForError(new BridgeError('UNAUTHORIZED', 'x'))).toBe(403);
    expect(statusForError(new BridgeError('RATE_LIMITED', 'x'))).toBe(429);
    expect(statusForError(new BridgeError('TRANSPORT_ERROR', 'x'))).toBe(502);
    expect(statusForError(new BridgeError('INTERNAL', 'x'))).toBe(500);
  });
});
