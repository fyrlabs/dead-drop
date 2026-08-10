/**
 * The `ddrop` command.
 *
 * Two kinds of command: those that need a running runtime (`status`, `expose`,
 * `connect`, `logs`, `metrics`, `discover`) and talk to it over the control
 * socket, and those that stand alone (`keygen`, `init`, `start`). Everything
 * writes machine-readable JSON with `--json` so the CLI is scriptable.
 *
 * Argument parsing is hand-rolled: `node:util.parseArgs` covers it, and a
 * commander/yargs dependency in a security-sensitive runtime is not worth the
 * convenience.
 */

import { parseArgs } from 'node:util';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { VERSION } from '../version.js';
import { dirname, resolve } from 'node:path';

import { DeadDropError, generateWorkspaceSecret } from '../protocol/index.js';
import { createLogger, prettySink, type LogRecord, type Span } from '../core/index.js';
import {
  DeadDropRuntime,
  ControlPlaneClient,
  DEFAULT_DATA_DIR,
  connect,
  defaultSocketPath,
  loadRuntimeConfig,
  startControlPlane,
  type RuntimeConfig,
} from '../runtime/index.js';

import { DEFAULT_DASHBOARD_PORT, browserOpenCommand, startDashboard } from './dashboard.js';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** Resolves when the process should exit. Injected so tests do not block. */
  waitForShutdown?(): Promise<void>;
}

const defaultIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  waitForShutdown: () =>
    new Promise<void>((resolveShutdown) => {
      const stop = (): void => resolveShutdown();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }),
};

const USAGE = `ddrop — a transport-agnostic runtime for distributed applications

Usage
  ddrop start [--config <file>]              run the runtime in the foreground
  ddrop status [--json]                      show runtime, workspace and transport state
  ddrop list                                 list workspaces
  ddrop discover [--json] [--stale]          list peers visible in the workspace
  ddrop queues [--json]                      messages waiting in each peer's inbox
  ddrop dashboard [--port n] [--no-open]     read-only web view on 127.0.0.1
  ddrop transport list [--json]              show transports and their scores
  ddrop transport health [--json]            re-probe transports and show health
  ddrop expose --target <url> --name <name>  expose a local http server
  ddrop expose <dir> --name <name>           expose a directory of static files
  ddrop connect <peer>/<exposure> [--port n] serve a remote exposure locally
  ddrop call <peer> <channel> [--input json] make an rpc call
  ddrop publish <channel> [--input json]     broadcast an event
  ddrop logs [--limit n] [--level warn]      recent runtime logs
  ddrop trace [<traceId>]                    recent traces, or one trace as a span tree
  ddrop metrics                              Prometheus metrics
  ddrop keygen                               print a new workspace secret
  ddrop init [--root <shared-folder>]        write a config, and a secret beside it
             [--name <workspace>] [--peer <id>]

Global options
  --config <file>    config file (default ./deaddrop.config.json, then ~/.deaddrop/config.json)
  --workspace <name> workspace to act on (default: the runtime's first)
  --socket <path>    control plane socket (default <dataDir>/deaddrop.sock)
  --json             machine-readable output
  --help, --version
`;

export { VERSION };

export async function run(argv: string[], io: CliIo = defaultIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: 'string' },
        workspace: { type: 'string' },
        socket: { type: 'string' },
        target: { type: 'string' },
        name: { type: 'string' },
        root: { type: 'string' },
        peer: { type: 'string' },
        port: { type: 'string' },
        input: { type: 'string' },
        limit: { type: 'string' },
        level: { type: 'string' },
        timeout: { type: 'string' },
        json: { type: 'boolean' },
        stale: { type: 'boolean' },
        // parseArgs has no `--no-x` negation, so the negative form is its own
        // option. Opening a browser is the default, and this is the way out of
        // it on a headless machine.
        'no-open': { type: 'boolean' },
        pretty: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    io.err(`ddrop: ${(error as Error).message}`);
    io.err('Run "ddrop --help" for usage.');
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.version) {
    io.out(VERSION);
    return 0;
  }
  const command = positionals[0];
  if (values.help || command === undefined || command === 'help') {
    io.out(USAGE);
    return command === undefined && !values.help ? 2 : 0;
  }

  try {
    return await dispatch(command, positionals.slice(1), values, io);
  } catch (error) {
    const deadDropError = DeadDropError.from(error);
    if (values.json) {
      io.out(JSON.stringify({ error: deadDropError.toJSON() }, null, 2));
    } else {
      io.err(`ddrop: ${deadDropError.message}`);
    }
    return 1;
  }
}

