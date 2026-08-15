/**
 * CLI integration: the real `run()` entry point against a real runtime over a
 * real control socket.
 *
 * The unit tests in `packages/dead-drop/test/cli` cover argument handling and
 * failure messages. This covers the part that only breaks when the pieces are wired
 * together: `ddrop start` serving a socket that `ddrop status`, `expose`,
 * `call`, `publish`, `logs` and `metrics` can actually talk to.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { generateWorkspaceSecret } from '@fyrlabs/dead-drop/protocol';
import { defaultSocketPath } from '@fyrlabs/dead-drop/runtime';
import { run, type CliIo } from '@fyrlabs/dead-drop/cli';

const dirs: string[] = [];
const shutdowns: Array<() => void> = [];

function capture(waitForever = false): CliIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    waitForShutdown: waitForever
      ? () => new Promise<void>((resolve) => shutdowns.push(resolve))
      : async () => undefined,
  };
}

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'deaddrop-cli-e2e-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const stop of shutdowns.splice(0)) stop();
  // Let `start` unwind before its data directory disappears.
  await new Promise((resolve) => setTimeout(resolve, 200));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ddrop start and the commands that talk to it', () => {
  it('serves status, expose, call, publish, logs and metrics over the socket', async () => {
    const dir = await temp();
    const dataDir = join(dir, 'state');
    const socket = defaultSocketPath(dataDir);
    const configPath = join(dir, 'deaddrop.config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        dataDir,
        logLevel: 'warn',
        workspaces: [
          {
            name: 'demo',
            peerId: 'cli-peer',
            secrets: [generateWorkspaceSecret()],
            transports: [{ use: 'filesystem', config: { root: join(dir, 'store') } }],
            polling: { minIntervalMs: 100, maxIntervalMs: 400 },
            requestTimeoutMs: 10_000,
          },
        ],
      }),
    );

    const server = capture(true);
    const started = run(['start', '--config', configPath], server);
    await waitFor(() => server.stderr.some((line) => line.includes('runtime listening')), 15_000);

    const status = capture();
    expect(await run(['status', '--socket', socket], status)).toBe(0);
    expect(status.stdout.join('\n')).toContain('workspace demo');
    expect(status.stdout.join('\n')).toContain('peer cli-peer');

    const statusJson = capture();
    await run(['status', '--socket', socket, '--json'], statusJson);
    const parsed = JSON.parse(statusJson.stdout.join('\n')) as {
      workspaces: Array<{ peerId: string }>;
    };
    expect(parsed.workspaces[0]?.peerId).toBe('cli-peer');

    const list = capture();
    expect(await run(['list', '--socket', socket], list)).toBe(0);
    expect(list.stdout).toContain('demo');

    const transports = capture();
    expect(await run(['transport', 'health', '--socket', socket], transports)).toBe(0);
    expect(transports.stdout.join('\n')).toContain('filesystem');

    const exposed = capture();
    expect(
      await run(
        ['expose', '--socket', socket, '--name', 'my-api', '--target', 'http://127.0.0.1:9'],
        exposed,
      ),
    ).toBe(0);
    expect(exposed.stdout.join('\n')).toContain('http/my-api');

    // The exposure now shows up in status and in discovery.
    const afterExpose = capture();
    await run(['status', '--socket', socket], afterExpose);
    expect(afterExpose.stdout.join('\n')).toContain('my-api');

    const discovered = capture();
    expect(await run(['discover', '--socket', socket, '--json'], discovered)).toBe(0);
    const peers = JSON.parse(discovered.stdout.join('\n')) as {
      peers: Array<{ peerId: string; exposures: string[] }>;
    };
    expect(peers.peers.some((peer) => peer.peerId === 'cli-peer')).toBe(true);

    const published = capture();
    expect(
      await run(['publish', 'events/test', '--socket', socket, '--input', '{"a":1}'], published),
    ).toBe(0);
    expect(published.stdout[0]).toMatch(/^msg_/);

    // Rotation, end to end and observed on the wire rather than in the report.
    //
    // `rotate` needs this peer's own identity object to be on the store, and
    // enrollment is fire-and-forget on start, so the first attempt can land in
    // that window. Retrying is the honest way to handle it: the refusal is
    // deliberate, not a flake to sleep past.
    const beforeRotate = await sealedKeyIds(join(dir, 'store'));
    expect(beforeRotate.size).toBe(1);

    const rotated = capture();
    let rotateCode = 1;
    await waitFor(async () => {
      rotateCode = await run(['rotate', '--socket', socket, '--json'], rotated);
      return rotateCode === 0;
    }, 15_000);
    const rotation = JSON.parse(rotated.stdout.join('\n')) as {
      eraId: string;
      seq: number;
      wrappedFor: string[];
    };
    expect(rotation.seq).toBe(1);
    expect(rotation.wrappedFor).toContain('cli-peer');
    expect(rotation.eraId).not.toBe([...beforeRotate][0]);

    const afterRotate = capture();
    expect(
      await run(['publish', 'events/test', '--socket', socket, '--input', '{"b":2}'], afterRotate),
    ).toBe(0);
    // What the whole feature is for: frames written now are sealed under an era
    // that exists only as 32 random bytes wrapped per peer, not under a key
    // every holder of the workspace secret can derive.
    const sealed = await sealedKeyIds(join(dir, 'store'));
    expect(sealed.has(rotation.eraId)).toBe(true);

    // A call to a peer that does not exist must fail cleanly, not hang.
    const call = capture();
    expect(
      await run(
        [
          'call',
          'nobody',
          'math.add',
          '--socket',
          socket,
          '--input',
          '{"a":1}',
          '--timeout',
          '600',
        ],
        call,
      ),
    ).toBe(1);
    expect(call.stderr.join('\n')).toMatch(/timed out/i);

    // That call left a frame addressed to a peer nobody is running, which is
    // exactly what "queued depth" is for: it is still sitting in the store.
    const queuesJson = capture();
    expect(await run(['queues', '--socket', socket, '--json'], queuesJson)).toBe(0);
    const report = JSON.parse(queuesJson.stdout.join('\n')) as {
      read: number;
      queues: Array<{ peerId: string; count: number }>;
    };
    expect(report.read).toBe(1);
    expect(report.queues.find((queue) => queue.peerId === 'nobody')?.count).toBe(1);

    const queues = capture();
    expect(await run(['queues', '--socket', socket], queues)).toBe(0);
    expect(queues.stdout.join('\n')).toMatch(/nobody\s+1 waiting/);

    const metrics = capture();
    expect(await run(['metrics', '--socket', socket], metrics)).toBe(0);
    expect(metrics.stdout.join('\n')).toContain('deaddrop_messages_sent_total');

    const logs = capture();
    expect(await run(['logs', '--socket', socket, '--limit', '5'], logs)).toBe(0);

    // The publish above produced spans, so the trace list has something in it
    // and the ids it prints expand into a tree.
    const traceJson = capture();
    expect(await run(['trace', '--socket', socket, '--json'], traceJson)).toBe(0);
    const { spans } = JSON.parse(traceJson.stdout.join('\n')) as {
      spans: Array<{ traceId: string; name: string }>;
    };
    expect(spans.length).toBeGreaterThan(0);

    const traceList = capture();
    expect(await run(['trace', '--socket', socket], traceList)).toBe(0);
    expect(traceList.stdout.join('\n')).toContain(spans[0]?.traceId as string);

    // The publish is traced as one trace keyed by the message id, and the
    // transport write sits under the send rather than floating in its own
    // trace. That nesting is the whole point of the command, so assert the
    // child is actually indented under the parent.
    const messageTraceId = spans.find((span) => span.traceId.startsWith('msg_'))?.traceId;
    expect(messageTraceId).toBeDefined();

    const oneTrace = capture();
    expect(await run(['trace', messageTraceId as string, '--socket', socket], oneTrace)).toBe(0);
    expect(oneTrace.stdout[0]).toMatch(/^(mailbox\.send|workspace\.request)/);
    expect(oneTrace.stdout.slice(1).some((line) => /^ {2}\S/.test(line))).toBe(true);

    // An unknown id is a normal outcome, not an error: the buffer is bounded.
    const unknownTrace = capture();
    expect(await run(['trace', 'trace_nope', '--socket', socket], unknownTrace)).toBe(0);
    expect(unknownTrace.stdout.join('\n')).toMatch(/No spans recorded/);

    for (const stop of shutdowns.splice(0)) stop();
    expect(await started).toBe(0);
  }, 60_000);

  it('round-trips an http request through expose and connect via the cli', async () => {
    const dir = await temp();
    const secret = generateWorkspaceSecret();
    const store = join(dir, 'store');

    const { createServer } = await import('node:http');
    const target = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('served through ddrop');
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const address = target.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const serverConfig = join(dir, 'server.json');
    await writeFile(
      serverConfig,
      JSON.stringify({
        dataDir: join(dir, 'server-state'),
        logLevel: 'warn',
        workspaces: [
          {
            name: 'demo',
            peerId: 'server-peer',
            secrets: [secret],
            transports: [{ use: 'filesystem', config: { root: store } }],
            exposures: [{ name: 'api', type: 'http', target: `http://127.0.0.1:${port}` }],
            polling: { minIntervalMs: 100, maxIntervalMs: 400 },
          },
        ],
      }),
    );
    const clientConfig = join(dir, 'client.json');
    await writeFile(
      clientConfig,
      JSON.stringify({
        dataDir: join(dir, 'client-state'),
        logLevel: 'warn',
        workspaces: [
          {
            name: 'demo',
            peerId: 'client-peer',
            secrets: [secret],
            transports: [{ use: 'filesystem', config: { root: store } }],
            polling: { minIntervalMs: 100, maxIntervalMs: 400 },
            requestTimeoutMs: 20_000,
          },
        ],
      }),
    );

    const server = capture(true);
    const serverRun = run(['start', '--config', serverConfig], server);
    await waitFor(() => server.stderr.some((line) => line.includes('runtime listening')), 15_000);

    const client = capture(true);
    const clientRun = run(['connect', 'server-peer/api', '--config', clientConfig], client);
    await waitFor(() => client.stdout.length > 0, 15_000);

    const url = client.stdout[0] as string;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${url}/anything`);
    expect(await response.text()).toBe('served through ddrop');

    for (const stop of shutdowns.splice(0)) stop();
    expect(await clientRun).toBe(0);
    expect(await serverRun).toBe(0);
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }, 60_000);

  it('prints a connect command that works, from an exposure it named itself', async () => {
    // Asserting the line exists would prove very little. The peer id it names
    // is this runtime's mailbox address rather than its configured identity,
    // and those differ for some runtimes, so the only honest check is to run
    // what it printed and fetch through it.
    const dir = await temp();
    const secret = generateWorkspaceSecret();
    const store = join(dir, 'store');
    const site = join(dir, 'brochure');
    await mkdir(site, { recursive: true });
    await writeFile(join(site, 'index.html'), '<h1>named itself</h1>');

    const workspace = (peerId: string, extra: Record<string, unknown> = {}) => ({
      name: 'demo',
      peerId,
      secrets: [secret],
      transports: [{ use: 'filesystem', config: { root: store } }],
      polling: { minIntervalMs: 100, maxIntervalMs: 400 },
      ...extra,
    });
    const serverConfig = join(dir, 'server.json');
    await writeFile(
      serverConfig,
      JSON.stringify({
        dataDir: join(dir, 'server-state'),
        logLevel: 'warn',
        workspaces: [workspace('server-peer')],
      }),
    );
    const clientConfig = join(dir, 'client.json');
    await writeFile(
      clientConfig,
      JSON.stringify({
        dataDir: join(dir, 'client-state'),
        logLevel: 'warn',
        workspaces: [workspace('client-peer', { requestTimeoutMs: 20_000 })],
      }),
    );

    const server = capture(true);
    const serverRun = run(['start', '--config', serverConfig], server);
    await waitFor(() => server.stderr.some((line) => line.includes('runtime listening')), 15_000);

    // No --name: the directory is called "brochure", so the exposure is too.
    const exposed = capture();
    expect(await run(['expose', site, '--config', serverConfig], exposed)).toBe(0);
    expect(exposed.stdout.join('\n')).toContain('as "brochure"');

    const printed = exposed.stdout.find((line) => line.startsWith('Peers reach it with:'));
    expect(printed).toBeDefined();
    const spec = (printed as string).replace('Peers reach it with: ddrop connect ', '').trim();
    expect(spec).toBe('server-peer/brochure');

    const client = capture(true);
    const clientRun = run(['connect', spec, '--config', clientConfig], client);
    await waitFor(() => client.stdout.length > 0, 15_000);
    const response = await fetch(`${client.stdout[0] as string}/index.html`);
    expect(await response.text()).toBe('<h1>named itself</h1>');

    for (const stop of shutdowns.splice(0)) stop();
    expect(await clientRun).toBe(0);
    expect(await serverRun).toBe(0);
  }, 60_000);

  it('approves a peer by fingerprint and only then wraps a new era for it', async () => {
    // The `requireApproval` tier end to end, over the real socket and against
    // the real approvals file. Two peers on one store: one runs the commands,
    // the other only publishes an identity, which is all an unapproved peer
    // ever gets to do.
    const dir = await temp();
    const secret = generateWorkspaceSecret();
    const store = join(dir, 'store');
    const dataDir = join(dir, 'admin-state');
    const socket = defaultSocketPath(dataDir);

    const workspace = (peerId: string, extra: Record<string, unknown> = {}) => ({
      name: 'demo',
      peerId,
      secrets: [secret],
      transports: [{ use: 'filesystem', config: { root: store } }],
      polling: { minIntervalMs: 100, maxIntervalMs: 400 },
      enrollment: { requireApproval: true },
      ...extra,
    });
    const adminConfig = join(dir, 'admin.json');
    await writeFile(
      adminConfig,
      JSON.stringify({ dataDir, logLevel: 'warn', workspaces: [workspace('admin-peer')] }),
    );
    const joinerConfig = join(dir, 'joiner.json');
    await writeFile(
      joinerConfig,
      JSON.stringify({
        dataDir: join(dir, 'joiner-state'),
        logLevel: 'warn',
        workspaces: [workspace('joiner-peer')],
      }),
    );

    const admin = capture(true);
    const adminRun = run(['start', '--config', adminConfig], admin);
    const joiner = capture(true);
    const joinerRun = run(['start', '--config', joinerConfig], joiner);
    await waitFor(() => admin.stderr.some((line) => line.includes('runtime listening')), 15_000);
    await waitFor(() => joiner.stderr.some((line) => line.includes('runtime listening')), 15_000);

    // Enrollment is fire-and-forget on start, so the identities arrive on their
    // own schedule. Polling for them is the honest wait.
    type Listing = { peers: Array<{ peerId: string; fingerprint: string; approved: boolean }> };
    let listing: Listing = { peers: [] };
    await waitFor(async () => {
      const io = capture();
      if ((await run(['peer', 'list', '--socket', socket, '--json'], io)) !== 0) return false;
      listing = JSON.parse(io.stdout.join('\n')) as Listing;
      return listing.peers.length === 2;
    }, 20_000);
    const joinerEntry = listing.peers.find((entry) => entry.peerId === 'joiner-peer');
    expect(joinerEntry?.approved).toBe(false);
    expect(joinerEntry?.fingerprint).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);

    // Rotating now leaves it out, and says so rather than reporting success.
    const early = capture();
    expect(await run(['rotate', '--socket', socket, '--json'], early)).toBe(0);
    expect((JSON.parse(early.stdout.join('\n')) as { skipped: string[] }).skipped).toEqual([
      'joiner-peer',
    ]);

    // A fingerprint that is not the published one is refused, and the refusal
    // names what the store is actually serving, which is what an operator
    // compares against what they were read.
    const wrong = capture();
    expect(
      await run(
        ['peer', 'approve', 'joiner-peer', '0000-0000-0000-0000', '--socket', socket],
        wrong,
      ),
    ).toBe(1);
    expect(wrong.stderr.join('\n')).toContain(joinerEntry?.fingerprint as string);

    const approved = capture();
    expect(
      await run(
        ['peer', 'approve', 'joiner-peer', joinerEntry?.fingerprint as string, '--socket', socket],
        approved,
      ),
    ).toBe(0);
    // Written down, not merely remembered: the next rotation may be after a
    // restart, and an approval that evaporates drops a peer nobody removed.
    const recorded = JSON.parse(
      await readFile(join(dataDir, 'demo.approvals.json'), 'utf8'),
    ) as Record<string, string>;
    expect(recorded['joiner-peer']).toBe(joinerEntry?.fingerprint);

    const rotated = capture();
    expect(await run(['rotate', '--socket', socket, '--json'], rotated)).toBe(0);
    const rotation = JSON.parse(rotated.stdout.join('\n')) as {
      wrappedFor: string[];
      skipped: string[];
    };
    expect(rotation.wrappedFor.sort()).toEqual(['admin-peer', 'joiner-peer']);
    expect(rotation.skipped).toEqual([]);

    for (const stop of shutdowns.splice(0)) stop();
    expect(await adminRun).toBe(0);
    expect(await joinerRun).toBe(0);
  }, 60_000);
});

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Every key id that appears in a topic frame under `root`, read off the bytes.
 *
 * `frame.ts` puts `keyIdLen` at byte 5 and the ascii id straight after it, in
 * the clear and outside the ciphertext. Reading it here is the only way to say
 * what a message was really sealed under; the runtime's own report would agree
 * with itself either way.
 */
async function sealedKeyIds(root: string): Promise<Set<string>> {
  const found = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.name.endsWith('.ddf') && dir.includes('topic')) {
        const raw = await readFile(path);
        found.add(raw.subarray(6, 6 + raw.readUInt8(5)).toString('ascii'));
      }
    }
  };
  await walk(root);
  return found;
}
