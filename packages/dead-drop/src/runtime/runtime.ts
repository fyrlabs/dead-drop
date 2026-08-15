/**
 * The dead-drop runtime: one process, many workspaces.
 *
 * One runtime per machine is the model from the blueprint, and the reason is
 * cost: every workspace polls its transports, and a separate process per
 * project would multiply that polling against the same rate limits. Workspaces
 * stay isolated (own keys, own transports, own mailbox) while sharing the
 * process, the scheduler and the log.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { DeadDropError } from '../protocol/index.js';
import {
  MetricsRegistry,
  Tracer,
  createLogger,
  jsonSink,
  MemoryLogSink,
  prettySink,
  systemClock,
  type Clock,
  type LogRecord,
  type Logger,
} from '../core/index.js';

import type { RuntimeConfig, WorkspaceConfig } from './config.js';
import { registerExposure, type ExposureHandle } from './exposure.js';
import { loadEra } from './era-store.js';
import { loadOrCreateIdentity } from './identity-store.js';
import { loadTransports, type ModuleLoader } from './plugins.js';
import { Workspace } from './workspace.js';
import { VERSION } from '../version.js';

export interface RuntimeOptions {
  config: RuntimeConfig;
  clock?: Clock;
  /** Overrides how transport plugin modules are imported. Used by tests. */
  loader?: ModuleLoader;
  /** Directory relative paths in the config resolve against. */
  baseDir?: string;
  /** `pretty` for a terminal, `json` for anything that ingests logs. */
  logFormat?: 'json' | 'pretty';
  /** Retained log records available through `logs()`. Default 500. */
  logBufferSize?: number;
  version?: string;
  /**
   * Marks this process as a short-lived session sharing a config file with a
   * longer-lived runtime, which is what `ddrop connect` is. Each workspace
   * takes its own mailbox address so the two never poll one inbox, and keeps
   * the configured peer id as the identity an exposure authorises against.
   */
  sessionId?: string;
}

export interface RuntimeStatus {
  startedAt: number;
  uptimeMs: number;
  version: string;
  workspaces: Array<{
    name: string;
    peerId: string;
    transports: ReturnType<Workspace['transports']>;
    mailbox: ReturnType<Workspace['stats']>['mailbox'];
    exposures: string[];
    handlers: string[];
  }>;
}

export class DeadDropRuntime {
  readonly metrics = new MetricsRegistry();
  readonly tracer: Tracer;
  readonly logger: Logger;

  private readonly config: RuntimeConfig;
  private readonly clock: Clock;
  private readonly loader: ModuleLoader | undefined;
  private readonly baseDir: string;
  private readonly logBuffer: MemoryLogSink;
  private readonly workspaces = new Map<string, Workspace>();
  private readonly exposures = new Map<string, ExposureHandle[]>();
  private readonly version: string;
  private readonly sessionId: string | undefined;
  private startedAt = 0;
  private started = false;