type Values = Record<string, string | boolean | undefined>;

async function dispatch(
  command: string,
  args: string[],
  values: Values,
  io: CliIo,
): Promise<number> {
  switch (command) {
    case 'keygen':
      return keygen(values, io);
    case 'init':
      return init(values, io);
    case 'start':
      return start(values, io);
    case 'status':
      return status(values, io);
    case 'list':
      return listWorkspaces(values, io);
    case 'discover':
      return discover(values, io);
    case 'queues':
      return queues(values, io);
    case 'dashboard':
      return dashboard(values, io);
    case 'transport':
      return transport(args, values, io);
    case 'expose':
      return expose(args, values, io);
    case 'connect':
      return connectCommand(args, values, io);
    case 'call':
      return call(args, values, io);
    case 'publish':
      return publish(args, values, io);
    case 'logs':
      return logs(values, io);
    case 'trace':
      return trace(args, values, io);
    case 'metrics':
      return metrics(values, io);
    default:
      io.err(`ddrop: unknown command "${command}"`);
      io.err('Run "ddrop --help" for usage.');
      return 2;
  }
}

// ------------------------------------------------------------------ commands

function keygen(values: Values, io: CliIo): number {
  const secret = generateWorkspaceSecret();
  if (values.json) {
    io.out(JSON.stringify({ secret }, null, 2));
  } else {
    io.out(secret);
    io.err('');
    io.err('Share this secret with every peer in the workspace, over a channel you trust.');
    io.err('Anyone holding it can read and write the workspace. Reference it from the');
    io.err('config as "${file:.deaddrop/secret}" or "${env:DEADDROP_SECRET}", never inline.');
    io.err('');
    io.err('"ddrop init" already generates one, so this is for rotating or adding a key.');
  }
  return 0;
}

/**
 * Writes a config that starts, and leaves exactly one decision to the reader.
 *
 * The old one left three, and two of them failed silently. It wrote no `peerId`,
 * so two peers both defaulted to the machine hostname and collided on a mailbox
 * address with a `DECODE_FAILED` that named nothing. It pointed the transport at
 * a directory under the local data dir, so two people following the quick start
 * each got a working runtime that could never see the other. And it referenced
 * an environment variable it did not set, so the very next command failed.
 *
 * Now: the secret is generated and written beside the config, the peer id is
 * explicit, and the shared location is the single thing marked REPLACE-ME --
 * because it is the one value no default can guess. `--root` fills it in for
 * anyone who already knows where it goes.
 */
async function init(values: Values, io: CliIo): Promise<number> {
  const name = typeof values.name === 'string' ? values.name : 'default';
  const path = resolve(typeof values.config === 'string' ? values.config : 'deaddrop.config.json');
  const dir = dirname(path);
  const dataDir = '.deaddrop';
  // A forward slash even on Windows, and never `join`. This string goes into the
  // config file, and a config is copied between machines -- the README says to
  // copy one to the second peer. `join` writes `.deaddrop\secret` on Windows,
  // which reads as a single filename containing a backslash anywhere else.
  // `path.resolve` accepts forward slashes on every platform, so one spelling
  // works for both.
  const secretFile = `${dataDir}/secret`;
  const peerId = typeof values.peer === 'string' ? values.peer : defaultPeerId();
  const root =
    typeof values.root === 'string'
      ? values.root
      : `REPLACE-ME (a folder every peer can reach, e.g. ~/Dropbox/${name})`;

  const config = {
    dataDir,
    logLevel: 'info',
    workspaces: [
      {
        name,
        peerId,
        secrets: [`\${file:${secretFile}}`],
        transports: [{ use: 'filesystem', config: { root } }],
        exposures: [],
      },
    ],
  };
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') {
        throw new DeadDropError(
          'CONFIG_INVALID',
          `${path} already exists; refusing to overwrite it`,
        );
      }
      throw error;
    },
  );

  // Only after the config is safely written, so a re-run against an existing
  // config cannot rotate a secret that peers are already using.
  await mkdir(resolve(dir, dataDir), { recursive: true });
  const secretPath = resolve(dir, secretFile);
  await writeFile(secretPath, `${generateWorkspaceSecret()}\n`, { flag: 'wx', mode: 0o600 }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    },
  );

  io.out(`Wrote ${path}`);
  io.out(`Wrote ${secretPath}`);
  io.err('');
  io.err(`The secret in ${secretFile} is the workspace. Keep it out of version control,`);
  io.err('and copy it to every other peer over a channel you trust.');
  io.err('');
  if (typeof values.root === 'string') {
    io.err('Next: ddrop start');
  } else {
    io.err(`Next: set "root" in ${path} to a folder every peer can reach, then: ddrop start`);
    io.err('      (or re-run with --root <path> against a fresh config)');
  }
  return 0;
}

