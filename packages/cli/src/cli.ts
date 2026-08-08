/**
 * The `bridge` command.
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
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { BridgeError, generateWorkspaceSecret } from '@fyrlabs/dead-drop-protocol';
import { createLogger, prettySink, type LogRecord, type Span } from '@fyrlabs/dead-drop-core';
import {
  BridgeRuntime,
  ControlPlaneClient,
  DEFAULT_DATA_DIR,
  connect,
  defaultSocketPath,
  loadRuntimeConfig,
  startControlPlane,
  type RuntimeConfig,
} from '@fyrlabs/dead-drop-runtime';

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

const USAGE = `bridge — a transport-agnostic runtime for distributed applications

Usage
  bridge start [--config <file>]              run the runtime in the foreground
  bridge status [--json]                      show runtime, workspace and transport state
  bridge list                                 list workspaces
  bridge discover [--json] [--stale]          list peers visible in the workspace
  bridge transport list [--json]              show transports and their scores
  bridge transport health [--json]            re-probe transports and show health
  bridge expose --target <url> --name <name>  expose a local http server
  bridge expose <dir> --name <name>           expose a directory of static files
  bridge connect <peer>/<exposure> [--port n] serve a remote exposure locally
  bridge call <peer> <channel> [--input json] make an rpc call
  bridge publish <channel> [--input json]     broadcast an event
  bridge logs [--limit n] [--level warn]      recent runtime logs
  bridge trace [<traceId>]                    recent traces, or one trace as a span tree
  bridge metrics                              Prometheus metrics
  bridge keygen                               print a new workspace secret
  bridge init [--name <workspace>]            write a starter bridge.config.json

Global options
  --config <file>    config file (default ./bridge.config.json, then ~/.bridge/config.json)
  --workspace <name> workspace to act on (default: the runtime's first)
  --socket <path>    control plane socket (default <dataDir>/bridge.sock)
  --json             machine-readable output
  --help, --version
`;

export const VERSION = '0.1.0';

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
        port: { type: 'string' },
        input: { type: 'string' },
        limit: { type: 'string' },
        level: { type: 'string' },
        timeout: { type: 'string' },
        json: { type: 'boolean' },
        stale: { type: 'boolean' },
        pretty: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    io.err(`bridge: ${(error as Error).message}`);
    io.err('Run "bridge --help" for usage.');
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
    const bridgeError = BridgeError.from(error);
    if (values.json) {
      io.out(JSON.stringify({ error: bridgeError.toJSON() }, null, 2));
    } else {
      io.err(`bridge: ${bridgeError.message}`);
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
      io.err(`bridge: unknown command "${command}"`);
      io.err('Run "bridge --help" for usage.');
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
    io.err('Anyone holding it can read and write the workspace. Store it in a secret manager');
    io.err('and reference it from the config as "${env:BRIDGE_SECRET}".');
  }
  return 0;
}

async function init(values: Values, io: CliIo): Promise<number> {
  const name = typeof values.name === 'string' ? values.name : 'default';
  const path = resolve(typeof values.config === 'string' ? values.config : 'bridge.config.json');
  const config = {
    dataDir: '.bridge',
    logLevel: 'info',
    workspaces: [
      {
        name,
        secrets: ['${env:BRIDGE_SECRET}'],
        transports: [{ use: 'filesystem', config: { root: './.bridge/store' } }],
        exposures: [],
      },
    ],
  };
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') {
        throw new BridgeError('CONFIG_INVALID', `${path} already exists; refusing to overwrite it`);
      }
      throw error;
    },
  );
  io.out(`Wrote ${path}`);
  io.err('Next: export BRIDGE_SECRET="$(bridge keygen)" && bridge start');
  return 0;
}

async function start(values: Values, io: CliIo): Promise<number> {
  const config = await resolveConfig(values);
  const runtime = new BridgeRuntime({
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
  io.err(`bridge: runtime listening on ${socketPath}`);
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
  io.out(`bridge ${runtime.version}  up ${formatDuration(runtime.uptimeMs)}`);
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
  }>('GET', `/peers${query}`);
  if (values.json) {
    io.out(JSON.stringify(body, null, 2));
    return 0;
  }
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

async function transport(args: string[], values: Values, io: CliIo): Promise<number> {
  const sub = args[0] ?? 'list';
  if (sub !== 'list' && sub !== 'health') {
    io.err('bridge: transport takes "list" or "health"');
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
    io.err('bridge: expose needs --target <url> or a directory argument');
    return 2;
  }
  const name = typeof values.name === 'string' ? values.name : undefined;
  if (!name) {
    io.err('bridge: expose needs --name <name>');
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
    io.err('bridge: connect takes <peer>/<exposure>');
    return 2;
  }
  const separator = spec.indexOf('/');
  const target = spec.slice(0, separator);
  const exposure = spec.slice(separator + 1);

  // Connecting needs a live workspace in this process: the local HTTP server
  // has to translate requests, and routing them through the control plane would
  // mean base64-ing every request body through a second JSON hop.
  //
  // That means this process is a second peer, so it must not claim the peer id
  // of an already-running `bridge start`: two runtimes polling one inbox would
  // race for the same messages and lose responses. It gets its own ephemeral
  // identity, and withdraws its presence beacon on exit.
  const base = await resolveConfig(values);
  const config: RuntimeConfig = {
    ...base,
    workspaces: base.workspaces.map((workspace) => ({
      ...workspace,
      peerId: `${workspace.peerId ?? 'peer'}-c${process.pid.toString(16)}`,
    })),
  };
  const runtime = new BridgeRuntime({ config, logFormat: 'pretty', version: VERSION });
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
  io.err(`bridge: forwarding ${handle.url} -> ${target}/${exposure}`);
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
    io.err('bridge: call takes <peer> <channel>');
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
    io.err('bridge: publish takes <channel>');
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
  io.out('bridge trace <traceId> expands one of them.');
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
 * `bridge start` derives its socket from the config's `dataDir`, so a client
 * that assumed the default data dir would miss every runtime started from a
 * project-local config — which is exactly what `bridge init` writes. `--socket`
 * still wins, and a missing config is not an error here: a runtime started
 * without one listens on the default path.
 */
async function client(values: Values): Promise<ControlPlaneClient> {
  if (typeof values.socket === 'string') return new ControlPlaneClient(values.socket);
  const path = await findConfigPath(values);
  if (path === undefined) return new ControlPlaneClient(defaultSocketPath(DEFAULT_DATA_DIR));
  const config = await loadRuntimeConfig(path);
  return new ControlPlaneClient(config.controlSocket ?? defaultSocketPath(config.dataDir));
}

function buildQuery(values: Values, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  if (typeof values.workspace === 'string') params.set('workspace', values.workspace);
  const text = params.toString();
  return text ? `?${text}` : '';
}

function configCandidates(): string[] {
  return [resolve('bridge.config.json'), resolve(DEFAULT_DATA_DIR, 'config.json')];
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
  throw new BridgeError(
    'CONFIG_INVALID',
    `no config file found (looked in ${configCandidates().join(', ')}). Run "bridge init" to create one.`,
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
