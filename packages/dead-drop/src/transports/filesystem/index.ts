/**
 * `@fyrlabs/dead-drop/transports/filesystem` — a store transport backed by a directory.
 *
 * This is the reference transport. Point two machines at the same directory and
 * dead-drop works: a shared network mount, a Dropbox/OneDrive/Drive folder, an
 * SMB share, or just two runtimes on one box for local development.
 *
 * Writes are atomic (temp file plus rename) because sync clients and other
 * peers read the directory concurrently and must never observe a half-written
 * frame.
 */

import { constants } from 'node:fs';
import {
  access,
  mkdir,
  open as openFile,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

import { DeadDropError } from '../../protocol/index.js';
import {
  assertValidKey,
  assertValidPrefix,
  defineTransport,
  type ListOptions,
  type ListResult,
  type ObjectEntry,
  type PutOptions,
  type PutResult,
  type StoreTransport,
  type TransportContext,
  type TransportHealth,
} from '@fyrlabs/dead-drop-transport-sdk';

export interface FilesystemTransportConfig {
  /** Directory that holds the workspace's objects. Created if missing. */
  root: string;
  /**
   * Poll interval for `watch` when native filesystem events are unavailable
   * (network mounts, some containers). Default 1000ms.
   */
  pollIntervalMs?: number;
  /** Disable `fs.watch` and rely on polling. Needed on many network filesystems. */
  forcePolling?: boolean;
}

const TEMP_SUFFIX = '.tmp';

class FilesystemStore implements StoreTransport {
  readonly kind = 'store' as const;
  private readonly root: string;
  private readonly config: FilesystemTransportConfig;
  private readonly context: TransportContext;
  private readonly openWatchers = new Set<() => Promise<void>>();
  private closed = false;
  private lastSuccessAt: number | undefined;
  private ready: Promise<void> | undefined;

  constructor(config: FilesystemTransportConfig, context: TransportContext) {
    if (typeof config?.root !== 'string' || config.root.length === 0) {
      throw new DeadDropError('CONFIG_INVALID', 'filesystem transport requires a root directory');
    }
    this.root = resolve(config.root);
    this.config = config;
    this.context = context;
  }

  async put(key: string, data: Uint8Array, options: PutOptions = {}): Promise<PutResult> {
    const path = this.pathFor(key);
    this.checkOpen(options.signal);
    await this.ensureRoot();
    await mkdir(dirname(path), { recursive: true });

    if (options.ifAbsent) {
      // 'wx' is the atomic create-or-fail primitive; a stat-then-write race is
      // exactly what claim markers must not have.
      try {
        const handle = await openFile(path, 'wx');
        try {
          await handle.writeFile(data);
        } finally {
          await handle.close();
        }
        this.lastSuccessAt = this.context.now();
        return { key, etag: await this.etagFor(path) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new DeadDropError('TRANSPORT_ERROR', `object already exists: ${key}`, {
            details: { key },
            retryable: false,
          });
        }
        throw this.wrap(error, `failed to create ${key}`);
      }
    }

    if (options.ifMatch !== undefined) {
      const current = await this.etagFor(path).catch(() => undefined);
      if (current !== options.ifMatch) {
        throw new DeadDropError('TRANSPORT_ERROR', `etag mismatch for ${key}`, {
          retryable: false,
        });
      }
    }

    const temp = `${path}.${randomBytes(6).toString('hex')}${TEMP_SUFFIX}`;
    try {
      await writeFile(temp, data);
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw this.wrap(error, `failed to write ${key}`);
    }
    this.lastSuccessAt = this.context.now();
    return { key, etag: await this.etagFor(path) };
  }

  async get(key: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array | undefined> {
    const path = this.pathFor(key);
    this.checkOpen(options.signal);
    try {
      const data = await readFile(path);
      this.lastSuccessAt = this.context.now();
      return new Uint8Array(data);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR') return undefined;
      throw this.wrap(error, `failed to read ${key}`);
    }
  }

  async list(prefix: string, options: ListOptions = {}): Promise<ListResult> {
    assertValidPrefix(prefix);
    this.checkOpen(options.signal);
    const base = prefix === '' ? this.root : join(this.root, ...prefix.split('/'));
    let found: ObjectEntry[];
    try {
      found = await this.walk(base, prefix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [] };
      throw this.wrap(error, `failed to list ${prefix}`);
    }
    found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const after = maxKey(options.cursor, options.startAfter);
    const start = after ? found.findIndex((entry) => entry.key > after) : 0;
    const from = start < 0 ? found.length : start;
    const limit = options.limit ?? found.length;
    const page = found.slice(from, from + limit);
    this.lastSuccessAt = this.context.now();
    const result: ListResult = { entries: page };
    if (from + page.length < found.length && page.length > 0) {
      result.cursor = page[page.length - 1]!.key;
    }
    return result;
  }

  async delete(key: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    const path = this.pathFor(key);
    this.checkOpen(options.signal);
    try {
      await unlink(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw this.wrap(error, `failed to delete ${key}`);
    }
    this.lastSuccessAt = this.context.now();
  }

  async watch(prefix: string, onChange: () => void): Promise<() => Promise<void>> {
    assertValidPrefix(prefix);
    await this.ensureRoot();
    const target = prefix === '' ? this.root : join(this.root, ...prefix.split('/'));
    await mkdir(target, { recursive: true });

    let watcher: FSWatcher | undefined;
    let stopped = false;

    const fire = (): void => {
      if (!stopped) onChange();
    };

    if (!this.config.forcePolling) {
      try {
        watcher = watch(target, { recursive: true }, () => fire());
        watcher.on('error', () => {
          watcher?.close();
          watcher = undefined;
        });
      } catch {
        watcher = undefined;
      }
    }

    // Polling runs *alongside* fs.watch, not only as a replacement for it.
    // Native watching is unreliable in ways that are silent: recursive watches
    // miss events for files created in freshly-created subdirectories on some
    // platforms, network mounts report nothing at all, and a watcher that has
    // quietly died looks exactly like an idle directory. A watcher that never
    // fires would not lose messages — the mailbox polls too — but it would turn
    // sub-second delivery into a multi-second wait with no clue why.
    const timer = await this.startPolling(target, fire);

    const stop = async (): Promise<void> => {
      stopped = true;
      watcher?.close();
      if (timer) clearInterval(timer);
      this.openWatchers.delete(stop);
    };
    this.openWatchers.add(stop);
    return stop;
  }

  async health(): Promise<TransportHealth> {
    if (this.closed) {
      return { status: 'unavailable', message: 'transport is closed' };
    }
    const started = this.context.now();
    try {
      await this.ensureRoot();
      // A real write proves the mount is not read-only or stale, which a stat
      // on a disconnected network share will not.
      const probe = join(this.root, `.deaddrop-health-${randomBytes(4).toString('hex')}`);
      await writeFile(probe, '');
      await unlink(probe);
      const health: TransportHealth = {
        status: 'healthy',
        latencyMs: this.context.now() - started,
      };
      if (this.lastSuccessAt !== undefined) health.lastSuccessAt = this.lastSuccessAt;
      return health;
    } catch (error) {
      return {
        status: 'unavailable',
        latencyMs: this.context.now() - started,
        message: (error as Error).message,
      };
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const stop of [...this.openWatchers]) await stop();
  }

  /**
   * Polling fallback for filesystems where `fs.watch` is unavailable or lies
   * (most network mounts). Seeds the baseline before the first tick so the very
   * first change is still reported.
   */
  private async startPolling(target: string, fire: () => void): Promise<NodeJS.Timeout> {
    let signature: string | undefined = await this.signatureOf(target);
    const timer = setInterval(() => {
      void (async () => {
        const next = await this.signatureOf(target);
        if (next === undefined) return; // briefly unreadable; try again next tick
        if (signature !== undefined && next !== signature) fire();
        signature = next;
      })();
    }, this.config.pollIntervalMs ?? 1000);
    timer.unref?.();
    return timer;
  }

  private async signatureOf(target: string): Promise<string | undefined> {
    try {
      const entries = await readdir(target, { recursive: true, withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && !entry.name.endsWith(TEMP_SUFFIX))
        .map((entry) => `${entry.parentPath ?? entry.path}/${entry.name}`)
        .sort()
        .join('\n');
    } catch {
      return undefined;
    }
  }

  private async walk(dir: string, keyPrefix: string): Promise<ObjectEntry[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: ObjectEntry[] = [];
    for (const entry of entries) {
      if (entry.name.endsWith(TEMP_SUFFIX)) continue; // in-flight write
      if (entry.name.startsWith('.')) continue; // health probes, sync-client metadata
      const childKey = keyPrefix === '' ? entry.name : `${keyPrefix}/${entry.name}`;
      const childPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await this.walk(childPath, childKey)));
      } else if (entry.isFile()) {
        const info = await stat(childPath).catch(() => undefined);
        if (!info) continue; // deleted between readdir and stat
        out.push({
          key: childKey,
          size: info.size,
          modifiedAt: Math.floor(info.mtimeMs),
          etag: `${info.size}-${Math.floor(info.mtimeMs)}`,
        });
      }
    }
    return out;
  }

  private async etagFor(path: string): Promise<string> {
    const info = await stat(path);
    return `${info.size}-${Math.floor(info.mtimeMs)}`;
  }

  private pathFor(key: string): string {
    assertValidKey(key);
    const path = resolve(this.root, ...key.split('/'));
    // Belt and braces: assertValidKey already rejects traversal, but a symlinked
    // or case-folding root could still surprise us.
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new DeadDropError('BAD_REQUEST', `key escapes the transport root: ${key}`);
    }
    return path;
  }

  private ensureRoot(): Promise<void> {
    this.ready ??= mkdir(this.root, { recursive: true }).then(() => undefined);
    return this.ready;
  }

  private checkOpen(signal?: AbortSignal): void {
    if (this.closed) throw new DeadDropError('TRANSPORT_ERROR', 'filesystem transport is closed');
    if (signal?.aborted || this.context.signal.aborted) {
      throw new DeadDropError('CANCELLED', 'operation aborted');
    }
  }

  private wrap(error: unknown, message: string): DeadDropError {
    const code = (error as NodeJS.ErrnoException).code;
    // A full disk or a vanished mount is not worth retrying immediately; a
    // transient EBUSY/EAGAIN is.
    const retryable = code === 'EBUSY' || code === 'EAGAIN' || code === 'EMFILE';
    return new DeadDropError('TRANSPORT_ERROR', `${message}: ${(error as Error).message}`, {
      cause: error,
      retryable,
      details: { code },
    });
  }
}

export const filesystemTransport = defineTransport<FilesystemTransportConfig>({
  id: 'filesystem',
  capabilities: {
    kind: 'store',
    ordering: 'partition',
    binaryPayloads: true,
    delete: true,
    watch: true,
    orderedList: true,
    expectedLatencyMs: 1,
  },
  parseConfig(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new DeadDropError('CONFIG_INVALID', 'filesystem transport config must be an object');
    }
    const config = raw as FilesystemTransportConfig;
    if (typeof config.root !== 'string' || config.root.length === 0) {
      throw new DeadDropError('CONFIG_INVALID', 'filesystem transport requires "root"');
    }
    if (config.pollIntervalMs !== undefined && config.pollIntervalMs < 50) {
      throw new DeadDropError('CONFIG_INVALID', 'pollIntervalMs must be at least 50');
    }
    return config;
  },
  create(config, context) {
    return new FilesystemStore(config, context);
  },
});

export async function directoryExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export default filesystemTransport;

/** `cursor` and `startAfter` both mean "keys after this"; the later one wins. */
function maxKey(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a > b ? a : b;
}
