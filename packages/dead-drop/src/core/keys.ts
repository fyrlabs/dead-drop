/**
 * Transport key layout.
 *
 * ```text
 *   ws/<workspace>/inbox/<peer>/<messageId>.ddf    direct messages for <peer>
 *   ws/<workspace>/topic/<channel>/<messageId>.ddf broadcast events, retained
 *   ws/<workspace>/peers/<peer>.ddf                presence beacon
 *   ws/<workspace>/dead/<peer>/<messageId>.ddf     dead letters
 *   ws/<workspace>/ids/<peer>.ddi                  enrolled public key
 *   ws/<workspace>/keys/<peer>/<eraId>.ddw         era key wrapped to <peer>
 *   ws/<workspace>/era.dde                         which era seals new frames
 * ```
 *
 * The last three are [ADR 0007](../../../../docs/adr/0007-per-peer-key-wrapping.md).
 * Wrapped keys are grouped by peer and not by era so a peer lists exactly one
 * prefix to find everything addressed to it, the same shape as its inbox. Grouped
 * by era it would have to sweep every era that has ever existed to find its own.
 *
 * Both are long-lived and belong to a peer that may be offline for weeks, which
 * is the opposite of the profile the reapers collect. They are outside every
 * prefix the reapers walk, and `test/runtime/workspace.test.ts` holds a test that
 * fails if that stops being true.
 *
 * Message ids sort by creation time, so listing a prefix in lexicographic order
 * gives rough FIFO for free, and a subscriber can resume from the last key it
 * saw with `startAfter`.
 *
 * Keys are readable on purpose: when the transport is a git repo or a synced
 * folder, an operator has to be able to look at it. The cost is that workspace,
 * peer and channel names are visible to whoever can read the store, which is
 * why frame contents are encrypted and this is called out in the security docs.
 */

import { joinKey } from '@fyrlabs/dead-drop-transport-sdk';

export const FRAME_EXTENSION = '.ddf';
const ROOT = 'ws';

export const workspaceRoot = (workspace: string): string => joinKey(ROOT, workspace);

/** Every peer's inbox, not just one. Listing it is how queued depth is read. */
export const inboxRoot = (workspace: string): string => joinKey(ROOT, workspace, 'inbox');

export const inboxPrefix = (workspace: string, peerId: string): string =>
  joinKey(ROOT, workspace, 'inbox', peerId);

export const inboxKey = (workspace: string, peerId: string, messageId: string): string =>
  joinKey(ROOT, workspace, 'inbox', peerId, `${messageId}${FRAME_EXTENSION}`);

export const topicPrefix = (workspace: string, channel: string): string =>
  joinKey(ROOT, workspace, 'topic', ...channel.split('/'));

export const topicKey = (workspace: string, channel: string, messageId: string): string =>
  joinKey(ROOT, workspace, 'topic', ...channel.split('/'), `${messageId}${FRAME_EXTENSION}`);

export const peersPrefix = (workspace: string): string => joinKey(ROOT, workspace, 'peers');

export const peerKey = (workspace: string, peerId: string): string =>
  joinKey(ROOT, workspace, 'peers', `${peerId}${FRAME_EXTENSION}`);

export const IDENTITY_EXTENSION = '.ddi';
export const WRAPPED_KEY_EXTENSION = '.ddw';
export const ERA_POINTER_EXTENSION = '.dde';

/**
 * Names the era new frames are sealed under. One object per workspace.
 *
 * At the workspace root rather than under `keys/`, so it cannot collide with a
 * peer prefix however a peer happens to be named, and so a listing of one
 * peer's wrapped keys never returns it.
 */
export const eraPointerKey = (workspace: string): string =>
  joinKey(ROOT, workspace, `era${ERA_POINTER_EXTENSION}`);

/** Every enrolled identity. Listed to discover peers that may be wrapped for. */
export const identityPrefix = (workspace: string): string => joinKey(ROOT, workspace, 'ids');

export const identityKey = (workspace: string, peerId: string): string =>
  joinKey(ROOT, workspace, 'ids', `${peerId}${IDENTITY_EXTENSION}`);

/** Every wrapped key in the workspace, for diagnostics only. */
export const wrappedKeyRoot = (workspace: string): string => joinKey(ROOT, workspace, 'keys');