/**
 * The hostname, which is right for the ordinary case of one runtime per machine
 * and wrong for two on one box -- so it is written into the file where it can be
 * seen and changed, rather than defaulted invisibly at load time.
 */
function defaultPeerId(): string {
  const raw = hostname().split('.')[0] ?? 'peer';
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60);
  return cleaned.length > 0 ? cleaned : 'peer';
}

async function start(values: Values, io: CliIo): Promise<number> {
  const config = await resolveConfig(values);
  const runtime = new DeadDropRuntime({
    config,
    logFormat: values.pretty ? 'pretty' : 'json',
    version: VERSION,
  });
  await runtime.start();
  const socketPath = config.controlSocket ?? defaultSocketPath(config.dataDir);
  const control = await startControlPlane({
    runtime,
    socketPath,
    logger: runtime.logger,
  });
  io.err(`ddrop: runtime listening on ${socketPath}`);
  try {
    await (io.waitForShutdown?.() ?? Promise.resolve());
  } finally {
    await control.close();
    await runtime.stop();
  }
  return 0;
}

async function status(values: Values, io: CliIo): Promise<number> {
  const body = await (await client(values)).request<Record<string, unknown>>('GET', '/status');
  if (values.json) {
    io.out(JSON.stringify(body, null, 2));
    return 0;
  }
  const runtime = body as {
    uptimeMs: number;
    version: string;
    workspaces: Array<{
      name: string;
      peerId: string;
      exposures: string[];
      handlers: string[];
      transports: Array<{ name: string; status: string; score: number; latencyMs?: number }>;
      mailbox: { pollIntervalMs: number; retrying: number };
    }>;
  };
  io.out(`ddrop ${runtime.version}  up ${formatDuration(runtime.uptimeMs)}`);
  for (const workspace of runtime.workspaces) {
    io.out('');
    io.out(`workspace ${workspace.name}  peer ${workspace.peerId}`);
    for (const info of workspace.transports) {
      io.out(
        `  transport ${pad(info.name, 16)} ${pad(info.status, 12)} score ${info.score.toFixed(2)}` +
          `  ${info.latencyMs ?? '?'}ms`,
      );
    }
    io.out(
      `  polling every ${workspace.mailbox.pollIntervalMs}ms, ${workspace.mailbox.retrying} retrying`,
    );
    if (workspace.exposures.length > 0) io.out(`  exposures: ${workspace.exposures.join(', ')}`);
    if (workspace.handlers.length > 0) io.out(`  channels:  ${workspace.handlers.join(', ')}`);
  }
  return 0;
}

async function listWorkspaces(values: Values, io: CliIo): Promise<number> {
  const body = await (await client(values)).request<{ workspaces: string[] }>('GET', '/workspaces');
  io.out(values.json ? JSON.stringify(body, null, 2) : body.workspaces.join('\n'));
  return 0;
}

