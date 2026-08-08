/**
 * Lexicographically sortable identifiers (ULID layout: 48-bit timestamp + 80-bit
 * randomness, Crockford base32, 26 characters).
 *
 * Sortability matters: object-store transports list message keys in
 * lexicographic order, and prefixing keys with a sortable id is what gives the
 * mailbox engine rough FIFO ordering for free.
 */

import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;
/** Largest timestamp representable in 10 Crockford base32 chars: 2^48 - 1 ms. */
export const MAX_ID_TIME = 281474976710655;

let lastTime = -1;
let lastRandom: Uint8Array = new Uint8Array(10);

function encodeTime(time: number): string {
  let out = '';
  let value = time;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ALPHABET[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 80 bits -> 16 base32 chars, consumed 5 bits at a time from a bit cursor.
  let out = '';
  let bitPos = 0;
  for (let i = 0; i < RANDOM_LEN; i++) {
    const byteIndex = bitPos >> 3;
    const bitOffset = bitPos & 7;
    const hi = bytes[byteIndex] ?? 0;
    const lo = bytes[byteIndex + 1] ?? 0;
    const window = ((hi << 8) | lo) >> (11 - bitOffset);
    out += ALPHABET[window & 31];
    bitPos += 5;
  }
  return out;
}

/** Increments the random component in place so ids stay monotonic inside one millisecond. */
function bumpRandom(bytes: Uint8Array): Uint8Array {
  const next = Uint8Array.from(bytes);
  for (let i = next.length - 1; i >= 0; i--) {
    const value = next[i] ?? 0;
    if (value < 255) {
      next[i] = value + 1;
      return next;
    }
    next[i] = 0;
  }
  // Overflowed 80 bits of randomness within a millisecond; start over.
  return Uint8Array.from(randomBytes(10));
}

/**
 * Creates a sortable 26-character id.
 * Two ids created in the same millisecond still compare in creation order.
 */
export function createId(now: number = Date.now()): string {
  const time = Math.max(0, Math.min(Math.floor(now), MAX_ID_TIME));
  if (time === lastTime) {
    lastRandom = bumpRandom(lastRandom);
  } else {
    lastTime = time;
    lastRandom = Uint8Array.from(randomBytes(10));
  }
  return encodeTime(time) + encodeRandom(lastRandom);
}

/** `msg_01J...` style prefixed id, used for message, request and peer identifiers. */
export function createPrefixedId(prefix: string, now?: number): string {
  return `${prefix}_${createId(now)}`;
}

export const createMessageId = (now?: number): string => createPrefixedId('msg', now);
export const createRequestId = (now?: number): string => createPrefixedId('req', now);
export const createGroupId = (now?: number): string => createPrefixedId('grp', now);

const ID_PATTERN = new RegExp(`^[${ALPHABET}]{26}$`);

export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/** Extracts the creation time from an id, or `undefined` if it is not a dead-drop id. */
export function idTime(value: string): number | undefined {
  const raw = value.includes('_') ? value.slice(value.indexOf('_') + 1) : value;
  if (!isValidId(raw)) return undefined;
  let time = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const index = ALPHABET.indexOf(raw[i] as string);
    if (index < 0) return undefined;
    time = time * 32 + index;
  }
  return time;
}
