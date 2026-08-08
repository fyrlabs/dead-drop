/**
 * Runtime configuration.
 *
 * Config is data, not code: it is read from JSON so the CLI, a container image
 * and a test can all produce the same runtime. Transport plugins are named by
 * package specifier and loaded at start-up, which is what lets a third-party
 * adapter be used without changing Bridge.
 *
 * Secrets are never written here in plain text by us. `${env:NAME}` references
 * are expanded at load time so the config file can live in version control.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import { BridgeError, isValidName } from '@dead-drop/protocol';
import type { LogLevel } from '@dead-drop/core';
import { isLogLevel } from '@dead-drop/core';

export interface TransportConfigEntry {
  /**
   * Package specifier or built-in id: `filesystem`, `memory`, `git`,
   * `@my-company/bridge-transport-foo`, or a relative path to a local module.
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
  /** Default request timeout for this workspace. Default 30000. */
  requestTimeoutMs?: number;
}

export interface RuntimeConfig {
  /** Directory for runtime state: sockets, dedupe caches, logs. */
  dataDir: string;
  logLevel: LogLevel;
  /** Unix socket (or Windows named pipe) the control plane listens on. */
  controlSocket?: string;
  workspaces: WorkspaceConfig[];
}

export const DEFAULT_DATA_DIR = resolve(homedir(), '.bridge');

/** Expands `${env:NAME}` references. Throws if a referenced variable is unset. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) {
      throw new BridgeError(
        'CONFIG_INVALID',
        `config references unset environment variable ${name}`,
      );
    }
    return resolved;
  });
}

function expandDeep(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') return expandEnv(value, env);
  if (Array.isArray(value)) return value.map((item) => expandDeep(item, env));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        expandDeep(item, env),
      ]),
    );
  }
  return value;
}

/**
 * Declared as a function, not a const arrow: TypeScript only narrows control
 * flow after a `never`-returning call when the callee is a function declaration
 * (or an explicitly annotated const), and losing that narrowing here would mean
 * casting after every validation branch.
 */
function fail(message: string): never {
  throw new BridgeError('CONFIG_INVALID', message);
}

export function parseRuntimeConfig(
  raw: unknown,
  options: { env?: NodeJS.ProcessEnv; baseDir?: string } = {},
): RuntimeConfig {
  const env = options.env ?? process.env;
  const expanded = expandDeep(raw, env);
  if (typeof expanded !== 'object' || expanded === null || Array.isArray(expanded)) {
    fail('configuration must be a JSON object');
  }
  const source = expanded as Record<string, unknown>;

  const dataDirRaw = typeof source.dataDir === 'string' ? source.dataDir : DEFAULT_DATA_DIR;
  const dataDir = isAbsolute(dataDirRaw)
    ? dataDirRaw
    : resolve(options.baseDir ?? process.cwd(), dataDirRaw);

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
  if (typeof source.controlSocket === 'string') config.controlSocket = source.controlSocket;
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
    fail(`workspace ${label}: at least one secret is required (run "bridge keygen")`);
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
  if (source.polling !== undefined) {
    if (typeof source.polling !== 'object' || source.polling === null) {
      fail(`workspace ${label}: polling must be an object`);
    }
    workspace.polling = source.polling as WorkspaceConfig['polling'];
  }
  return workspace;
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
    exposure.directory = resolve(baseDir ?? process.cwd(), source.directory as string);
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
    if (typeof value === 'string' && !isAbsolute(value)) source[key] = resolve(baseDir, value);
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
    throw new BridgeError('CONFIG_INVALID', `cannot read config file ${path}`, { cause });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new BridgeError('CONFIG_INVALID', `config file ${path} is not valid JSON`, { cause });
  }
  return parseRuntimeConfig(parsed, { env, baseDir: resolve(path, '..') });
}
