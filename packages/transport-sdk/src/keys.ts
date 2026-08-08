/**
 * Transport key rules.
 *
 * Keys are chosen by the runtime, never by an application, but adapters map
 * them onto filesystem paths, URLs and API parameters. Validating them in one
 * shared place means an adapter author cannot accidentally build the traversal
 * bug, and store transports get a ready-made guard.
 */

import { BridgeError } from '@fyrlabs/dead-drop-protocol';

export const MAX_KEY_LENGTH = 512;
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Names Windows refuses regardless of extension. */
const RESERVED_SEGMENTS = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

export function isValidKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  if (key.startsWith('/') || key.endsWith('/')) return false;
  if (key.includes('//') || key.includes('\\') || key.includes('\0')) return false;
  return key.split('/').every((segment) => {
    if (!SEGMENT_PATTERN.test(segment)) return false;
    if (segment === '.' || segment === '..') return false;
    const stem = segment.split('.')[0]?.toLowerCase() ?? '';
    return !RESERVED_SEGMENTS.has(stem);
  });
}

/** Throws unless `key` is safe to interpolate into a path or URL. */
export function assertValidKey(key: string): void {
  if (!isValidKey(key)) {
    throw new BridgeError('BAD_REQUEST', `invalid transport key: ${JSON.stringify(key)}`);
  }
}

/**
 * Prefixes are keys with the trailing-segment rule relaxed: an empty prefix
 * means "everything", and a prefix may end at a `/` boundary.
 */
export function assertValidPrefix(prefix: string): void {
  if (prefix === '') return;
  const normalised = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  if (!isValidKey(normalised)) {
    throw new BridgeError('BAD_REQUEST', `invalid transport prefix: ${JSON.stringify(prefix)}`);
  }
}

/** Joins segments into a key, rejecting anything unsafe. */
export function joinKey(...segments: string[]): string {
  const key = segments.filter((segment) => segment.length > 0).join('/');
  assertValidKey(key);
  return key;
}