/** The keys addressed to one peer, across every era. A peer lists only its own. */
export const wrappedKeyPrefix = (workspace: string, peerId: string): string =>
  joinKey(ROOT, workspace, 'keys', peerId);

export const wrappedKeyKey = (workspace: string, peerId: string, eraId: string): string =>
  joinKey(ROOT, workspace, 'keys', peerId, `${eraId}${WRAPPED_KEY_EXTENSION}`);

export const deadLetterPrefix = (workspace: string, peerId: string): string =>
  joinKey(ROOT, workspace, 'dead', peerId);

export const deadLetterKey = (workspace: string, peerId: string, messageId: string): string =>
  joinKey(ROOT, workspace, 'dead', peerId, `${messageId}${FRAME_EXTENSION}`);

/** Recovers the message id from a frame key, or `undefined` if it is not one. */
export function messageIdFromKey(key: string): string | undefined {
  const last = key.slice(key.lastIndexOf('/') + 1);
  if (!last.endsWith(FRAME_EXTENSION)) return undefined;
  const id = last.slice(0, -FRAME_EXTENSION.length);
  return id.length > 0 ? id : undefined;
}

/**
 * Splits an inbox key back into the peer it is addressed to and the message id.
 *
 * `undefined` for anything that is not `ws/<workspace>/inbox/<peer>/<id>.ddf`,
 * so a listing of the whole inbox root can be read without trusting the store
 * to hold only what dead-drop put there.
 */
/**
 * Recovers the peer a beacon belongs to, or `undefined` if the key is not one.
 *
 * The counterpart to `parseInboxKey`, and it exists for the same reason: a
 * listing of `ws/<workspace>/peers` has to be readable without trusting the
 * store to hold only what dead-drop put there. Whether a beacon object *exists*
 * is a liveness signal on its own, separate from whether its frame decodes.
 */
export function parsePeerKey(workspace: string, key: string): string | undefined {
  const root = `${peersPrefix(workspace)}/`;
  if (!key.startsWith(root)) return undefined;
  const rest = key.slice(root.length);
  if (rest.includes('/') || !rest.endsWith(FRAME_EXTENSION)) return undefined;
  const peerId = rest.slice(0, -FRAME_EXTENSION.length);
  return peerId.length > 0 ? peerId : undefined;
}

/**
 * Recovers the peer an identity object belongs to.
 *
 * Same contract as `parsePeerKey`: a listing of `ws/<workspace>/ids` cannot be
 * trusted to hold only what dead-drop put there, so anything that is not exactly
 * `<peer>.ddi` at that depth is not an identity.
 */
export function parseIdentityKey(workspace: string, key: string): string | undefined {
  const root = `${identityPrefix(workspace)}/`;
  if (!key.startsWith(root)) return undefined;
  const rest = key.slice(root.length);
  if (rest.includes('/') || !rest.endsWith(IDENTITY_EXTENSION)) return undefined;
  const peerId = rest.slice(0, -IDENTITY_EXTENSION.length);
  return peerId.length > 0 ? peerId : undefined;
}

/** Splits a wrapped-key object back into the peer it is for and the era it carries. */
export function parseWrappedKey(
  workspace: string,
  key: string,
): { peerId: string; eraId: string } | undefined {
  const root = `${wrappedKeyRoot(workspace)}/`;
  if (!key.startsWith(root)) return undefined;
  const parts = key.slice(root.length).split('/');
  if (parts.length !== 2) return undefined;
  const peerId = parts[0] as string;
  const last = parts[1] as string;
  if (!last.endsWith(WRAPPED_KEY_EXTENSION)) return undefined;
  const eraId = last.slice(0, -WRAPPED_KEY_EXTENSION.length);
  if (peerId.length === 0 || eraId.length === 0) return undefined;
  return { peerId, eraId };
}

export function parseInboxKey(
  workspace: string,
  key: string,
): { peerId: string; messageId: string } | undefined {
  const root = `${inboxRoot(workspace)}/`;
  if (!key.startsWith(root)) return undefined;
  const parts = key.slice(root.length).split('/');
  if (parts.length !== 2) return undefined;
  const peerId = parts[0] as string;
  const messageId = messageIdFromKey(parts[1] as string);
  if (peerId.length === 0 || messageId === undefined) return undefined;
  return { peerId, messageId };
}
