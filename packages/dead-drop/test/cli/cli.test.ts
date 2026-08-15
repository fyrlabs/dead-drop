import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { generateWorkspaceSecret, parseWorkspaceSecret } from '#dead-drop/protocol/index.js';
import { defaultSocketPath } from '#dead-drop/runtime/index.js';

import { VERSION, run, type CliIo } from '#dead-drop/cli/cli.js';

const dirs: string[] = [];
const servers: Array<{ close(cb?: () => void): unknown }> = [];
/** Makes each named pipe name unique within the process. */
let fakeControlPlanes = 0;

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

/**
 * A control socket answering one canned body, so a client command can be driven
 * alone.
 *
 * Windows has no Unix sockets, and `listen` on a path there fails with a bare
 * `EACCES` rather than anything naming the cause. The runtime already solves
 * this with a named pipe in `defaultSocketPath`; the same branch is needed in
 * any test that binds its own listener.
 */
async function fakeControlPlane(body: unknown): Promise<string> {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\deaddrop-test-${process.pid.toString(16)}-${fakeControlPlanes++}`
      : join(await temp(), 'control.sock');
  const server = createServer((_request, response) => {
    const payload = JSON.stringify(body);
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': payload.length,
    });
    response.end(payload);
  });
  server.listen(socketPath);
  await once(server, 'listening');
  servers.push(server);
  return socketPath;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
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

  it('reports the version in the manifest', async () => {
    // Comparing the output against VERSION alone is tautological, and a
    // hard-coded literal here went stale across 0.2.0: the published CLI
    // reported 0.1.0, and the same value reaches the runtime's status and
    // health output. Pin it to the manifest, which is what npm publishes.
    const manifest = createRequire(import.meta.url)('../../package.json') as { version: string };
    expect(VERSION).toBe(manifest.version);
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
  it('writes a config that starts, with the secret beside it rather than inline', async () => {
    const dir = await temp();
    const path = join(dir, 'deaddrop.config.json');
    const io = capture();
    expect(
      await run(['init', '--config', path, '--name', 'my-project', '--peer', 'peer-a'], io),
    ).toBe(0);

    const written = JSON.parse(await readFile(path, 'utf8')) as {
      workspaces: Array<{ name: string; peerId: string; secrets: string[] }>;
    };
    expect(written.workspaces[0]?.name).toBe('my-project');
    // A literal secret in a config file that people commit is the failure mode
    // this template exists to avoid.
    //
    // The forward slash is the assertion, not an accident of the platform this
    // runs on: a config is copied to the second machine, and `path.join` writes
    // `.deaddrop\secret` on Windows, which reads as one filename containing a
    // backslash everywhere else. Caught by the Windows CI job, not by review.
    expect(written.workspaces[0]?.secrets).toEqual(['${file:.deaddrop/secret}']);
    // Explicit, because the old default was the hostname and two runtimes on one
    // machine then collided on a mailbox address with an unexplained DECODE_FAILED.
    expect(written.workspaces[0]?.peerId).toBe('peer-a');

    // The referenced secret exists and is a real key, so nothing has to be
    // exported before `ddrop start` works.
    const secret = await readFile(join(dir, '.deaddrop', 'secret'), 'utf8');
    expect(parseWorkspaceSecret(secret.trim())).toHaveLength(32);
  });

  it('leaves the shared location as a placeholder that refuses to start', async () => {
    const dir = await temp();
    const path = join(dir, 'deaddrop.config.json');
    expect(await run(['init', '--config', path], capture())).toBe(0);

    // The whole point: two people following the quick start used to each get a
    // runtime that started cleanly against its own local folder and could never
    // see the other. This has to fail, and has to say which field.
    const io = capture();
    expect(await run(['status', '--config', path], io)).toBe(1);
    expect(io.stderr.join('\n')).toMatch(
      /config\.workspaces\[0\][^\n]*root is still the placeholder/,
    );
  });

  it('fills the shared location in when it is given one', async () => {
    const dir = await temp();
    const path = join(dir, 'deaddrop.config.json');
    const io = capture();
    expect(await run(['init', '--config', path, '--root', '/srv/shared'], io)).toBe(0);

    const written = JSON.parse(await readFile(path, 'utf8')) as {
      workspaces: Array<{ transports: Array<{ config: { root: string } }> }>;
    };
    expect(written.workspaces[0]?.transports[0]?.config.root).toBe('/srv/shared');
    expect(io.stderr.join('\n')).toContain('Next: ddrop start');
  });

  it('refuses to overwrite an existing config', async () => {
    const dir = await temp();
    const path = join(dir, 'deaddrop.config.json');
    await writeFile(path, '{}');
    const io = capture();
    expect(await run(['init', '--config', path], io)).toBe(1);
    expect(io.stderr.join('\n')).toContain('refusing to overwrite');
  });

  it('writes a github transport that needs no hand-editing afterwards', async () => {
    const dir = await temp();
    const path = join(dir, 'deaddrop.config.json');
    const io = capture();
    expect(await run(['init', '--config', path, '--github', 'acme/workspace'], io)).toBe(0);

    const written = JSON.parse(await readFile(path, 'utf8')) as {
      workspaces: Array<{ transports: Array<{ use: string; config: Record<string, unknown> }> }>;
    };
    const transport = written.workspaces[0]?.transports[0];
    expect(transport?.use).toBe('github');
    // The three fields the README used to tell people to paste in by hand. The
    // forward slash in workDir matters for the same reason it does for the
    // secret path: this config gets copied to the other machine.
    expect(transport?.config).toEqual({
      repo: 'acme/workspace',
      workDir: './.deaddrop/github',
      createIfMissing: true,
    });
    // `gh` owns the credentials, so the next step is an auth step, not a start.
    expect(io.stderr.join('\n')).toContain('gh auth login');
  });

  it('rejects a repo that is not owner/repo, before writing anything', async () => {
    const dir = await temp();
    const path = join(dir, 'deaddrop.config.json');
    const io = capture();
    // A github transport resolves its repository lazily, so a typo here would
    // otherwise start a runtime that logs "started" and reaches nobody.
    expect(await run(['init', '--config', path, '--github', 'not-a-repo'], io)).toBe(1);
    expect(io.stderr.join('\n')).toContain('<owner>/<repo>');
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });

  it('refuses --root and --github together rather than silently preferring one', async () => {
    const dir = await temp();
    const path = join(dir, 'deaddrop.config.json');
    const io = capture();
    expect(await run(['init', '--config', path, '--github', 'a/b', '--root', '/srv'], io)).toBe(1);
    expect(io.stderr.join('\n')).toContain('two different transports');
  });

  it('joins an existing workspace with the secret it is given, generating none', async () => {
    const dir = await temp();
    const path = join(dir, 'deaddrop.config.json');
    const existing = generateWorkspaceSecret();
    const io = capture();
    expect(
      await run(['init', '--config', path, '--root', '/srv/shared', '--secret', existing], io),
    ).toBe(0);

    // The point of the flag: the second peer must end up on the FIRST peer's
    // secret. A generated one here is a workspace of one that looks healthy.
    const written = (await readFile(join(dir, '.deaddrop', 'secret'), 'utf8')).trim();
    expect(written).toBe(existing);
    expect(io.stderr.join('\n')).toContain('Joined workspace');
  });

  it('reads the secret from stdin so it stays out of shell history', async () => {
    const dir = await temp();
    const path = join(dir, 'deaddrop.config.json');
    const existing = generateWorkspaceSecret();
    const io = { ...capture(), readStdin: async () => `${existing}\n` };
    expect(await run(['init', '--config', path, '--root', '/srv', '--secret', '-'], io)).toBe(0);

    expect((await readFile(join(dir, '.deaddrop', 'secret'), 'utf8')).trim()).toBe(existing);
    // A literal warns; stdin has nothing to warn about.
    expect(io.stderr.join('\n')).not.toContain('shell history');
  });

  it('warns that a secret passed as an argument is visible to the machine', async () => {
    const dir = await temp();
    const path = join(dir, 'deaddrop.config.json');
    const io = capture();
    await run(
      ['init', '--config', path, '--root', '/srv', '--secret', generateWorkspaceSecret()],
      io,
    );
    expect(io.stderr.join('\n')).toContain('shell history');
  });

  it('rejects a mistyped secret at init instead of at the first message', async () => {
    const dir = await temp();
    const path = join(dir, 'deaddrop.config.json');
    const io = capture();
    // Without this check the secret parses as base64url, derives a different
    // key, and surfaces as DECODE_FAILED against a peer's first frame, which
    // names nothing and reads as a protocol bug.
    expect(
      await run(['init', '--config', path, '--root', '/srv', '--secret', 'ddk1_short'], io),
    ).toBe(1);
    expect(io.stderr.join('\n')).toMatch(/32 bytes/);
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });

  it('refuses to join when a different secret is already on disk', async () => {
    const dir = await temp();
    const path = join(dir, 'deaddrop.config.json');
    await writeFile(join(dir, 'placeholder'), '');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, '.deaddrop'), { recursive: true });
    await writeFile(join(dir, '.deaddrop', 'secret'), `${generateWorkspaceSecret()}\n`);

    const io = capture();
    // Silently keeping the old secret would report a successful join and leave
    // the peer talking to nobody.
    expect(
      await run(
        ['init', '--config', path, '--root', '/srv', '--secret', generateWorkspaceSecret()],
        io,
      ),
    ).toBe(1);
    expect(io.stderr.join('\n')).toContain('already holds a different secret');
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

    // A directory names itself, so this one is rejected for the name it would
    // have derived rather than for having none. Exposure names become path
    // segments in object keys, so the rule is the protocol's, not the CLI's.
    const unusableName = capture();
    expect(await run(['expose', join(await temp(), 'my site')], unusableName)).toBe(2);
    expect(unusableName.stderr.join('\n')).toContain('cannot be an exposure name');

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

    const badPeer = capture();
    expect(await run(['peer', 'banish'], badPeer)).toBe(2);
    expect(badPeer.stderr.join('\n')).toContain('list');

    const namelessRevoke = capture();
    expect(await run(['peer', 'revoke'], namelessRevoke)).toBe(2);
    expect(namelessRevoke.stderr.join('\n')).toContain('<peer>');

    // Approving takes both halves, and the missing half is worth naming: an
    // approval with no fingerprint would be the bare yes this tier refuses.
    const halfApproval = capture();
    expect(await run(['peer', 'approve', 'peer-b'], halfApproval)).toBe(2);
    expect(halfApproval.stderr.join('\n')).toContain('<peer> <fingerprint>');
  });

  it('reports enrolled peers, and marks the ones nobody has approved', async () => {
    const socket = await fakeControlPlane({
      requireApproval: true,
      sealing: 'era_aaa',
      keyIds: ['era_aaa'],
      peers: [
        { peerId: 'peer-a', fingerprint: '1111-2222-3333-4444', approved: true, self: true },
        { peerId: 'peer-b', fingerprint: 'aaaa-bbbb-cccc-dddd', approved: false, self: false },
      ],
      unreadable: [],
    });

    const io = capture();
    expect(await run(['peer', 'list', '--socket', socket], io)).toBe(0);
    const out = io.stdout.join('\n');
    expect(out).toMatch(/peer-a\s+1111-2222-3333-4444\s+\(this peer, approved\)/);
    expect(out).toMatch(/peer-b\s+aaaa-bbbb-cccc-dddd\s+\(not approved\)/);
    // The consequence, not just the state: an operator reading this needs to
    // know that rotating now leaves peer-b out.
    expect(io.stderr.join('\n')).toMatch(/only for the peers marked approved/);
  });

  it('says a key changed since it was approved, rather than only that it is unapproved', async () => {
    // A peer nobody got round to approving and a peer whose identity object was
    // replaced print the same "not approved" otherwise, and the second is an
    // attack in progress.
    const socket = await fakeControlPlane({
      requireApproval: true,
      sealing: 'era_aaa',
      keyIds: ['era_aaa'],
      peers: [
        {
          peerId: 'peer-b',
          fingerprint: 'aaaa-bbbb-cccc-dddd',
          approved: false,
          self: false,
          approvedFingerprint: '1111-2222-3333-4444',
        },
      ],
      unreadable: [],
    });

    const io = capture();
    expect(await run(['peer', 'list', '--socket', socket], io)).toBe(0);
    expect(io.stdout.join('\n')).toMatch(
      /key changed since approval, which was 1111-2222-3333-4444/,
    );
  });

  it('says a revoked peer still reads until somebody rotates', async () => {
    // The dangerous misreading of this command is that it cut somebody off. It
    // did not, and the line saying so is printed whether or not there was an
    // approval to take back.
    const socket = await fakeControlPlane({ peerId: 'peer-b', revoked: true });

    const io = capture();
    expect(await run(['peer', 'revoke', 'peer-b', '--socket', socket], io)).toBe(0);
    expect(io.stdout.join('\n')).toContain('Revoked peer-b');
    expect(io.stderr.join('\n')).toMatch(/still reads everything until you run "ddrop rotate"/);
  });

  it('says why nothing is readable when this peer was left out of a rotation', async () => {
    const socket = await fakeControlPlane({
      requireApproval: false,
      sealing: 'era_old',
      keyIds: ['era_old'],
      waitingFor: { eraId: 'era_new', seq: 3 },
      peers: [
        { peerId: 'peer-a', fingerprint: '1111-2222-3333-4444', approved: false, self: true },
      ],
      unreadable: ['filesystem'],
    });

    const io = capture();
    expect(await run(['peer', 'list', '--socket', socket], io)).toBe(0);
    const errors = io.stderr.join('\n');
    expect(errors).toContain('era_new');
    expect(errors).toMatch(/could not list identities on filesystem/);
  });

  // "Nothing is queued" and "I could not look" print almost the same thing and
  // mean opposite things. This project has already shipped one bug from reading
  // a failed check as a passing one (`git push` exit 0), so the empty-looking
  // report has to be distinguishable by exit code, not just by reading stderr.
  it('fails ddrop queues when no transport could be listed', async () => {
    const socket = await fakeControlPlane({
      workspace: 'demo',
      peerId: 'peer-a',
      queues: [],
      unreadable: [{ transport: 'filesystem', message: 'root is gone' }],
      read: 0,
      truncated: false,
    });

    const io = capture();
    expect(await run(['queues', '--socket', socket], io)).toBe(1);
    expect(io.stderr.join('\n')).toContain('root is gone');
    expect(io.stderr.join('\n')).toMatch(/queue depth is unknown/);
    expect(io.stdout.join('\n')).not.toMatch(/No messages are queued/);
  });

  it('succeeds with an empty report when the stores were readable', async () => {
    const socket = await fakeControlPlane({
      workspace: 'demo',
      peerId: 'peer-a',
      queues: [],
      unreadable: [],
      read: 1,
      truncated: false,
    });

    const io = capture();
    expect(await run(['queues', '--socket', socket], io)).toBe(0);
    expect(io.stdout.join('\n')).toContain('No messages are queued');
  });

  it('says counts are lower bounds when the listing was truncated', async () => {
    const socket = await fakeControlPlane({
      workspace: 'demo',
      peerId: 'peer-a',
      queues: [{ peerId: 'peer-b', count: 10_000, bytes: 2048, oldestId: 'msg_x' }],
      unreadable: [],
      read: 1,
      truncated: true,
    });

    const io = capture();
    expect(await run(['queues', '--socket', socket], io)).toBe(0);
    // An id the runtime could not date must not print as a bogus age.
    expect(io.stdout.join('\n')).toMatch(/peer-b\s+10000 waiting\s+2\.0 KB\s+oldest \?/);
    expect(io.stderr.join('\n')).toMatch(/lower bound/);
  });

  it('fails ddrop discover when no transport could be listed', async () => {
    const socket = await fakeControlPlane({
      peers: [],
      unreadable: [{ transport: 'filesystem', message: 'store is unreachable' }],
      read: 0,
    });

    const io = capture();
    expect(await run(['discover', '--socket', socket], io)).toBe(1);
    expect(io.stderr.join('\n')).toContain('store is unreachable');
    expect(io.stdout.join('\n')).not.toMatch(/No peers have announced/);
  });

  it('still reports an empty workspace as empty when a store answered', async () => {
    const socket = await fakeControlPlane({ peers: [], unreadable: [], read: 1 });

    const io = capture();
    expect(await run(['discover', '--socket', socket], io)).toBe(0);
    expect(io.stdout.join('\n')).toContain('No peers have announced');
  });

  it('marks the runtime own queue, which is the one it will drain itself', async () => {
    const socket = await fakeControlPlane({
      workspace: 'demo',
      peerId: 'peer-a',
      queues: [
        { peerId: 'peer-b', count: 2, bytes: 100, oldestId: 'msg_x' },
        { peerId: 'peer-a', count: 1, bytes: 50, oldestId: 'msg_y', oldestAt: Date.now() - 5000 },
      ],
      unreadable: [],
      read: 1,
      truncated: false,
    });

    const io = capture();
    expect(await run(['queues', '--socket', socket], io)).toBe(0);
    const lines = io.stdout.join('\n').split('\n');
    expect(lines.find((line) => line.startsWith('peer-a'))).toContain('(this peer)');
    expect(lines.find((line) => line.startsWith('peer-b'))).not.toContain('(this peer)');
    expect(lines.find((line) => line.startsWith('peer-a'))).toMatch(/oldest 5s ago/);
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

describe('ddrop dashboard', () => {
  it('prints the url on stdout, and prints it before opening anything', async () => {
    const socket = await fakeControlPlane({ ok: true, version: VERSION });
    const io = capture();
    // Port 0 rather than the default: a fixed port would collide with whatever
    // else is listening on the machine running the suite.
    expect(await run(['dashboard', '--socket', socket, '--port', '0', '--no-open'], io)).toBe(0);
    // One line, the URL, so `ddrop dashboard --no-open | pbcopy` is a sensible
    // thing to type. Everything else is commentary on stderr.
    expect(io.stdout).toHaveLength(1);
    expect(io.stdout[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(io.stderr.join('\n')).toContain('read-only');
  });

  it('starts against a runtime that is not running, and says so', async () => {
    // A dashboard opened before `ddrop start`, or left open across a restart,
    // must not be a hard failure: the page reports the runtime being away.
    const io = capture();
    const socket = join(await temp(), 'absent.sock');
    expect(await run(['dashboard', '--socket', socket, '--port', '0', '--no-open'], io)).toBe(0);
    expect(io.stderr.join('\n')).toMatch(/Is "ddrop start" running/);
    expect(io.stdout[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('rejects a port that is not one before binding anything', async () => {
    const socket = await fakeControlPlane({ ok: true });
    for (const port of ['not-a-port', '70000', '-1', '80.5']) {
      const io = capture();
      expect(await run(['dashboard', '--socket', socket, '--port', port, '--no-open'], io)).toBe(2);
      expect(io.stderr.join('\n')).toContain('--port');
      expect(io.stdout).toEqual([]);
    }
  });
});
