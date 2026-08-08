/**
 * `@dead-drop/core` — the machinery between an application and a transport.
 *
 * Everything here is policy: which transport carries a message, when to retry,
 * when to give up, what to record. The protocol package decides what a message
 * *is*; this package decides what happens to it.
 */

export * from './clock.js';
export * from './keys.js';
export * from './mailbox.js';
export * from './observability/logger.js';
export * from './observability/metrics.js';
export * from './observability/tracer.js';
export * from './reliability/circuit-breaker.js';
export * from './reliability/dedupe.js';
export * from './reliability/retry.js';
export * from './transport-manager.js';