async function discover(values: Values, io: CliIo): Promise<number> {
  const query = buildQuery(values, values.stale ? { stale: 'true' } : {});
  const body = await (
    await client(values)
  ).request<{
    peers: Array<{ peerId: string; services: string[]; exposures: string[]; announcedAt: number }>;
    unreadable: Array<{ transport: string; message: string }>;
    read: number;
  }>('GET', `/peers${query}`);
  if (values.json) io.out(JSON.stringify(body, null, 2));

  for (const problem of body.unreadable) {
    io.err(`ddrop: could not list ${problem.transport}: ${problem.message}`);
  }
  // Same rule as `queues`: an empty list means "nobody has announced" only if
  // something could be read. Otherwise this printed a reassuring line and
  // exited 0 while the reason sat in a debug log nobody had enabled.
  if (body.read === 0) {
    io.err('ddrop: no store transport could be listed, so no peer can be seen.');
    return 1;
  }

  if (values.json) return 0;
  if (body.peers.length === 0) {
    io.out('No peers have announced themselves yet.');
    return 0;
  }
  for (const peer of body.peers) {
    io.out(`peer ${peer.peerId}`);
    if (peer.exposures.length > 0) io.out(`  exposures: ${peer.exposures.join(', ')}`);
    if (peer.services.length > 0) io.out(`  services:  ${peer.services.join(', ')}`);
    io.out(`  last seen: ${new Date(peer.announcedAt).toISOString()}`);
  }
  return 0;
}

async function queues(values: Values, io: CliIo): Promise<number> {
  const body = await (
    await client(values)
  ).request<{
    peerId: string;
    queues: Array<{ peerId: string; count: number; bytes: number; oldestAt?: number }>;
    unreadable: Array<{ transport: string; message: string }>;
    read: number;
    truncated: boolean;
  }>('GET', `/queues${buildQuery(values)}`);

  // The JSON report carries `read` and `unreadable`, so it stays honest on its
  // own and a script gets the detail as well as the exit code.
  if (values.json) io.out(JSON.stringify(body, null, 2));

  for (const problem of body.unreadable) {
    io.err(`ddrop: could not list ${problem.transport}: ${problem.message}`);
  }
  // Answered before the human report is printed. "Nothing is queued" and "I
  // could not look" read almost the same on a terminal and mean opposite
  // things, so the empty table must not appear when no store was read at all.
  if (body.read === 0) {
    io.err('ddrop: no store transport could be listed, so queue depth is unknown.');
    return 1;
  }
  if (body.truncated) io.err('ddrop: scan limit reached; every count is a lower bound.');

  if (values.json) return 0;
  if (body.queues.length === 0) {
    io.out('No messages are queued.');
    return 0;
  }
  const now = Date.now();
  for (const queue of body.queues) {
    const age = queue.oldestAt === undefined ? '?' : `${formatDuration(now - queue.oldestAt)} ago`;
    io.out(
      `${pad(queue.peerId, 24)} ${String(queue.count).padStart(5)} waiting  ` +
        `${pad(formatBytes(queue.bytes), 10)} oldest ${age}` +
        (queue.peerId === body.peerId ? '  (this peer)' : ''),
    );
  }
  return 0;
}

/**
 * A browser view of everything the read routes of the control plane already
 * return, and nothing else.
 *
 * It binds a TCP port, which at a glance contradicts invariant 3. It does not:
 * the control plane keeps its socket, and this is one more client of it, in the
 * same category as `status` and `queues`. It builds no runtime, so it clones no
 * working directory, announces no phantom peer and writes no beacon commits.
 * See ADR 0004, which is also where the argument for keeping it read-only is.
 */
async function dashboard(values: Values, io: CliIo): Promise<number> {
  const port = dashboardPort(values.port);
  if (port === undefined) {
    io.err('ddrop: --port takes a whole number from 0 to 65535 (0 lets the OS choose)');
    return 2;
  }
  const socketPath = await socketPathFor(values);

  // Not fatal, and deliberately so: a dashboard opened before `ddrop start`, or
  // left open across a restart, is a reasonable thing to do and the page reports
  // the runtime being away on its own. Saying it here as well means a typo in
  // --config does not present as an empty dashboard.
  await new ControlPlaneClient(socketPath).request('GET', '/health').catch((error: unknown) => {
    io.err(`ddrop: ${DeadDropError.from(error).message}`);
    io.err('ddrop: starting anyway; the page will fill in once the runtime is reachable.');
  });

  const handle = await startDashboard({ socketPath, port });
  // Printed before the open is attempted, never after. `open` needs a desktop
  // session, and dead-drop runs on headless machines as an ordinary deployment,
  // where it fails or hangs; with the URL already on screen that is cosmetic.
  io.out(handle.url);
  io.err(`ddrop: read-only dashboard for ${socketPath}. Ctrl-C to stop.`);
  if (values['no-open'] !== true) openBrowser(handle.url, io);
  try {
    await (io.waitForShutdown?.() ?? Promise.resolve());
  } finally {
    await handle.close();
  }
  return 0;
}

