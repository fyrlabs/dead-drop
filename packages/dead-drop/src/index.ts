/**
 * `@fyrlabs/dead-drop` root entry.
 *
 * Most applications want the client: it talks to a runtime that is already
 * running and needs nothing else. Deeper layers are reachable by subpath so
 * importing the client never drags the whole runtime in:
 *
 *   @fyrlabs/dead-drop/runtime               embed the runtime in your process
 *   @fyrlabs/dead-drop/core                  mailbox engine, transport manager
 *   @fyrlabs/dead-drop/protocol              envelope, framing, encryption
 *   @fyrlabs/dead-drop/transports/<name>     filesystem, git, github, memory
 *
 * Writing a transport needs none of this. Depend on
 * `@fyrlabs/dead-drop-transport-sdk` instead, which is the stable contract.
 */

export * from './sdk/index.js';
