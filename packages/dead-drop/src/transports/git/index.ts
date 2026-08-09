/**
 * `@fyrlabs/dead-drop/transports/git` — a store transport backed by a git repository.
 *
 * Objects are files on a dedicated branch of a repository the peers share.
 * Writing is commit-and-push; reading is fetch-and-read. Any git host works:
 * GitHub, GitLab, Bitbucket, Azure DevOps, a bare repo on a server, or a
 * directory on a USB stick.
 *
 * Honest about what this is: git is not a message broker. A round trip costs a
 * push and a fetch, latency is seconds not milliseconds, and hosts rate-limit.
 * Two design choices follow from that and matter more than anything else here:
 *
 *   - **Mutations are batched.** Writes queue and coalesce into a single
 *     commit-and-push. Ten messages sent in the same tick cost one push, not
 *     ten. A `put` still resolves only once its data is pushed, so the store
 *     contract's durability promise holds.
 *   - **A dedicated orphan branch.** dead-drop data never shares history with the
 *     repository's code, so a `ddrop` branch can be force-pruned or deleted
 *     without touching anything a human cares about.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join, resolve, sep } from 'node:path';

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

import { Git, isNonFastForward, redactUrl } from './git.js';
import { sweepAbandoned, takeDirLock, type DirLock } from './workdir-lock.js';

/**
 * Suffix for the directory holding extra clones when the configured `workDir`
 * is already owned. It is a sibling, never a child: anything inside the working
 * tree gets walked as objects and committed by `git add --all`, so a clone
 * nested there would push itself into the data branch.
 */
const PEER_CLONES_SUFFIX = '.peers';

/**
 * A directory name for one store instance, unique across every store that could
 * contend for a `workDir`: two processes differ by peer id, and two stores
 * inside one runtime differ by workspace or instance name.
 */
