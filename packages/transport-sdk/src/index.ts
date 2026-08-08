/**
 * `@fyrlabs/dead-drop-transport-sdk` — everything a transport author needs and nothing
 * else. This package is intentionally small and stable: adapters compile
 * against it, and third-party packages must keep working across dead-drop releases.
 *
 * The conformance suite lives at `@fyrlabs/dead-drop-transport-sdk/testing`.
 */

export * from './define.js';
export * from './errors.js';
export * from './keys.js';
export * from './types.js';
