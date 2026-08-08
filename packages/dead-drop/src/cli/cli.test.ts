import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { generateWorkspaceSecret, parseWorkspaceSecret } from '../protocol/index.js';
import { defaultSocketPath } from '../runtime/index.js';

import { VERSION, run, type CliIo } from './cli.js';

const dirs: string[] = [];

function capture(): CliIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    // Never block a test on a signal.
    waitForShutdown: async () => undefined,
  };
}

function workspaceConfig(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...extra,
    workspaces: [
      {
        name: 'demo',
        secrets: [generateWorkspaceSecret()],
        transports: [{ use: 'memory' }],
      },
    ],
  };
}

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'deaddrop-cli-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ddrop cli argument handling', () => {
  it('prints usage with no arguments and exits non-zero', async () => {
    const io = capture();
    expect(await run([], io)).toBe(2);
    expect(io.stdout.join('\n')).toContain('ddrop expose');
  });

  it('prints usage for --help and exits zero', async () => {
    const io = capture();
    expect(await run(['--help'], io)).toBe(0);
    expect(io.stdout.join('\n')).toContain('Usage');
  });

  it('prints the version', async () => {
    const io = capture();
    expect(await run(['--version'], io)).toBe(0);
    expect(io.stdout[0]).toBe(VERSION);
  });

  it('rejects an unknown command and an unknown flag', async () => {
    const unknownCommand = capture();
    expect(await run(['teleport'], unknownCommand)).toBe(2);
    expect(unknownCommand.stderr.join('\n')).toContain('unknown command');

    const unknownFlag = capture();
    expect(await run(['status', '--wat'], unknownFlag)).toBe(2);
    expect(unknownFlag.stderr.join('\n')).toContain('--help');
  });
});

describe('ddrop keygen', () => {
  it('prints a usable workspace secret with a warning on stderr', async () => {
    const io = capture();
    expect(await run(['keygen'], io)).toBe(0);
    expect(parseWorkspaceSecret(io.stdout[0] as string)).toHaveLength(32);
    // The secret goes to stdout so it can be piped; the caveat goes to stderr.
    expect(io.stderr.join('\n')).toMatch(/Anyone holding it can read and write/);
  });

  it('supports json output', async () => {
    const io = capture();
    await run(['keygen', '--json'], io);
    const parsed = JSON.parse(io.stdout.join('\n')) as { secret: string };
    expect(parseWorkspaceSecret(parsed.secret)).toHaveLength(32);
  });
});

describe('ddrop init', () => {
  it('writes a starter config that references the secret from the environment', async () => {
    const dir = await temp();
    const path = join(dir, 'deaddrop.config.json');
    const io = capture();
    expect(await run(['init', '--config', path, '--name', 'my-project'], io)).toBe(0);

    const written = JSON.parse(await readFile(path, 'utf8')) as {
      workspaces: Array<{ name: string; secrets: string[] }>;
    };
    expect(written.workspaces[0]?.name).toBe('my-project');
    // A literal secret in a config file that people commit is the failure mode
    // this template exists to avoid.
    expect(written.workspaces[0]?.secrets).toEqual(['${env:DEADDROP_SECRET}']);
  });

  it('refuses to overwrite an existing config', async () => {
    const dir = await temp();
    const path = join(dir, 'deaddrop.config.json');
    await writeFile(path, '{}');
    const io = capture();
    expect(await run(['init', '--config', path], io)).toBe(1);
    expect(io.stderr.join('\n')).toContain('refusing to overwrite');
  });
});

describe('ddrop commands that need a runtime', () => {
  it('explains that the runtime is not running rather than failing obscurely', async () => {
    const io = capture();
    const socket = join(await temp(), 'absent.sock');
    expect(await run(['status', '--socket', socket], io)).toBe(1);
    expect(io.stderr.join('\n')).toMatch(/Is "ddrop start" running/);
  });

  it('reports the same failure as structured json when asked', async () => {
    const io = capture();
    const socket = join(await temp(), 'absent.sock');
    expect(await run(['status', '--socket', socket, '--json'], io)).toBe(1);
    const parsed = JSON.parse(io.stdout.join('\n')) as { error: { code: string } };
    expect(parsed.error.code).toBe('NO_TRANSPORT_AVAILABLE');
  });

  it('validates its own arguments before touching the runtime', async () => {
    const missingName = capture();
    expect(await run(['expose', '--target', 'http://localhost:3000'], missingName)).toBe(2);
    expect(missingName.stderr.join('\n')).toContain('--name');

    const missingTarget = capture();
    expect(await run(['expose', '--name', 'api'], missingTarget)).toBe(2);
    expect(missingTarget.stderr.join('\n')).toContain('--target');

    const badConnect = capture();
    expect(await run(['connect', 'just-a-peer'], badConnect)).toBe(2);
    expect(badConnect.stderr.join('\n')).toContain('<peer>/<exposure>');

    const badCall = capture();
    expect(await run(['call', 'peer-a'], badCall)).toBe(2);
    expect(badCall.stderr.join('\n')).toContain('<peer> <channel>');

    const badPublish = capture();
    expect(await run(['publish'], badPublish)).toBe(2);
    expect(badPublish.stderr.join('\n')).toContain('<channel>');

    const badTransport = capture();
    expect(await run(['transport', 'explode'], badTransport)).toBe(2);
    expect(badTransport.stderr.join('\n')).toContain('list');
  });

  // `ddrop init` writes a project-local dataDir, so a client that always
  // assumed ~/.deaddrop would never find a runtime started from that config.
  it('looks for the socket under the config data dir, not the default one', async () => {
    const dir = await temp();
    const dataDir = join(dir, 'state');
    const config = join(dir, 'deaddrop.config.json');
    await writeFile(config, JSON.stringify(workspaceConfig({ dataDir })));

    const io = capture();
    expect(await run(['status', '--config', config], io)).toBe(1);
    expect(io.stderr.join('\n')).toContain(defaultSocketPath(dataDir));
  });

  it('lets an explicit controlSocket in the config win over the data dir', async () => {
    const dir = await temp();
    const controlSocket = join(dir, 'custom.sock');
    const config = join(dir, 'deaddrop.config.json');
    await writeFile(
      config,
      JSON.stringify(workspaceConfig({ dataDir: join(dir, 'state'), controlSocket })),
    );

    const io = capture();
    expect(await run(['status', '--config', config], io)).toBe(1);
    expect(io.stderr.join('\n')).toContain(controlSocket);
  });

  it('reports a missing config file with the paths it looked in', async () => {
    const io = capture();
    expect(await run(['start', '--config', join(await temp(), 'nope.json')], io)).toBe(1);
    expect(io.stderr.join('\n')).toMatch(/cannot read config file/);
  });
});