function safeDirName(context: TransportContext): string {
  const raw = `${context.workspace}-${context.peerId}-${context.instance}`;
  return raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

export interface GitTransportConfig {
  /** Anything `git clone` accepts: an https url, an ssh url, or a local path. */
  remote: string;
  /** Branch that holds dead-drop objects. Default `deaddrop-data`. */
  branch?: string;
  /** Local clone directory. Created if missing. */
  workDir: string;
  /** Subdirectory inside the branch. Lets one repo host several workspaces. */
  prefix?: string;
  /** Seconds a local read may be stale before a fetch is forced. Default 5s. */
  freshnessMs?: number;
  /** Milliseconds to wait for other writes before committing. Default 50ms. */
  batchWindowMs?: number;
  /** Attempts to resolve a push race before giving up. Default 5. */
  pushRetries?: number;
  authorName?: string;
  authorEmail?: string;
  gitPath?: string;
  /** Per-git-command timeout. Default 120000. */
  timeoutMs?: number;
}

interface PendingMutation {
  key: string;
  data: Uint8Array | null;
  resolve(): void;
  reject(error: unknown): void;
}

/**
 * GitHub rejects blobs over 100 MB and warns well before it. 40 MB keeps a
 * single object comfortably inside every host's limit after framing.
 */
const MAX_OBJECT_BYTES = 40 * 1024 * 1024;

class GitStore implements StoreTransport {
  readonly kind = 'store' as const;
  private readonly config: Required<
    Pick<GitTransportConfig, 'branch' | 'prefix' | 'freshnessMs' | 'batchWindowMs' | 'pushRetries'>
  > &
    GitTransportConfig;
  private readonly context: TransportContext;
  /** The directory the config asked for, before ownership is settled. */
  private readonly configuredWorkDir: string;
  private git: Git;
  private workDir: string;
  private dataDir: string;
  private lock: DirLock | undefined;

  private ready: Promise<void> | undefined;
  private queue: PendingMutation[] = [];
  private flushing: Promise<void> | undefined;
  private lastFetchAt = 0;
  private lastSuccessAt: number | undefined;
  private closed = false;
  private lastError: string | undefined;

  constructor(config: GitTransportConfig, context: TransportContext) {
    this.config = {
      branch: 'deaddrop-data',
      prefix: '',
      freshnessMs: 5000,
      batchWindowMs: 50,
      pushRetries: 5,
      ...config,
    };
    this.context = context;
    this.configuredWorkDir = resolve(config.workDir);
    // Provisional until `initialise` finds out whether this directory is free.
    this.workDir = this.configuredWorkDir;
    this.dataDir = this.resolveDataDir(this.workDir);
    this.git = this.gitFor(this.workDir);
  }

  private resolveDataDir(workDir: string): string {
    return this.config.prefix ? join(workDir, ...this.config.prefix.split('/')) : workDir;
  }

  private gitFor(workDir: string): Git {
    return new Git({
      ...(this.config.gitPath ? { gitPath: this.config.gitPath } : {}),
      cwd: workDir,
      ...(this.config.timeoutMs ? { timeoutMs: this.config.timeoutMs } : {}),
    });
  }

  /**
   * Settles which directory this store owns.
   *
   * The first store to claim the configured directory keeps it, so an ordinary
   * single-runtime setup is laid out exactly as before and never re-clones. A
   * second one -- another runtime, or `ddrop connect`, which builds its runtime
   * from the same config file -- takes a clone of its own instead of sharing a
   * working tree, which git does not support and which used to interleave one
   * process's `reset --hard` with another's commit.
   */
  private async claimWorkDir(): Promise<void> {
    // A retried `initialise` must not claim twice. The first attempt may have
    // taken the lock and failed afterwards, and `takeDirLock` counts our own
    // pid as a live owner on purpose, so re-running it would read the directory
    // we already hold as somebody else's, clone into `.peers` instead, and
    // leak the lock on the one we abandoned.
    if (this.lock) return;
    this.lock = await takeDirLock(this.configuredWorkDir, () => this.context.now());
    if (this.lock) return;

    const parent = `${this.configuredWorkDir}${PEER_CLONES_SUFFIX}`;
    const own = join(parent, safeDirName(this.context));
    await mkdir(parent, { recursive: true });
    const siblings = await readdir(parent).catch(() => [] as string[]);
    const swept = await sweepAbandoned(parent, own, siblings);

    this.lock = await takeDirLock(own, () => this.context.now());
    if (!this.lock) {
      throw new DeadDropError(
        'TRANSPORT_ERROR',
        `another runtime already owns ${own}. Give this runtime its own "workDir".`,
        { retryable: false },
      );
    }
    this.workDir = own;
    this.dataDir = this.resolveDataDir(own);
    this.git = this.gitFor(own);
    this.context.logger.info('another runtime owns this workDir, cloning separately', {
      configured: this.configuredWorkDir,
      using: own,
      ...(swept.length > 0 ? { reclaimed: swept.length } : {}),
    });
  }

  // ------------------------------------------------------------------- store

  async put(key: string, data: Uint8Array, options: PutOptions = {}): Promise<PutResult> {
    assertValidKey(key);
    this.checkOpen(options.signal);
    if (data.length > MAX_OBJECT_BYTES) {
      throw new DeadDropError(
        'PAYLOAD_TOO_LARGE',
        `git objects are capped at ${MAX_OBJECT_BYTES} bytes; got ${data.length}`,
      );
    }
    await this.ensureClone();

    if (options.ifAbsent) {
      // Check against the freshly fetched remote state, not just the local tree:
      // another peer may have created the key since our last fetch.
      await this.sync(true);
      if (await this.exists(key)) {
        throw new DeadDropError('TRANSPORT_ERROR', `object already exists: ${key}`, {
          details: { key },
          retryable: false,
        });
      }
    }

    await this.enqueue({ key, data });
    return { key };
  }

  async get(key: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array | undefined> {
    assertValidKey(key);
    this.checkOpen(options.signal);
    await this.ensureClone();
    await this.sync(false);
    try {
      const data = await readFile(this.pathFor(key));
      this.lastSuccessAt = this.context.now();
      return new Uint8Array(data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw this.wrap(error, `failed to read ${key}`);
    }
  }

  async list(prefix: string, options: ListOptions = {}): Promise<ListResult> {
    assertValidPrefix(prefix);
    this.checkOpen(options.signal);
    await this.ensureClone();
    await this.sync(false);

    const base = prefix === '' ? this.dataDir : join(this.dataDir, ...prefix.split('/'));
    let entries: ObjectEntry[];
    try {
      entries = await this.walk(base, prefix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [] };
      throw this.wrap(error, `failed to list ${prefix}`);
    }
    entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const after = options.startAfter ?? options.cursor;
    const start = after ? entries.findIndex((entry) => entry.key > after) : 0;
    const from = start < 0 ? entries.length : start;
    const limit = options.limit ?? entries.length;
    const page = entries.slice(from, from + limit);
    this.lastSuccessAt = this.context.now();
    const result: ListResult = { entries: page };
    if (from + page.length < entries.length && page.length > 0) {
      result.cursor = page[page.length - 1]!.key;
    }
    return result;
  }

  async delete(key: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    assertValidKey(key);
    this.checkOpen(options.signal);
    await this.ensureClone();
    await this.enqueue({ key, data: null });
  }

  async health(): Promise<TransportHealth> {
    if (this.closed) return { status: 'unavailable', message: 'transport is closed' };
    const started = this.context.now();
    try {
      await this.ensureClone();
      // ls-remote proves the remote is reachable and our credentials work
      // without transferring objects.
      await this.git.run(['ls-remote', '--exit-code', '--heads', 'origin']).catch(async (error) => {
        // exit code 2 just means the branch does not exist yet, which is fine
        // on a fresh repository.
        if (DeadDropError.is(error) && String(error.details?.code) === '2') return;
        throw error;
      });
      const latencyMs = this.context.now() - started;
      const health: TransportHealth = {
        // git is slow by nature; a multi-second round trip is normal, not sick,
        // but it is worth telling the operator so routing prefers a faster peer.
        status: latencyMs > 10_000 ? 'degraded' : 'healthy',
        latencyMs,
      };
      if (this.lastSuccessAt !== undefined) health.lastSuccessAt = this.lastSuccessAt;
      if (latencyMs > 10_000) health.message = `remote round trip took ${latencyMs}ms`;
      return health;
    } catch (error) {
      const message = redactUrl(DeadDropError.from(error).message);
      this.lastError = message;
      return { status: 'unavailable', latencyMs: this.context.now() - started, message };
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    // Let queued writes finish; dropping them would silently lose messages the
    // caller has already been told are durable.
    await this.flushing?.catch(() => undefined);
    await this.lock?.release().catch(() => undefined);
    this.lock = undefined;
  }

  // --------------------------------------------------------------- internals

  /**
   * Resolves the clone once, and lets a failed attempt be tried again.
   *
   * Memoising the promise is what stops concurrent callers from each cloning.
   * Memoising a *rejected* one is a different thing entirely: one `git fetch`
   * that hit its timeout, or one 502 from the host, and every later put, get,
   * list and health probe re-threw that same error for the life of the process.
   * The breaker in front of this then stayed open for good, because its
   * half-open probe called straight back in here and got the cached failure.
   * Clearing the slot is what makes "unavailable" a state this can leave.
   */
  private ensureClone(): Promise<void> {
    this.ready ??= this.initialise().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private async initialise(): Promise<void> {
    await this.claimWorkDir();
    await mkdir(this.workDir, { recursive: true });
    // Whether *this* directory is our clone, never whether git can find a
    // repository somewhere above it. `rev-parse --git-dir` succeeds from inside
    // any enclosing repository, so a `workDir` nested in a user's project --
    // which the documented quick start suggests, since people run quick starts
    // inside their own checkout -- read that project as this store's clone and
    // repointed its `origin`, rewrote its commit identity and checked out an
    // orphan branch over their work.
    const isRepo = await stat(join(this.workDir, '.git')).then(
      () => true,
      () => false,
    );
    if (!isRepo) {
      await this.git.run(['init', '--quiet']);
      await this.git.run(['remote', 'add', 'origin', this.config.remote]);
    } else {
      // Repoint an existing clone if the configured remote changed.
      const current = await this.git.tryRun(['remote', 'get-url', 'origin']);
      if (current.code !== 0) {
        await this.git.run(['remote', 'add', 'origin', this.config.remote]);
      } else if (current.stdout.trim() !== this.config.remote) {
        await this.git.run(['remote', 'set-url', 'origin', this.config.remote]);
      }
    }

    await this.git.run(['config', 'user.name', this.config.authorName ?? 'dead-drop Runtime']);
    await this.git.run(['config', 'user.email', this.config.authorEmail ?? 'ddrop@localhost']);
    // Rebase on pull keeps the data branch linear; merge commits here are noise.
    await this.git.run(['config', 'pull.rebase', 'true']);

    const branch = this.config.branch;
    const fetched = await this.git.tryRun(['fetch', '--quiet', 'origin', branch]);
    if (fetched.code === 0) {
      await this.git.run(['checkout', '-B', branch, `origin/${branch}`, '--']);
    } else {
      // Branch does not exist on the remote yet. An orphan branch keeps dead-drop
      // data out of the repository's real history entirely.
      const existsLocally = await this.git.tryRun(['rev-parse', '--verify', branch]);
      if (existsLocally.code === 0) {
        await this.git.run(['checkout', branch, '--']);
      } else {
        await this.git.run(['checkout', '--orphan', branch]);
        await this.git.tryRun(['rm', '-rf', '--cached', '.']);
        await mkdir(this.dataDir, { recursive: true });
        await writeFile(
          join(this.workDir, 'README.md'),
          '# dead-drop data branch\n\n' +
            'Machine-managed. Every file here is an encrypted dead-drop frame.\n' +
            'Deleting this branch discards undelivered messages and nothing else.\n',
        );
        await this.git.run(['add', '--', 'README.md']);
        await this.git.run(['commit', '--quiet', '-m', 'chore: initialise ddrop data branch']);
        await this.createBranch();
      }
    }
    await mkdir(this.dataDir, { recursive: true });
    this.lastFetchAt = this.context.now();
  }

  /** Fetches when the local copy is older than the freshness window. */
  private async sync(force: boolean): Promise<void> {
    if (!force && this.context.now() - this.lastFetchAt < this.config.freshnessMs) return;
    const branch = this.config.branch;
    const fetched = await this.git.tryRun(['fetch', '--quiet', 'origin', branch]);
    this.lastFetchAt = this.context.now();
    if (fetched.code !== 0) {
      // Offline or the branch is gone. Serving the last known state beats
      // failing every read; health reporting is where this surfaces.
      this.lastError = fetched.stderr.trim();
      return;
    }
    // Hard reset is correct here precisely because local edits are never
    // uncommitted: every mutation is committed inside the flush lock.
    await this.git.run(['reset', '--quiet', '--hard', `origin/${branch}`]);
    this.lastSuccessAt = this.context.now();
  }

  /** Adds a mutation to the batch and resolves once it has been pushed. */
  private enqueue(mutation: { key: string; data: Uint8Array | null }): Promise<void> {
    return new Promise<void>((resolvePut, rejectPut) => {
      this.queue.push({ ...mutation, resolve: resolvePut, reject: rejectPut });
      this.scheduleFlush();
    });
  }

  private scheduleFlush(): void {
    if (this.flushing) return;
    this.flushing = (async () => {
      // A short window lets concurrent writes share one commit and one push.
      if (this.config.batchWindowMs > 0) await delay(this.config.batchWindowMs);
      try {
        await this.flush();
      } finally {
        this.flushing = undefined;
        if (this.queue.length > 0) this.scheduleFlush();
      }
    })();
  }

  private async flush(): Promise<void> {
    const batch = this.queue.splice(0);
    if (batch.length === 0) return;
    try {
      await this.applyBatch(batch);
      for (const mutation of batch) mutation.resolve();
      this.lastSuccessAt = this.context.now();
    } catch (error) {
      for (const mutation of batch) mutation.reject(error);
    }
  }

  private async applyBatch(batch: PendingMutation[]): Promise<void> {
    const branch = this.config.branch;
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.config.pushRetries; attempt++) {
      // Start each attempt from the remote's current state so a rebase is never
      // needed: our commit only ever adds or removes distinct files.
      await this.sync(true);
      let touched = 0;
      for (const mutation of batch) {
        const path = this.pathFor(mutation.key);
        if (mutation.data === null) {
          await rm(path, { force: true });
        } else {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, mutation.data);
        }
        touched += 1;
      }
      await this.git.run(['add', '--all', '--', relativeOrDot(this.config.prefix)]);

      const status = await this.git.run(['status', '--porcelain']);
      if (status.stdout.trim().length === 0) return; // deletes of absent files

      await this.git.run([
        'commit',
        '--quiet',
        '-m',
        `ddrop: ${touched} object${touched === 1 ? '' : 's'}`,
      ]);
      const committed = (await this.git.run(['rev-parse', 'HEAD'])).stdout.trim();
      const pushed = await this.git.tryRun(['push', '--quiet', 'origin', `HEAD:${branch}`]);
      if (pushed.code === 0 && (await this.isOnRemote(committed))) return;

      if (pushed.code === 0) {
        // `git push` exits 0 saying "Everything up-to-date" when HEAD no longer
        // carries our commit. That happens when a second process shares this
        // working tree -- `ddrop connect` starts its own runtime from the same
        // config, so it does -- and its poll ran `reset --hard origin/<branch>`
        // between our commit and our push. Exit 0 is not proof of publication;
        // the remote-tracking ref holding our commit is. Trusting the exit code
        // resolved the write as successful and dropped the message silently.
        lastError = `push reported success but ${committed.slice(0, 8)} never reached origin/${branch}`;
        this.context.logger.warn('a push was discarded before it left this clone, replaying', {
          attempt,
          commit: committed.slice(0, 8),
        });
      } else {
        lastError = pushed.stderr;
        if (!isNonFastForward(pushed.stderr)) {
          throw new DeadDropError(
            'TRANSPORT_ERROR',
            `git push failed: ${redactUrl(pushed.stderr)}`,
            { retryable: true },
          );
        }
        // Someone else pushed first. Drop our commit and replay onto their state.
        this.context.logger.debug('git push lost a race, replaying', { attempt });
      }
      await this.git.tryRun(['reset', '--quiet', '--hard', `origin/${branch}`]);
    }

    throw new DeadDropError(
      'TRANSPORT_ERROR',
      `git push kept losing races after ${this.config.pushRetries} attempts: ` +
        redactUrl(String(lastError).slice(0, 300)),
      { retryable: true },
    );
  }

  /** True when `commit` is reachable from the remote-tracking branch. */
  private async isOnRemote(commit: string): Promise<boolean> {
    const branch = this.config.branch;
    const reachable = await this.git.tryRun([
      'merge-base',
      '--is-ancestor',
      commit,
      `origin/${branch}`,
    ]);
    return reachable.code === 0;
  }

  private async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  private async walk(dir: string, keyPrefix: string): Promise<ObjectEntry[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: ObjectEntry[] = [];
    for (const entry of entries) {
      // .git is the repository itself; README.md is our own branch marker.
      if (entry.name === '.git' || entry.name.startsWith('.')) continue;
      if (keyPrefix === '' && entry.name === 'README.md') continue;
      const childKey = keyPrefix === '' ? entry.name : `${keyPrefix}/${entry.name}`;
      const childPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await this.walk(childPath, childKey)));
      } else if (entry.isFile()) {
        const info = await stat(childPath).catch(() => undefined);
        if (!info) continue;
        out.push({
          key: childKey,
          size: info.size,
          modifiedAt: Math.floor(info.mtimeMs),
        });
      }
    }
    return out;
  }

  private pathFor(key: string): string {
    assertValidKey(key);
    const path = resolve(this.dataDir, ...key.split('/'));
    if (path !== this.dataDir && !path.startsWith(this.dataDir + sep)) {
      throw new DeadDropError('BAD_REQUEST', `key escapes the repository data directory: ${key}`);
    }
    return path;
  }

  /**
   * Publishes the freshly created orphan branch.
   *
   * Two peers starting against an empty repository at the same time will both
   * try to create it, and exactly one wins. Losing is not an error: the winner's
   * branch is the one that exists, so we discard our own initial commit and
   * adopt theirs. Treating this as a failure would make a simultaneous
   * first-start of a workspace flap for no reason.
   */
  private async createBranch(): Promise<void> {
    const branch = this.config.branch;
    const pushed = await this.git.tryRun(['push', '--quiet', '-u', 'origin', `HEAD:${branch}`]);
    if (pushed.code === 0) return;

    const fetched = await this.git.tryRun(['fetch', '--quiet', 'origin', branch]);
    if (fetched.code !== 0) {
      throw new DeadDropError(
        'TRANSPORT_ERROR',
        `cannot create or fetch branch "${branch}" on the remote: ${redactUrl(pushed.stderr)}`,
        { retryable: true },
      );
    }
    this.context.logger.debug('another peer created the data branch first, adopting it', {
      branch,
    });
    await this.git.run(['reset', '--quiet', '--hard', `origin/${branch}`]);
    await this.git.run(['branch', `--set-upstream-to=origin/${branch}`, branch]);
  }

  private checkOpen(signal?: AbortSignal): void {
    if (this.closed) throw new DeadDropError('TRANSPORT_ERROR', 'git transport is closed');
    if (signal?.aborted || this.context.signal.aborted) {
      throw new DeadDropError('CANCELLED', 'operation aborted');
    }
  }

  private wrap(error: unknown, message: string): DeadDropError {
    return new DeadDropError(
      'TRANSPORT_ERROR',
      `${message}: ${redactUrl((error as Error).message)}`,
      {
        cause: error,
      },
    );
  }

  /** Last remote failure, surfaced through health. Exposed for tests. */
  get lastRemoteError(): string | undefined {
    return this.lastError;
  }
}

