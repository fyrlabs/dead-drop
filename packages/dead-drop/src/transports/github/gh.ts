/**
 * A minimal wrapper around the `gh` CLI.
 *
 * `gh` is used for the things it is genuinely better at than raw git: proving
 * the user is authenticated, resolving and creating repositories, and reading
 * the API rate limit. Data movement stays in git, because a push is far more
 * efficient than the contents API for many small objects and it reuses the
 * credential helper `gh auth setup-git` already installed.
 *
 * A token-based API path can be added later without changing this interface;
 * that is why every call goes through `GhClient`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { DeadDropError } from '../../protocol/index.js';

const execFileAsync = promisify(execFile);

export interface GhResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GhRateLimit {
  limit: number;
  remaining: number;
  /** Epoch milliseconds. */
  resetAt: number;
}

export interface GhRepoInfo {
  nameWithOwner: string;
  /** Clone url git should use. */
  url: string;
  isPrivate: boolean;
  defaultBranch: string;
}

/** The surface the GitHub transport needs. Swapped wholesale in tests. */
export interface GhClient {
  authStatus(): Promise<{ authenticated: boolean; message: string }>;
  repoInfo(repo: string): Promise<GhRepoInfo | undefined>;
  createRepo(
    repo: string,
    options: { private: boolean; description?: string },
  ): Promise<GhRepoInfo>;
  rateLimit(): Promise<GhRateLimit | undefined>;
}

export interface GhCliOptions {
  ghPath?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export class GhCli implements GhClient {
  private readonly ghPath: string;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: GhCliOptions = {}) {
    this.ghPath = options.ghPath ?? 'gh';
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.env = { ...process.env, ...options.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
  }

  async run(args: string[]): Promise<GhResult> {
    try {
      const { stdout, stderr } = await execFileAsync(this.ghPath, args, {
        env: this.env,
        timeout: this.timeoutMs,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      });
      return { stdout, stderr, code: 0 };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      if (failure.code === 'ENOENT') {
        throw new DeadDropError(
          'CONFIG_INVALID',
          `the github transport needs the GitHub CLI ("${this.ghPath}") on PATH. ` +
            'Install it from https://cli.github.com and run "gh auth login".',
          { cause: error },
        );
      }
      return {
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? String((error as Error).message),
        code: typeof failure.code === 'number' ? failure.code : 1,
      };
    }
  }

  async authStatus(): Promise<{ authenticated: boolean; message: string }> {
    const result = await this.run(['auth', 'status']);
    // `gh auth status` writes to stderr even on success.
    const message = (result.stderr || result.stdout).trim().split('\n')[0] ?? '';
    return { authenticated: result.code === 0, message };
  }

  async repoInfo(repo: string): Promise<GhRepoInfo | undefined> {
    const result = await this.run([
      'repo',
      'view',
      repo,
      '--json',
      'nameWithOwner,url,isPrivate,defaultBranchRef',
    ]);
    if (result.code !== 0) {
      if (/could not resolve|not found|404/i.test(result.stderr)) return undefined;
      throw new DeadDropError(
        'TRANSPORT_ERROR',
        `gh repo view failed: ${firstLine(result.stderr)}`,
        {
          retryable: true,
        },
      );
    }
    return parseRepoJson(result.stdout);
  }

  async createRepo(
    repo: string,
    options: { private: boolean; description?: string },
  ): Promise<GhRepoInfo> {
    const args = ['repo', 'create', repo, options.private ? '--private' : '--public'];
    if (options.description) args.push('--description', options.description);
    const result = await this.run(args);
    if (result.code !== 0) {
      throw new DeadDropError(
        'TRANSPORT_ERROR',
        `gh repo create failed: ${firstLine(result.stderr)}`,
      );
    }
    const created = await this.repoInfo(repo);
    if (!created) {
      throw new DeadDropError('TRANSPORT_ERROR', `created ${repo} but it is still not visible`);
    }
    return created;
  }

  async rateLimit(): Promise<GhRateLimit | undefined> {
    const result = await this.run(['api', 'rate_limit']);
    if (result.code !== 0) return undefined;
    try {
      const parsed = JSON.parse(result.stdout) as {
        resources?: { core?: { limit?: number; remaining?: number; reset?: number } };
      };
      const core = parsed.resources?.core;
      if (!core || typeof core.limit !== 'number' || typeof core.remaining !== 'number') {
        return undefined;
      }
      return {
        limit: core.limit,
        remaining: core.remaining,
        resetAt: typeof core.reset === 'number' ? core.reset * 1000 : 0,
      };
    } catch {
      return undefined;
    }
  }
}

export function parseRepoJson(text: string): GhRepoInfo | undefined {
  try {
    const parsed = JSON.parse(text) as {
      nameWithOwner?: string;
      url?: string;
      isPrivate?: boolean;
      defaultBranchRef?: { name?: string } | null;
    };
    if (typeof parsed.nameWithOwner !== 'string' || typeof parsed.url !== 'string')
      return undefined;
    return {
      nameWithOwner: parsed.nameWithOwner,
      url: parsed.url,
      isPrivate: parsed.isPrivate === true,
      defaultBranch: parsed.defaultBranchRef?.name ?? 'main',
    };
  } catch {
    return undefined;
  }
}

/** `owner/name`, rejecting anything that could be a flag or a shell surprise. */
export function isValidRepo(repo: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo);
}

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim().length > 0) ?? 'no output')
    .trim()
    .slice(0, 300);
}
