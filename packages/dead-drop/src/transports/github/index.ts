/**
 * `@fyrlabs/dead-drop/transports/github` — GitHub as a dead-drop transport.
 *
 * Deliberately thin. All data movement is `@fyrlabs/dead-drop/transports/git`: peers
 * push and pull a dedicated branch of a repository. This package adds only the
 * things that are specific to GitHub:
 *
 *   - resolving `owner/name` to a clone url through the `gh` CLI, so whatever
 *     authentication the user already has (`gh auth login`, SSH keys, a
 *     credential helper) is what gets used and no token is ever handed to
 *     dead-drop;
 *   - optionally creating the repository, private by default;
 *   - reporting the API rate limit, which the transport manager uses when
 *     scoring transports so a nearly-exhausted GitHub loses to a healthy peer.
 *
 * A direct REST/token path can be added behind the same `GhClient` interface
 * later without changing anything above this file.
 */

import { DeadDropError } from '../../protocol/index.js';
import {
  defineTransport,
  type ListOptions,
  type ListResult,
  type PutOptions,
  type PutResult,
  type StoreTransport,
  type TransportContext,
  type TransportHealth,
} from '@fyrlabs/dead-drop-transport-sdk';
import { gitTransport, type GitTransportConfig } from '../git/index.js';

import { GhCli, isValidRepo, type GhClient } from './gh.js';

export interface GitHubTransportConfig {
  /** `owner/name`. */
  repo: string;
  /** Local clone directory. */
  workDir: string;
  /** Branch that holds dead-drop data. Default `deaddrop-data`. */
  branch?: string;
  /** Subdirectory inside the branch, so one repo can host several workspaces. */
  prefix?: string;
  /** Create the repository when it does not exist. Default false. */
  createIfMissing?: boolean;
  /** Visibility used when creating. Default true (private). */
  private?: boolean;
  /** How often the rate limit is re-read, in milliseconds. Default 60000. */
  rateLimitIntervalMs?: number;
  ghPath?: string;
  gitPath?: string;
  timeoutMs?: number;
  batchWindowMs?: number;
  freshnessMs?: number;
  /** Test seam: an alternative `gh` implementation. Not settable from JSON. */
  gh?: GhClient;
  /** Test seam: build the underlying store from a resolved git config. */
  createStore?: (config: GitTransportConfig, context: TransportContext) => StoreTransport;
}

class GitHubStore implements StoreTransport {
  readonly kind = 'store' as const;
  private readonly config: GitHubTransportConfig;
  private readonly context: TransportContext;
  private readonly gh: GhClient;
  private delegate: StoreTransport | undefined;
  private ready: Promise<StoreTransport> | undefined;
  private rateLimit: { limit: number; remaining: number; resetAt: number } | undefined;
  private rateLimitCheckedAt = 0;

  constructor(config: GitHubTransportConfig, context: TransportContext) {
    this.config = config;
    this.context = context;
    this.gh = config.gh ?? new GhCli({ ...(config.ghPath ? { ghPath: config.ghPath } : {}) });
  }

