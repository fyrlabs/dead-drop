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
