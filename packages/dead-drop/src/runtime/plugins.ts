/**
 * Transport plugin loading.
 *
 * The blueprint's hard requirement is that a third party can ship a transport
 * without touching this repository. That means resolving adapters by module
 * specifier at run time: `@my-company/deaddrop-transport-foo`, a local path, or
 * one of the built-in short names.
 *
 * Built-ins are still loaded dynamically so a runtime that only uses the
 * filesystem transport never pays to import git or GitHub support.
 */

import { pathToFileURL } from 'node:url';
import { isAbsolute, resolve } from 'node:path';

import { DeadDropError } from '../protocol/index.js';
import type { TransportDefinition, TransportRegistration } from '@fyrlabs/dead-drop-transport-sdk';

import type { TransportConfigEntry } from './config.js';

/**
 * Short names for the transports shipped in this package.
 *
 * These are thunks around *static* `import()` calls, not specifier strings. A
 * dynamic `import(someVariable)` cannot be resolved relative to this module by
 * bundlers or by vitest's module runner, so a relative string here loads under
 * plain Node and fails everywhere else. A literal import is analysable, keeps
 * the lazy loading that stops a filesystem-only runtime paying for git, and
 * survives being vendored or bundled.
 */
export const BUILT_IN: Record<string, () => Promise<unknown>> = {
  memory: () => import('../transports/memory/index.js'),
  filesystem: () => import('../transports/filesystem/index.js'),
  fs: () => import('../transports/filesystem/index.js'),
  git: () => import('../transports/git/index.js'),
  github: () => import('../transports/github/index.js'),
};

/** Label used in errors and diagnostics for a built-in short name. */
const builtInLabel = (use: string): string =>
  `@fyrlabs/dead-drop/transports/${use === 'fs' ? 'filesystem' : use}`;

export type ModuleLoader = (specifier: string) => Promise<unknown>;

const defaultLoader: ModuleLoader = (specifier) => import(specifier);

/**
 * Pulls a transport definition out of a loaded module. Accepts, in order:
 * the default export, a named export matching the module's own id, or the
 * single `defineTransport` factory the module exports.
 */
export function extractDefinition(module: unknown, specifier: string): TransportDefinition<never> {
  const candidates: unknown[] = [];
  if (module && typeof module === 'object') {
    const record = module as Record<string, unknown>;
    candidates.push(record.default, ...Object.values(record));
  }
  for (const candidate of candidates) {
    const definition = asDefinition(candidate);
    if (definition) return definition;
  }
  throw new DeadDropError(
    'CONFIG_INVALID',
    `module "${specifier}" does not export a transport created with defineTransport`,
  );
}

function asDefinition(value: unknown): TransportDefinition<never> | undefined {
  if (typeof value === 'function' && 'definition' in value) {
    const definition = (value as { definition?: unknown }).definition;
    if (isDefinition(definition)) return definition;
  }
  if (isDefinition(value)) return value;
  return undefined;
}

function isDefinition(value: unknown): value is TransportDefinition<never> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TransportDefinition<never>).id === 'string' &&
    typeof (value as TransportDefinition<never>).create === 'function' &&
    typeof (value as TransportDefinition<never>).capabilities === 'object'
  );
}

export function resolveSpecifier(use: string, baseDir = process.cwd()): string {
  if (BUILT_IN[use]) return builtInLabel(use);
  if (use.startsWith('.') || isAbsolute(use)) {
    return pathToFileURL(resolve(baseDir, use)).href;
  }
  return use;
}

/** Loads one configured transport and validates its config through the plugin. */
export async function loadTransport(
  entry: TransportConfigEntry,
  options: { loader?: ModuleLoader; baseDir?: string } = {},
): Promise<TransportRegistration<never>> {
  const builtIn = BUILT_IN[entry.use];
  const specifier = resolveSpecifier(entry.use, options.baseDir);

  let module: unknown;
  try {
    // An injected loader always wins so tests can substitute a fake, including
    // for a built-in name.
    module = options.loader
      ? await options.loader(specifier)
      : builtIn
        ? await builtIn()
        : await defaultLoader(specifier);
  } catch (cause) {
    throw new DeadDropError(
      'CONFIG_INVALID',
      `cannot load transport "${entry.use}". Is the package installed? (resolved to ${specifier})`,
      { cause, details: { use: entry.use, specifier } },
    );
  }

  const definition = extractDefinition(module, specifier);
  // Validation belongs to the plugin: it is the only thing that knows what its
  // own config means, and a bad value should fail at start-up, not at first use.
  const config = definition.parseConfig
    ? definition.parseConfig(entry.config)
    : (entry.config as never);

  const registration: TransportRegistration<never> = { definition, config: config as never };
  if (entry.name !== undefined) registration.name = entry.name;
  return registration;
}

export async function loadTransports(
  entries: readonly TransportConfigEntry[],
  options: { loader?: ModuleLoader; baseDir?: string } = {},
): Promise<Array<TransportRegistration<never>>> {
  return Promise.all(entries.map((entry) => loadTransport(entry, options)));
}
