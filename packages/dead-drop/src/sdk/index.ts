/**
 * `@fyrlabs/dead-drop/sdk` — the optional application-facing client.
 *
 * Optional is the point: an existing application is exposed with
 * `ddrop expose` and never imports this. The SDK is for applications that want
 * dead-drop-native interactions — publish/subscribe, RPC, services.
 *
 * It talks to the local runtime over the control-plane socket, so transport
 * credentials and workspace secrets stay in the runtime process and out of
 * application memory.
 */

import { DeadDropError } from '../protocol/index.js';
import { ControlPlaneClient, defaultSocketPath, DEFAULT_DATA_DIR } from '../runtime/index.js';
import type { PeerRecord, RuntimeStatus, TransportInfoLike } from './types.js';

export type { PeerRecord, RuntimeStatus, TransportInfoLike };

export interface ClientOptions {
  /** Workspace to act in. Defaults to the runtime's first workspace. */
  workspace?: string;
  /** Control plane socket. Defaults to `<dataDir>/deaddrop.sock`. */
  socketPath?: string;
  dataDir?: string;
  /** Default timeout for `call`. Default 30s. */
  timeoutMs?: number;
}

export class DeadDropClient {
  private readonly control: ControlPlaneClient;
  private readonly workspace: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions = {}) {
    const socketPath = options.socketPath ?? defaultSocketPath(options.dataDir ?? DEFAULT_DATA_DIR);
    this.control = new ControlPlaneClient(socketPath);
    this.workspace = options.workspace;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Throws with an actionable message when no runtime is listening. */
  async ping(): Promise<{ ok: boolean; version: string }> {
    return this.control.request('GET', '/health');
  }

  async status(): Promise<RuntimeStatus> {
    return this.control.request('GET', '/status');
  }

  async peers(options: { includeStale?: boolean } = {}): Promise<PeerRecord[]> {
    const query = this.query({ ...(options.includeStale ? { stale: 'true' } : {}) });
    const body = await this.control.request<{ peers: PeerRecord[] }>('GET', `/peers${query}`);
    return body.peers;
  }

  async transports(): Promise<TransportInfoLike[]> {
    const body = await this.control.request<{ transports: TransportInfoLike[] }>(
      'GET',
      `/transports${this.query()}`,
    );
    return body.transports;
  }

  /** Broadcasts an event. Returns the message id. */
  async publish(channel: string, payload: unknown): Promise<string> {
    const body = await this.control.request<{ id: string }>('POST', `/publish${this.query()}`, {
      channel,
      payload,
    });
    return body.id;
  }

  /**
   * Calls `channel` on `target` and returns the decoded result.
   *
   * Remote handler failures arrive as `DeadDropError`s with the remote code
   * preserved, so a caller can distinguish "no such service" from "the service
   * threw" without string matching.
   */
  async call<T = unknown>(
    target: string,
    channel: string,
    input: unknown = null,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    const body = await this.control.request<{ result: T }>(
      'POST',
      `/call${this.query()}`,
      { target, channel, input, timeoutMs: options.timeoutMs ?? this.timeoutMs },
      { timeoutMs: (options.timeoutMs ?? this.timeoutMs) + 5000 },
    );
    return body.result;
  }

  async metrics(): Promise<string> {
    return this.control.request<string>('GET', '/metrics');
  }

  private query(extra: Record<string, string> = {}): string {
    const params = new URLSearchParams(extra);
    if (this.workspace) params.set('workspace', this.workspace);
    const text = params.toString();
    return text ? `?${text}` : '';
  }
}

/** Convenience factory matching the shape used in the design docs. */
export function createClient(options: ClientOptions = {}): DeadDropClient {
  return new DeadDropClient(options);
}

export { DeadDropError };
