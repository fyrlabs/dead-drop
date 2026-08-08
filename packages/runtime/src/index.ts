/**
 * `@fyrlabs/dead-drop-runtime` — the agent that runs on a machine.
 *
 * Owns workspaces, loads transport plugins, exposes local applications and
 * answers the control plane. Applications normally reach it through
 * `@fyrlabs/dead-drop-sdk` or the `bridge` CLI rather than importing it directly, but
 * embedding it in a process is supported and is what the examples do.
 */

export * from './config.js';
export * from './connect.js';
export * from './control-plane.js';
export * from './exposure.js';
export * from './plugins.js';
export * from './runtime.js';
export * from './workspace.js';
