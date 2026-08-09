/**
 * Runtime configuration.
 *
 * Config is data, not code: it is read from JSON so the CLI, a container image
 * and a test can all produce the same runtime. Transport plugins are named by
 * package specifier and loaded at start-up, which is what lets a third-party
 * adapter be used without changing dead-drop.
 *
 * Secrets are never written here in plain text by us. `${env:NAME}` and
 * `${file:PATH}` references are expanded at load time so the config file can
 * live in version control with the secret beside it rather than inside it.
 */

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import { DeadDropError, isValidName } from '../protocol/index.js';
import type { CircuitBreakerOptions, JitterMode, LogLevel, RetryPolicy } from '../core/index.js';
import { isLogLevel } from '../core/index.js';

export interface TransportConfigEntry {
  /**
   * Package specifier or built-in id: `filesystem`, `memory`, `git`,
   * `@my-company/deaddrop-transport-foo`, or a relative path to a local module.
   */
  use: string;
  /** Instance name, defaulting to the transport's own id. */
  name?: string;
  config?: unknown;
}

export interface ExposureConfig {
  name: string;
  /** `http` proxies to a local server; `static` serves a directory. */
  type: 'http' | 'static';
  /** Origin for `http`, e.g. `http://localhost:3000`. */
  target?: string;
  /** Directory for `static`. */
  directory?: string;
  /** Peers allowed to call this exposure. Omit to allow every workspace member. */
  allowPeers?: string[];
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
}

export interface WorkspaceConfig {
  name: string;
  /** Stable identity of this machine within the workspace. */
  peerId?: string;
  /**
   * Workspace secrets. The first is used to encrypt; the rest are still
   * accepted, which is what makes key rotation possible without downtime.
   */
  secrets: string[];
  transports: TransportConfigEntry[];
  policy?: {
    mode?: 'failover' | 'parallel' | 'score';
    primary?: string;
    fallback?: string[];
  };
  exposures?: ExposureConfig[];
  /** Broadcast channels this workspace subscribes to at start-up. */
  subscribe?: string[];
  polling?: {
    minIntervalMs?: number;
    maxIntervalMs?: number;
  };
  /**
   * How a failed transport operation is retried, merged over the defaults
   * (5 attempts, 200ms initial, 30s cap, factor 2, full jitter).
   *
   * Raising `maxAttempts` alone usually buys nothing. Since 0.3.0 the request
   * timeout bounds the whole request, send included, so extra attempts are cut
   * off by the deadline rather than run; `requestTimeoutMs` has to move with it.
   */
  retry?: Partial<RetryPolicy>;
  /**
   * When a transport is taken out of rotation and when it is probed again.
   * Defaults: 5 consecutive failures to open, 30s before a probe, 2 successes
   * to close.
   */
  breaker?: Pick<CircuitBreakerOptions, 'failureThreshold' | 'resetTimeoutMs' | 'successThreshold'>;
  /**
   * How often every transport is probed for health. Default 30000.
   *
   * This is what decides how quickly `ddrop transport health` and the failover
   * scores notice that a transport has died: the reported status changes on a
   * sweep, not on the failure itself. Lower it for a local transport where a
   * probe is nearly free and you want detection to be quick. Raise it for one
   * where a probe costs something real -- the github transport spends an API
   * call on every sweep -- and accept slower detection in exchange.
   */
  healthIntervalMs?: number;
  /**
   * How often this peer republishes its presence beacon. Default 30000.
   *
   * A peer is considered gone once its beacon is three intervals old, so this
   * sets both how quickly `ddrop discover` sees a new peer and how long it
   * keeps listing a departed one -- at the default, up to 90 seconds stale.
   * Lower it where writes are cheap and discovery should be quick. Every peer
   * writes one object per interval, so on a transport where a write costs an
   * API call or a commit, that is the price to weigh.
   */
  presenceIntervalMs?: number;
  /** Default request timeout for this workspace. Default 30000. */
  requestTimeoutMs?: number;
  /**
   * How many inbound messages this workspace handles at once. Default 1.
   *
   * At 1 a poll that finds several messages works through them one at a time,
   * so a slow handler holds up everything behind it. Raising it removes that
   * head-of-line blocking, which is worth doing when handlers spend their time
   * waiting on I/O rather than on CPU.
   *
   * The trade is ordering: concurrent handlers finish in whatever order they
   * finish, so a peer can see two of its messages answered out of the order it
   * sent them. Delivery has only ever promised best-effort ordering per
   * recipient, but a handler written against the serial behaviour can still
   * notice, which is why the default is 1.
   */
  concurrency?: number;
}

