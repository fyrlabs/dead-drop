/**
 * Wire shapes returned by the control plane.
 *
 * Declared structurally rather than re-exported from `@fyrlabs/dead-drop/runtime` so an
 * application can depend on the SDK alone: these values arrive as JSON over a
 * socket, and pulling the whole runtime in just for its types would defeat the
 * point of keeping applications thin.
 */

export interface PeerRecord {
  peerId: string;
  services: string[];
  exposures: string[];
  announcedAt: number;
  startedAt: number;
  version: string;
}

export interface TransportInfoLike {
  name: string;
  id: string;
  kind: 'store' | 'native';
  status: 'healthy' | 'degraded' | 'unavailable';
  breaker: string;
  score: number;
  latencyMs?: number;
  errorRate: number;
  rateLimitRemaining?: number;
  lastHealthCheckAt: number;
  message?: string;
}

export interface RuntimeStatus {
  startedAt: number;
  uptimeMs: number;
  version: string;
  workspaces: Array<{
    name: string;
    peerId: string;
    transports: TransportInfoLike[];
    mailbox: {
      running: boolean;
      pollIntervalMs: number;
      inflight: number;
      retrying: number;
      pendingChunkGroups: number;
      subscribedTopics: string[];
      dedupeSize: number;
    };
    exposures: string[];
    handlers: string[];
  }>;
}