  /**
   * Resolves the repository once, and lets a failed attempt be tried again.
   *
   * A cached rejection is permanent: one `gh` call that failed on a network
   * blip left every later operation re-throwing it for the life of the process,
   * with the breaker in front of it stuck open because its half-open probe came
   * straight back here. The git delegate does the same for its clone.
   */
  private store(): Promise<StoreTransport> {
    this.ready ??= this.resolve().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private async resolve(): Promise<StoreTransport> {
    const repo = this.config.repo;
    const auth = await this.gh.authStatus();
    if (!auth.authenticated) {
      throw new DeadDropError(
        'UNAUTHORIZED',
        `the GitHub CLI is not authenticated. Run "gh auth login" and "gh auth setup-git". (${auth.message})`,
      );
    }

    let info = await this.gh.repoInfo(repo);
    if (!info) {
      if (!this.config.createIfMissing) {
        throw new DeadDropError(
          'NOT_FOUND',
          `repository ${repo} does not exist or is not visible to you. ` +
            'Create it, or set "createIfMissing": true.',
        );
      }
      this.context.logger.info('creating the GitHub repository for this workspace', { repo });
      info = await this.gh.createRepo(repo, {
        private: this.config.private ?? true,
        description: 'dead-drop workspace transport. Machine-managed.',
      });
    }

    const gitConfig: GitTransportConfig = {
      // The https clone url plus gh's credential helper: no token in our config,
      // and no token in our memory.
      remote: info.url,
      workDir: this.config.workDir,
      branch: this.config.branch ?? 'deaddrop-data',
      ...(this.config.prefix !== undefined ? { prefix: this.config.prefix } : {}),
      ...(this.config.gitPath ? { gitPath: this.config.gitPath } : {}),
      ...(this.config.timeoutMs ? { timeoutMs: this.config.timeoutMs } : {}),
      ...(this.config.batchWindowMs !== undefined
        ? { batchWindowMs: this.config.batchWindowMs }
        : {}),
      ...(this.config.freshnessMs !== undefined ? { freshnessMs: this.config.freshnessMs } : {}),
    };

    this.delegate = this.config.createStore
      ? this.config.createStore(gitConfig, this.context)
      : ((await gitTransport.definition.create(gitConfig, this.context)) as StoreTransport);
    return this.delegate;
  }

  async put(key: string, data: Uint8Array, options?: PutOptions): Promise<PutResult> {
    return (await this.store()).put(key, data, options);
  }

  async get(key: string, options?: { signal?: AbortSignal }): Promise<Uint8Array | undefined> {
    return (await this.store()).get(key, options);
  }

  async list(prefix: string, options?: ListOptions): Promise<ListResult> {
    return (await this.store()).list(prefix, options);
  }

  async delete(key: string, options?: { signal?: AbortSignal }): Promise<void> {
    return (await this.store()).delete(key, options);
  }

  async health(): Promise<TransportHealth> {
    let health: TransportHealth;
    try {
      health = await (await this.store()).health();
    } catch (error) {
      return { status: 'unavailable', message: DeadDropError.from(error).message };
    }

    const interval = this.config.rateLimitIntervalMs ?? 60_000;
    if (this.context.now() - this.rateLimitCheckedAt > interval) {
      this.rateLimitCheckedAt = this.context.now();
      this.rateLimit = (await this.gh.rateLimit().catch(() => undefined)) ?? this.rateLimit;
    }
    if (!this.rateLimit) return health;

    const { limit, remaining, resetAt } = this.rateLimit;
    const enriched: TransportHealth = { ...health, rateLimit: { limit, remaining, resetAt } };
    // Below 10% headroom, prefer another transport rather than spend the last
    // of the budget and start getting 403s.
    if (limit > 0 && remaining / limit < 0.1 && enriched.status === 'healthy') {
      enriched.status = 'degraded';
      enriched.message = `GitHub API rate limit is nearly exhausted (${remaining}/${limit})`;
    }
    return enriched;
  }

  async close(): Promise<void> {
    await this.delegate?.close();
  }
}

export const githubTransport = defineTransport<GitHubTransportConfig>({
  id: 'github',
  capabilities: {
    ...gitTransport.definition.capabilities,
    // A GitHub round trip crosses the internet; git against a local remote does not.
    expectedLatencyMs: 4000,
  },
  parseConfig(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new DeadDropError('CONFIG_INVALID', 'github transport config must be an object');
    }
    const config = raw as GitHubTransportConfig;
    if (typeof config.repo !== 'string' || !isValidRepo(config.repo)) {
      throw new DeadDropError('CONFIG_INVALID', 'github transport requires "repo" as "owner/name"');
    }
    if (typeof config.workDir !== 'string' || config.workDir.length === 0) {
      throw new DeadDropError('CONFIG_INVALID', 'github transport requires "workDir"');
    }
    return config;
  },
  create(config, context) {
    return new GitHubStore(config, context);
  },
});

export { GhCli, isValidRepo, parseRepoJson } from './gh.js';
export type { GhClient, GhRateLimit, GhRepoInfo } from './gh.js';
export default githubTransport;
