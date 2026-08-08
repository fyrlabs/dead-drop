/**
 * `@dead-drop/protocol` — the Bridge wire contract.
 *
 * This package is the boundary every other package agrees on. It has no runtime
 * dependencies and knows nothing about transports, workspaces or applications:
 * it defines what a message is, how it is framed, how it is encrypted and how
 * large messages are split. Anything with policy in it belongs in `core`.
 */

export * from './chunk.js';
export * from './crypto.js';
export * from './envelope.js';
export * from './errors.js';
export * from './frame.js';
export * from './http.js';
export * from './ids.js';
export * from './json.js';