export interface RuntimeConfig {
  /** Directory for runtime state: sockets, dedupe caches, logs. */
  dataDir: string;
  logLevel: LogLevel;
  /** Unix socket (or Windows named pipe) the control plane listens on. */
  controlSocket?: string;
  workspaces: WorkspaceConfig[];
}

export const DEFAULT_DATA_DIR = resolve(homedir(), '.deaddrop');

/**
 * Resolves a path from the config file.
 *
 * A leading `~` is expanded because people write it and a config file is not a
 * shell: left alone it resolves to a literal directory named `~` beside the
 * config, which fails silently and confusingly. Everything else relative is
 * resolved against the config file's directory, not the working directory, so a
 * config means the same thing wherever it is run from.
 */
function resolveConfigPath(value: string, baseDir: string | undefined): string {
  if (value === '~' || value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  if (isAbsolute(value)) return value;
  return resolve(baseDir ?? process.cwd(), value);
}

/** Expands `${env:NAME}` references. Throws if a referenced variable is unset. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) {
      throw new DeadDropError(
        'CONFIG_INVALID',
        `config references unset environment variable ${name}`,
      );
    }
    return resolved;
  });
}

/**
 * Expands `${env:NAME}` and `${file:PATH}` in one pass.
 *
 * One pass rather than two on purpose: a replacement is never rescanned, so a
 * secret file whose contents happen to contain `${env:...}`, or an environment
 * variable holding `${file:...}`, is data and not another reference to follow.
 *
 * `file:` exists so a config can be committed and copied between machines while
 * the workspace secret stays out of it. `ddrop init` writes the secret beside
 * the config and points at it this way, which is what removes the export step
 * that used to stand between `init` and a runtime that starts.
 */
function expandRefs(value: string, env: NodeJS.ProcessEnv, baseDir: string | undefined): string {
  return value.replace(/\$\{(env|file):([^}]+)\}/g, (_match, kind: string, ref: string) => {
    if (kind === 'env') {
      const resolved = env[ref];
      if (resolved === undefined) {
        fail(`config references unset environment variable ${ref}`);
      }
      return resolved;
    }
    const path = resolveConfigPath(ref.trim(), baseDir);
    let contents: string;
    try {
      contents = readFileSync(path, 'utf8');
    } catch {
      fail(`config references ${path}, which could not be read`);
    }
    // Trimmed because a secret written by an editor or a shell redirect carries
    // a trailing newline, and a key with a newline on the end is not the key.
    return contents.trim();
  });
}

function expandDeep(value: unknown, env: NodeJS.ProcessEnv, baseDir: string | undefined): unknown {
  if (typeof value === 'string') return expandRefs(value, env, baseDir);
  if (Array.isArray(value)) return value.map((item) => expandDeep(item, env, baseDir));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        expandDeep(item, env, baseDir),
      ]),
    );
  }
  return value;
}

/**
 * The marker `ddrop init` leaves where it cannot choose for you.
 *
 * A shared location is the one thing no default can guess, and the old default
 * -- a path under the local data directory -- was the worst possible answer: two
 * machines each started cleanly, each wrote into their own folder, and neither
 * ever saw the other. Failing at load with the field named beats that.
 */