/** The requested port, or `undefined` if it is not one. */
function dashboardPort(value: string | boolean | undefined): number | undefined {
  if (typeof value !== 'string') return DEFAULT_DASHBOARD_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return undefined;
  return port;
}

/**
 * Hands the URL to the desktop's browser, and never fails the command for it.
 *
 * Detached with its stdio closed so a browser that has to start does not hold
 * the dashboard's own process open, or write over its output.
 */
function openBrowser(url: string, io: CliIo): void {
  const { command, args } = browserOpenCommand(process.platform, url);
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () =>
      io.err(`ddrop: could not run ${command}; open the URL above yourself.`),
    );
    child.unref();
  } catch {
    io.err(`ddrop: could not run ${command}; open the URL above yourself.`);
  }
}

async function transport(args: string[], values: Values, io: CliIo): Promise<number> {
  const sub = args[0] ?? 'list';
  if (sub !== 'list' && sub !== 'health') {
    io.err('ddrop: transport takes "list" or "health"');
    return 2;
  }
  const body = await (
    await client(values)
  ).request<{
    transports: Array<{
      name: string;
      id: string;
      status: string;
      breaker: string;
      score: number;
      latencyMs?: number;
      errorRate: number;
      rateLimitRemaining?: number;
      message?: string;
    }>;
  }>('GET', `/transports${buildQuery(values)}`);
  if (values.json) {
    io.out(JSON.stringify(body, null, 2));
    return 0;
  }
  for (const info of body.transports) {
    io.out(
      `${pad(info.name, 16)} ${pad(info.id, 14)} ${pad(info.status, 12)} breaker ${pad(info.breaker, 10)}` +
        ` score ${info.score.toFixed(2)}  ${info.latencyMs ?? '?'}ms  errors ${(info.errorRate * 100).toFixed(0)}%`,
    );
    if (sub === 'health' && info.message) io.out(`  ${info.message}`);
    if (sub === 'health' && info.rateLimitRemaining !== undefined) {
      io.out(`  rate limit remaining: ${info.rateLimitRemaining}`);
    }
  }
  return 0;
}

async function expose(args: string[], values: Values, io: CliIo): Promise<number> {
  const directory = args[0];
  const target = typeof values.target === 'string' ? values.target : undefined;
  if (!target && !directory) {
    io.err('ddrop: expose needs --target <url> or a directory argument');
    return 2;
  }
  const name = typeof values.name === 'string' ? values.name : undefined;
  if (!name) {
    io.err('ddrop: expose needs --name <name>');
    return 2;
  }
  const body = target
    ? { name, type: 'http', target }
    : { name, type: 'static', directory: resolve(directory as string) };
  const result = await (
    await client(values)
  ).request<{ name: string; channel: string }>('POST', `/expose${buildQuery(values)}`, body);
  io.out(
    values.json
      ? JSON.stringify(result, null, 2)
      : `Exposed ${target ?? directory} as "${result.name}" on channel ${result.channel}`,
  );
  return 0;
}

async function connectCommand(args: string[], values: Values, io: CliIo): Promise<number> {
  const spec = args[0];
  if (!spec || !spec.includes('/')) {
    io.err('ddrop: connect takes <peer>/<exposure>');
    return 2;
  }
  const separator = spec.indexOf('/');
  const target = spec.slice(0, separator);
  const exposure = spec.slice(separator + 1);

  // Connecting needs a live workspace in this process: the local HTTP server
  // has to translate requests, and routing them through the control plane would
  // mean base64-ing every request body through a second JSON hop.
  //
  // That means this process is a second peer, so it must not claim the mailbox
  // address of an already-running `ddrop start`: two runtimes polling one inbox
  // would race for the same messages and lose responses. `sessionId` gives it
  // its own address while it keeps the configured peer id as its identity, so
  // an exposure's `allowPeers` list still recognises it. Rewriting the config's
  // `peerId` here, which is what this used to do, changed both at once and made
  // `allowPeers` impossible to write.
  const config = await resolveConfig(values);
  const runtime = new DeadDropRuntime({
    config,
    logFormat: 'pretty',
    version: VERSION,
    sessionId: process.pid.toString(16),
  });
  await runtime.start();
  const workspace =
    typeof values.workspace === 'string'
      ? runtime.workspace(values.workspace)
      : runtime.defaultWorkspace();

  const handle = await connect({
    workspace,
    target,
    exposure,
    port: values.port ? Number(values.port) : 0,
    logger: runtime.logger,
    ...(values.timeout ? { timeoutMs: Number(values.timeout) } : {}),
  });
  io.out(handle.url);
  io.err(`ddrop: forwarding ${handle.url} -> ${target}/${exposure}`);
  try {
    await (io.waitForShutdown?.() ?? Promise.resolve());
  } finally {
    await handle.close();
    await runtime.stop();
  }
  return 0;
}

