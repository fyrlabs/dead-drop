/**
 * Transport key layout.
 *
 * ```text
 *   ws/<workspace>/inbox/<peer>/<messageId>.ddf    direct messages for <peer>
 *   ws/<workspace>/topic/<channel>/<messageId>.ddf broadcast events, retained
 *   ws/<workspace>/peers/<peer>.ddf                presence beacon
 *   ws/<workspace>/dead/<peer>/<messageId>.ddf     dead letters
 * ```
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