  constructor(options: RuntimeOptions) {
    this.config = options.config;
    this.clock = options.clock ?? systemClock;
    this.loader = options.loader;
    this.baseDir = options.baseDir ?? process.cwd();
    this.version = options.version ?? VERSION;
    this.sessionId = options.sessionId;
    this.logBuffer = new MemoryLogSink(options.logBufferSize ?? 500);

    const format = options.logFormat ?? 'json';
    const output = format === 'pretty' ? prettySink() : jsonSink();
    this.logger = createLogger({
      level: this.config.logLevel,
      clock: this.clock,
      // Tee: operators tail the process output, `ddrop logs` reads the buffer.
      sink: (record) => {
        this.logBuffer.sink(record);
        output(record);
      },
    });
    this.tracer = new Tracer({ clock: this.clock });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.startedAt = this.clock.now();
    await mkdir(this.config.dataDir, { recursive: true }).catch(() => undefined);

    for (const workspaceConfig of this.config.workspaces) {
      await this.startWorkspace(workspaceConfig);
    }
    this.logger.info('runtime started', {
      workspaces: [...this.workspaces.keys()],
      dataDir: this.config.dataDir,
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const handles of this.exposures.values()) {
      for (const handle of handles) handle.stop();
    }
    this.exposures.clear();
    await Promise.allSettled([...this.workspaces.values()].map((workspace) => workspace.stop()));
    this.workspaces.clear();
    this.logger.info('runtime stopped');
  }

  workspace(name: string): Workspace {
    const workspace = this.workspaces.get(name);
    if (!workspace) {
      throw new DeadDropError('NOT_FOUND', `no workspace named "${name}"`, {
        details: { known: [...this.workspaces.keys()] },
      });
    }
    return workspace;
  }

  /** The workspace to use when the caller did not name one. */
  defaultWorkspace(): Workspace {
    const first = this.workspaces.values().next();
    if (first.done) throw new DeadDropError('NOT_FOUND', 'the runtime has no workspaces');
    return first.value;
  }

  list(): string[] {
    return [...this.workspaces.keys()];
  }

  status(): RuntimeStatus {
    return {
      startedAt: this.startedAt,
      uptimeMs: this.startedAt === 0 ? 0 : this.clock.now() - this.startedAt,
      version: this.version,
      workspaces: [...this.workspaces.values()].map((workspace) => {
        const stats = workspace.stats();
        return {
          name: workspace.name,
          peerId: workspace.peerId,
          transports: workspace.transports(),
          mailbox: stats.mailbox,
          exposures: (this.exposures.get(workspace.name) ?? []).map((handle) => handle.name),
          handlers: stats.handlers,
        };
      }),
    };
  }

  logs(options: { limit?: number; level?: LogRecord['level'] } = {}): LogRecord[] {
    const records = options.level
      ? this.logBuffer.records.filter((record) => record.level === options.level)
      : this.logBuffer.records;
    return options.limit ? records.slice(-options.limit) : [...records];
  }

  /** Adds an exposure to a running workspace. Used by `ddrop expose`. */
  addExposure(
    workspaceName: string,
    config: Parameters<typeof registerExposure>[1],
  ): ExposureHandle {
    const workspace = this.workspace(workspaceName);
    const handle = registerExposure(workspace, config, { logger: this.logger });
    const existing = this.exposures.get(workspaceName) ?? [];
    // Replacing an exposure of the same name is the expected way to repoint it.
    const filtered = existing.filter((entry) => {
      if (entry.name !== config.name) return true;
      entry.stop();
      return false;
    });
    this.exposures.set(workspaceName, [...filtered, handle]);
    return handle;
  }

  private async startWorkspace(config: WorkspaceConfig): Promise<void> {
    const registrations = await loadTransports(config.transports, {
      ...(this.loader ? { loader: this.loader } : {}),
      baseDir: this.baseDir,
    });
    const eraPath = join(this.config.dataDir, `${config.name}.era`);
    const era = await loadEra(eraPath, this.logger);
    const workspace = new Workspace({
      config,
      registrations,
      logger: this.logger,
      metrics: this.metrics,
      tracer: this.tracer,
      clock: this.clock,
      dedupePath: join(this.config.dataDir, `${config.name}.dedupe.json`),
      // No config field names this path, deliberately: see identity-store.ts. A
      // `ddrop connect` session resolves the same file as the long-lived runtime,
      // which is what makes a key wrapped to this peer usable by both.
      identity: await loadOrCreateIdentity(join(this.config.dataDir, `${config.name}.identity`)),
      // Resolved before construction for the same reason as the identity: the
      // ring has to be right before the first frame is sealed, and reading it
      // is async. See era-store.ts for the window this closes.
      eraPath,
      ...(era ? { era } : {}),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      version: this.version,
    });

    // Exposures are registered before start so a peer that is already polling
    // never sees the workspace announce itself without its handlers in place.
    const handles = (config.exposures ?? []).map((exposure) =>
      registerExposure(workspace, exposure, { logger: this.logger }),
    );
    this.exposures.set(config.name, handles);

    await workspace.start();
    this.workspaces.set(config.name, workspace);
  }
}