async function call(args: string[], values: Values, io: CliIo): Promise<number> {
  const [target, channel] = args;
  if (!target || !channel) {
    io.err('ddrop: call takes <peer> <channel>');
    return 2;
  }
  const input = parseInput(values.input);
  const body = await (
    await client(values)
  ).request<{ result: unknown }>(
    'POST',
    `/call${buildQuery(values)}`,
    { target, channel, input, ...(values.timeout ? { timeoutMs: Number(values.timeout) } : {}) },
    { timeoutMs: values.timeout ? Number(values.timeout) + 5000 : 120_000 },
  );
  io.out(JSON.stringify(body.result, null, 2));
  return 0;
}

async function publish(args: string[], values: Values, io: CliIo): Promise<number> {
  const channel = args[0];
  if (!channel) {
    io.err('ddrop: publish takes <channel>');
    return 2;
  }
  const body = await (
    await client(values)
  ).request<{ id: string }>('POST', `/publish${buildQuery(values)}`, {
    channel,
    payload: parseInput(values.input),
  });
  io.out(values.json ? JSON.stringify(body, null, 2) : body.id);
  return 0;
}

async function logs(values: Values, io: CliIo): Promise<number> {
  const params = new URLSearchParams();
  if (typeof values.limit === 'string') params.set('limit', values.limit);
  if (typeof values.level === 'string') params.set('level', values.level);
  const query = params.toString();
  const body = await (
    await client(values)
  ).request<{ records: LogRecord[] }>('GET', `/logs${query ? `?${query}` : ''}`);
  if (values.json) {
    io.out(JSON.stringify(body, null, 2));
    return 0;
  }
  const write = prettySink((line) => io.out(line));
  for (const record of body.records) write(record);
  return 0;
}

/**
 * With an id, one trace as a span tree. Without, the recent traces so there is
 * something to copy an id out of — a trace id is not guessable, and the runtime
 * only prints one on the request that produced it.
 */
async function trace(args: string[], values: Values, io: CliIo): Promise<number> {
  const traceId = args[0];
  const query = traceId === undefined ? '' : `?id=${encodeURIComponent(traceId)}`;
  const body = await (await client(values)).request<{ spans: Span[] }>('GET', `/traces${query}`);
  if (values.json) {
    io.out(JSON.stringify(body, null, 2));
    return 0;
  }
  if (body.spans.length === 0) {
    io.out(
      traceId === undefined
        ? 'No traces recorded yet.'
        : `No spans recorded for trace ${traceId}. The buffer keeps the most recent 500.`,
    );
    return 0;
  }
  if (traceId === undefined) printTraceList(body.spans, io);
  else printSpanTree(body.spans, io);
  return 0;
}

function printTraceList(spans: Span[], io: CliIo): void {
  const traces = new Map<string, Span[]>();
  for (const span of spans) {
    const group = traces.get(span.traceId);
    if (group) group.push(span);
    else traces.set(span.traceId, [span]);
  }
  io.out(`${pad('trace', 32)}${pad('spans', 7)}${pad('duration', 10)}${pad('status', 8)}root`);
  for (const [traceId, group] of traces) {
    // Prefer a span with no parent. Falling back to the earliest start is not
    // enough on its own: spans are recorded when they finish, and at millisecond
    // resolution a child that finished first can tie with its parent and win.
    const root =
      group.find((span) => span.parentSpanId === undefined) ??
      group.reduce((first, span) => (span.startedAt < first.startedAt ? span : first));
    const started = Math.min(...group.map((span) => span.startedAt));
    const ended = Math.max(...group.map((span) => span.endedAt ?? span.startedAt));
    const status = group.some((span) => span.status === 'error') ? 'error' : root.status;
    io.out(
      pad(traceId, 32) +
        pad(String(group.length), 7) +
        pad(`${ended - started}ms`, 10) +
        pad(status, 8) +
        root.name,
    );
  }
  io.out('');
  io.out('ddrop trace <traceId> expands one of them.');
}