const PLACEHOLDER = 'REPLACE-ME';

function assertNoPlaceholder(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (value.includes(PLACEHOLDER)) {
      fail(
        `${path} is still the placeholder "ddrop init" wrote. ` +
          `Set it to something every peer can reach, then start again.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPlaceholder(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assertNoPlaceholder(item, `${path}.${key}`);
    }
  }
}

/**
 * Declared as a function, not a const arrow: TypeScript only narrows control
 * flow after a `never`-returning call when the callee is a function declaration
 * (or an explicitly annotated const), and losing that narrowing here would mean
 * casting after every validation branch.
 */
function fail(message: string): never {
  throw new DeadDropError('CONFIG_INVALID', message);
}

export function parseRuntimeConfig(
  raw: unknown,
  options: { env?: NodeJS.ProcessEnv; baseDir?: string } = {},
): RuntimeConfig {
  const env = options.env ?? process.env;
  // Before expansion: a placeholder is what the author left behind, and saying
  // so beats reporting whatever the unedited value fails as three layers down.
  assertNoPlaceholder(raw, 'config');
  const expanded = expandDeep(raw, env, options.baseDir);
  if (typeof expanded !== 'object' || expanded === null || Array.isArray(expanded)) {
    fail('configuration must be a JSON object');
  }
  const source = expanded as Record<string, unknown>;

  const dataDirRaw = typeof source.dataDir === 'string' ? source.dataDir : DEFAULT_DATA_DIR;
  const dataDir = resolveConfigPath(dataDirRaw, options.baseDir);

  if (source.logLevel !== undefined && !isLogLevel(source.logLevel)) {
    fail(`logLevel must be one of debug, info, warn, error, silent`);
  }
  if (!Array.isArray(source.workspaces) || source.workspaces.length === 0) {
    fail('configuration must define at least one workspace');
  }

  const workspaces = (source.workspaces as unknown[]).map((entry, index) =>
    parseWorkspace(entry, index, options.baseDir),
  );
  const names = new Set<string>();
  for (const workspace of workspaces) {
    if (names.has(workspace.name)) fail(`duplicate workspace name "${workspace.name}"`);
    names.add(workspace.name);
  }

  const config: RuntimeConfig = {
    dataDir,
    logLevel: isLogLevel(source.logLevel) ? source.logLevel : 'info',
    workspaces,
  };
  if (typeof source.controlSocket === 'string') {
    config.controlSocket = resolveConfigPath(source.controlSocket, options.baseDir);
  }
  return config;
}

function parseWorkspace(raw: unknown, index: number, baseDir?: string): WorkspaceConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(`workspace at index ${index} must be an object`);
  }
  const source = raw as Record<string, unknown>;
  const label = typeof source.name === 'string' ? source.name : `index ${index}`;

  if (typeof source.name !== 'string' || !isValidName(source.name)) {
    fail(`workspace ${label}: name must be alphanumeric with . _ - separators`);
  }
  if (
    source.peerId !== undefined &&
    (typeof source.peerId !== 'string' || !isValidName(source.peerId))
  ) {
    fail(`workspace ${label}: peerId must be alphanumeric with . _ - separators`);
  }
  if (!Array.isArray(source.secrets) || source.secrets.length === 0) {
    fail(`workspace ${label}: at least one secret is required (run "ddrop keygen")`);
  }
  for (const secret of source.secrets) {
    if (typeof secret !== 'string') fail(`workspace ${label}: secrets must be strings`);
  }
  if (!Array.isArray(source.transports) || source.transports.length === 0) {
    fail(`workspace ${label}: at least one transport is required`);
  }

  const transports = (source.transports as unknown[]).map((entry, position) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail(`workspace ${label}: transport at index ${position} must be an object`);
    }
    const item = entry as Record<string, unknown>;
    if (typeof item.use !== 'string' || item.use.length === 0) {
      fail(`workspace ${label}: transport at index ${position} needs a "use" specifier`);
    }
    const parsed: TransportConfigEntry = { use: item.use };
    if (item.name !== undefined) {
      if (typeof item.name !== 'string')
        fail(`workspace ${label}: transport name must be a string`);
      parsed.name = item.name;
    }
    if (item.config !== undefined) parsed.config = resolvePaths(item.config, baseDir);
    return parsed;
  });

  const workspace: WorkspaceConfig = {
    name: source.name,
    secrets: source.secrets as string[],
    transports,
  };
  if (typeof source.peerId === 'string') workspace.peerId = source.peerId;
  if (source.policy !== undefined) workspace.policy = parsePolicy(source.policy, label);
  if (source.exposures !== undefined) {
    if (!Array.isArray(source.exposures)) fail(`workspace ${label}: exposures must be an array`);
    workspace.exposures = source.exposures.map((entry, position) =>
      parseExposure(entry, `${label} exposure ${position}`, baseDir),
    );
  }
  if (source.subscribe !== undefined) {
    if (!Array.isArray(source.subscribe)) fail(`workspace ${label}: subscribe must be an array`);
    workspace.subscribe = source.subscribe.map((channel) => {
      if (typeof channel !== 'string')
        fail(`workspace ${label}: subscribe entries must be strings`);
      return channel;
    });
  }
  if (source.requestTimeoutMs !== undefined) {
    if (typeof source.requestTimeoutMs !== 'number' || source.requestTimeoutMs <= 0) {
      fail(`workspace ${label}: requestTimeoutMs must be a positive number`);
    }
    workspace.requestTimeoutMs = source.requestTimeoutMs;
  }
  if (source.healthIntervalMs !== undefined) {
    if (typeof source.healthIntervalMs !== 'number' || source.healthIntervalMs <= 0) {
      fail(`workspace ${label}: healthIntervalMs must be a positive number`);
    }
    workspace.healthIntervalMs = source.healthIntervalMs;
  }
  if (source.presenceIntervalMs !== undefined) {
    if (typeof source.presenceIntervalMs !== 'number' || source.presenceIntervalMs <= 0) {
      fail(`workspace ${label}: presenceIntervalMs must be a positive number`);
    }
    workspace.presenceIntervalMs = source.presenceIntervalMs;
  }
  if (source.concurrency !== undefined) {
    if (
      typeof source.concurrency !== 'number' ||
      !Number.isInteger(source.concurrency) ||
      source.concurrency < 1
    ) {
      fail(`workspace ${label}: concurrency must be a whole number of at least 1`);
    }
    workspace.concurrency = source.concurrency;
  }
  if (source.polling !== undefined) {
    if (typeof source.polling !== 'object' || source.polling === null) {
      fail(`workspace ${label}: polling must be an object`);
    }
    workspace.polling = source.polling as WorkspaceConfig['polling'];
  }
  if (source.retry !== undefined) {
    workspace.retry = parseRetry(source.retry, label);
  }
  if (source.breaker !== undefined) {
    workspace.breaker = parseBreaker(source.breaker, label);
  }
  return workspace;
}

const JITTER_MODES: readonly JitterMode[] = ['none', 'full', 'equal'];

/**
 * Checks each field rather than accepting any object.
 *
 * These are the numbers people reach for when something is timing out, and a
 * typo has to be a start-up error naming the field. A `maxAttempts` of `"5"`
 * that silently fell back to the default would be indistinguishable from the
 * knob not working, which is worse than not having the knob.
 */
function parseTuning<T>(
  raw: unknown,
  label: string,
  field: string,
  numeric: readonly string[],
  extra: (key: string, value: unknown) => boolean = () => false,
): T {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(`workspace ${label}: ${field} must be an object`);
  }
  const source = raw as Record<string, unknown>;
  for (const [key, value] of Object.entries(source)) {
    if (extra(key, value)) continue;
    if (!numeric.includes(key)) {
      fail(`workspace ${label}: ${field}.${key} is not a known option`);
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      fail(`workspace ${label}: ${field}.${key} must be a number greater than zero`);
    }
  }
  return source as T;
}

function parseRetry(raw: unknown, label: string): Partial<RetryPolicy> {
  return parseTuning<Partial<RetryPolicy>>(
    raw,
    label,
    'retry',
    ['maxAttempts', 'initialDelayMs', 'maxDelayMs', 'factor', 'maxElapsedMs'],
    (key, value) => {
      if (key !== 'jitter') return false;
      if (!JITTER_MODES.includes(value as JitterMode)) {
        fail(`workspace ${label}: retry.jitter must be one of ${JITTER_MODES.join(', ')}`);
      }
      return true;
    },
  );
}

function parseBreaker(raw: unknown, label: string): WorkspaceConfig['breaker'] {
  return parseTuning<NonNullable<WorkspaceConfig['breaker']>>(raw, label, 'breaker', [
    'failureThreshold',
    'resetTimeoutMs',
    'successThreshold',
  ]);
}

function parsePolicy(raw: unknown, label: string): WorkspaceConfig['policy'] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(`workspace ${label}: policy must be an object`);
  }
  const source = raw as Record<string, unknown>;
  if (
    source.mode !== undefined &&
    !['failover', 'parallel', 'score'].includes(source.mode as string)
  ) {
    fail(`workspace ${label}: policy.mode must be failover, parallel or score`);
  }
  return source as WorkspaceConfig['policy'];
}

function parseExposure(raw: unknown, label: string, baseDir?: string): ExposureConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(`${label} must be an object`);
  }
  const source = raw as Record<string, unknown>;
  if (typeof source.name !== 'string' || !isValidName(source.name)) {
    fail(`${label}: name must be alphanumeric with . _ - separators`);
  }
  if (source.type !== 'http' && source.type !== 'static') {
    fail(`${label}: type must be "http" or "static"`);
  }
  const exposure: ExposureConfig = { name: source.name, type: source.type };
  if (source.type === 'http') {
    if (typeof source.target !== 'string') fail(`${label}: http exposures need a "target" url`);
    let url: URL;
    try {
      url = new URL(source.target as string);
    } catch {
      return fail(`${label}: target must be an absolute url`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      fail(`${label}: target must be http or https`);
    }
    exposure.target = source.target as string;
  } else {
    if (typeof source.directory !== 'string') {
      fail(`${label}: static exposures need a "directory"`);
    }
    exposure.directory = resolveConfigPath(source.directory as string, baseDir);
  }
  if (source.allowPeers !== undefined) {
    if (!Array.isArray(source.allowPeers)) fail(`${label}: allowPeers must be an array`);
    exposure.allowPeers = source.allowPeers as string[];
  }
  if (source.timeoutMs !== undefined) {
    if (typeof source.timeoutMs !== 'number' || source.timeoutMs <= 0) {
      fail(`${label}: timeoutMs must be a positive number`);
    }
    exposure.timeoutMs = source.timeoutMs;
  }
  return exposure;
}

/** Makes filesystem-ish transport config values absolute relative to the config file. */
function resolvePaths(config: unknown, baseDir?: string): unknown {
  if (!baseDir || typeof config !== 'object' || config === null || Array.isArray(config)) {
    return config;
  }
  const source = { ...(config as Record<string, unknown>) };
  for (const key of ['root', 'workDir', 'directory', 'path']) {
    const value = source[key];
    if (typeof value === 'string') source[key] = resolveConfigPath(value, baseDir);
  }
  return source;
}

export async function loadRuntimeConfig(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    throw new DeadDropError('CONFIG_INVALID', `cannot read config file ${path}`, { cause });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new DeadDropError('CONFIG_INVALID', `config file ${path} is not valid JSON`, { cause });
  }
  return parseRuntimeConfig(parsed, { env, baseDir: resolve(path, '..') });
}
