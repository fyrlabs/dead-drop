/**
 * A thin, typed wrapper around the `git` binary.
 *
 * Shelling out rather than binding a git library: the point of this transport
 * is to work with whatever credential helper, proxy, SSH key and host config
 * the user already has, and only the real `git` binary honours all of that.
 * `gh auth setup-git` works for free as a result.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { BridgeError } from '@fyrlabs/dead-drop-protocol';

const execFileAsync = promisify(execFile);

export interface GitOptions {
  /** Path to the git binary. Default `git`. */
  gitPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Largest stdout git may produce, in bytes. Default 64 MiB. */
  maxBuffer?: number;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class Git {
  private readonly gitPath: string;
  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly maxBuffer: number;

  constructor(options: GitOptions = {}) {
    this.gitPath = options.gitPath ?? 'git';
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxBuffer = options.maxBuffer ?? 64 * 1024 * 1024;
    this.env = {
      ...process.env,
      ...options.env,
      // Never let git block on a credential or passphrase prompt: a runtime is
      // usually headless, and a hung prompt looks exactly like a dead transport.
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: process.env.GIT_ASKPASS ?? 'echo',
      // Deterministic output regardless of the operator's locale.
      LC_ALL: 'C',
    };
  }

  withCwd(cwd: string): Git {
    return new Git({
      gitPath: this.gitPath,
      cwd,
      env: this.env,
      timeoutMs: this.timeoutMs,
      maxBuffer: this.maxBuffer,
    });
  }

  /** Runs git, throwing a `BridgeError` on a non-zero exit. */
  async run(args: string[], options: { signal?: AbortSignal } = {}): Promise<GitResult> {
    const result = await this.tryRun(args, options);
    if (result.code !== 0) {
      throw new BridgeError(
        'TRANSPORT_ERROR',
        `git ${args[0]} failed: ${firstLine(result.stderr)}`,
        {
          details: { args: redactArgs(args), code: result.code },
          retryable: isRetryableGitError(result.stderr),
        },
      );
    }
    return result;
  }

  /** Runs git and reports the exit code instead of throwing. */
  async tryRun(args: string[], options: { signal?: AbortSignal } = {}): Promise<GitResult> {
    try {
      const { stdout, stderr } = await execFileAsync(this.gitPath, args, {
        ...(this.cwd ? { cwd: this.cwd } : {}),
        env: this.env,
        timeout: this.timeoutMs,
        maxBuffer: this.maxBuffer,
        ...(options.signal ? { signal: options.signal } : {}),
        encoding: 'utf8',
      });
      return { stdout, stderr, code: 0 };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        killed?: boolean;
      };
      if (failure.code === 'ENOENT') {
        throw new BridgeError(
          'CONFIG_INVALID',
          `the git transport needs the "${this.gitPath}" binary on PATH`,
          { cause: error },
        );
      }
      if (failure.killed) {
        throw new BridgeError('TIMEOUT', `git ${args[0]} exceeded ${this.timeoutMs}ms`, {
          cause: error,
        });
      }
      if ((error as Error).name === 'AbortError') {
        throw new BridgeError('CANCELLED', 'git command aborted', { cause: error });
      }
      return {
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? String((error as Error).message ?? error),
        code: typeof failure.code === 'number' ? failure.code : 1,
      };
    }
  }
}

/** Errors where trying the same command again can plausibly work. */
export function isRetryableGitError(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return (
    text.includes('could not resolve host') ||
    text.includes('connection timed out') ||
    text.includes('connection reset') ||
    text.includes('the remote end hung up') ||
    text.includes('rpc failed') ||
    text.includes('early eof') ||
    text.includes('index.lock') ||
    text.includes('unable to access') ||
    text.includes('502') ||
    text.includes('503')
  );
}

/** True when a push failed because someone else pushed first. */
export function isNonFastForward(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return (
    text.includes('non-fast-forward') ||
    text.includes('fetch first') ||
    text.includes('rejected') ||
    text.includes('cannot lock ref') ||
    text.includes('failed to push some refs')
  );
}

function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0);
  return redactUrl(line?.trim() ?? 'no output').slice(0, 500);
}

/** Strips inline credentials from remote urls before they reach a log. */
export function redactUrl(text: string): string {
  return text.replace(/\/\/[^\s/@]+:[^\s/@]+@/g, '//[redacted]@');
}

function redactArgs(args: string[]): string[] {
  return args.map((arg) => (arg.includes('://') ? redactUrl(arg) : arg));
}