function relativeOrDot(prefix: string): string {
  return prefix.length > 0 ? prefix : '.';
}

export const gitTransport = defineTransport<GitTransportConfig>({
  id: 'git',
  capabilities: {
    kind: 'store',
    ordering: 'partition',
    binaryPayloads: true,
    delete: true,
    // git has no push notification worth the name; polling is the honest answer.
    watch: false,
    orderedList: true,
    maxPayloadBytes: MAX_OBJECT_BYTES,
    // A push plus a fetch. Optimistic, and the manager measures the real value.
    expectedLatencyMs: 2000,
  },
  parseConfig(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new DeadDropError('CONFIG_INVALID', 'git transport config must be an object');
    }
    const config = raw as GitTransportConfig;
    if (typeof config.remote !== 'string' || config.remote.length === 0) {
      throw new DeadDropError('CONFIG_INVALID', 'git transport requires "remote"');
    }
    if (typeof config.workDir !== 'string' || config.workDir.length === 0) {
      throw new DeadDropError('CONFIG_INVALID', 'git transport requires "workDir"');
    }
    if (config.branch !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(config.branch)) {
      throw new DeadDropError('CONFIG_INVALID', 'git transport branch name is invalid');
    }
    if (config.prefix !== undefined && config.prefix !== '') assertValidPrefix(config.prefix);
    return config;
  },
  create(config, context) {
    return new GitStore(config, context);
  },
});

export { Git, isNonFastForward, isRetryableGitError, redactUrl } from './git.js';
export default gitTransport;
