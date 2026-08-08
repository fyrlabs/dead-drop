/**
 * CLI integration: the real `run()` entry point against a real runtime over a
 * real control socket.
 *
 * The unit tests in `packages/cli` cover argument handling and failure
 * messages. This covers the part that only breaks when the pieces are wired
 * together: `ddrop start` serving a socket that `ddrop status`, `expose`,
 * `call`, `publish`, `logs` and `metrics` can actually talk to.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { generateWorkspaceSecret } from '@fyrlabs/dead-drop-protocol';
import { defaultSocketPath } from '@fyrlabs/dead-drop-runtime';
import { run, type CliIo } from '@fyrlabs/dead-drop';

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
});

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