function printSpanTree(spans: Span[], io: CliIo): void {
  const ids = new Set(spans.map((span) => span.spanId));
  const children = new Map<string, Span[]>();
  const roots: Span[] = [];
  for (const span of spans) {
    // A span whose parent was evicted from the buffer is shown as a root rather
    // than dropped: a partial tree is still worth reading.
    const parent = span.parentSpanId;
    if (parent !== undefined && ids.has(parent)) {
      const siblings = children.get(parent);
      if (siblings) siblings.push(span);
      else children.set(parent, [span]);
    } else {
      roots.push(span);
    }
  }

  const walk = (span: Span, depth: number): void => {
    const attributes = Object.entries(span.attributes)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ');
    const duration = span.durationMs === undefined ? 'open' : `${span.durationMs}ms`;
    io.out(
      '  '.repeat(depth) +
        pad(span.name, 34 - depth * 2) +
        pad(duration, 10) +
        pad(span.status, 10) +
        attributes,
    );
    for (const event of span.events) {
      io.out(`${'  '.repeat(depth + 1)}· ${event.name}`);
    }
    for (const child of children.get(span.spanId) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
}

async function metrics(values: Values, io: CliIo): Promise<number> {
  io.out(await (await client(values)).request<string>('GET', '/metrics'));
  return 0;
}

// ------------------------------------------------------------------- helpers

/**
 * Where the runtime is listening.
 *
 * `ddrop start` derives its socket from the config's `dataDir`, so a client
 * that assumed the default data dir would miss every runtime started from a
 * project-local config — which is exactly what `ddrop init` writes. `--socket`
 * still wins, and a missing config is not an error here: a runtime started
 * without one listens on the default path.
 */
async function client(values: Values): Promise<ControlPlaneClient> {
  return new ControlPlaneClient(await socketPathFor(values));
}

/** The path itself, which `ddrop dashboard` reports and reuses. */
async function socketPathFor(values: Values): Promise<string> {
  if (typeof values.socket === 'string') return values.socket;
  const path = await findConfigPath(values);
  if (path === undefined) return defaultSocketPath(DEFAULT_DATA_DIR);
  const config = await loadRuntimeConfig(path);
  return config.controlSocket ?? defaultSocketPath(config.dataDir);
}

function buildQuery(values: Values, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  if (typeof values.workspace === 'string') params.set('workspace', values.workspace);
  const text = params.toString();
  return text ? `?${text}` : '';
}

function configCandidates(): string[] {
  return [resolve('deaddrop.config.json'), resolve(DEFAULT_DATA_DIR, 'config.json')];
}

/** Config discovery: explicit flag, then the working directory, then the home dir. */
async function findConfigPath(values: Values): Promise<string | undefined> {
  // An explicit --config that cannot be read is a mistake worth naming exactly,
  // not something to paper over by falling back to a different file, so it is
  // returned unchecked and left for the loader to complain about.
  if (typeof values.config === 'string') return resolve(values.config);

  for (const candidate of configCandidates()) {
    try {
      await readFile(candidate);
    } catch {
      continue;
    }
    return candidate;
  }
  return undefined;
}

async function resolveConfig(values: Values): Promise<RuntimeConfig> {
  const path = await findConfigPath(values);
  if (path !== undefined) return loadRuntimeConfig(path);
  throw new DeadDropError(
    'CONFIG_INVALID',
    `no config file found (looked in ${configCandidates().join(', ')}). Run "ddrop init" to create one.`,
  );
}

function parseInput(value: string | boolean | undefined): unknown {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    // A bare string is a reasonable thing to type on a command line.
    return value;
  }
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Exported for tests that need a logger without a runtime. */
export const cliLogger = createLogger({ level: 'warn', sink: prettySink() });
