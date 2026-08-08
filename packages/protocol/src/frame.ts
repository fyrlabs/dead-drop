/**
 * Frame codec: `Envelope` <-> bytes on a transport.
 *
 * Layout
 * ```text
 *   0  magic      4 bytes  "DDF1"
 *   4  flags      1 byte   bit0 encrypted, bit1 gzip
 *   5  keyIdLen   1 byte   0 when not encrypted
 *   6  keyId      keyIdLen bytes, ascii
 *      iv         12 bytes, only when encrypted
 *      body       ciphertext||tag when encrypted, else plaintext
 * ```
 * `plaintext = u32be(headerLen) || headerJson || payload`.
 *
 * Everything from offset 0 up to `body` is the AEAD additional data, so the
 * flags and key id are tamper-evident even though they are readable. Nothing
 * else is exposed: the envelope header, including workspace, channel and peer
 * names, is inside the ciphertext.
 */

import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';

import {
  assertValidHeader,
  splitEnvelope,
  type Envelope,
  type EnvelopeHeader,
} from './envelope.js';
import { BridgeError } from './errors.js';
import { IV_BYTES, TAG_BYTES, open, seal, type KeyRing, type WorkspaceKey } from './crypto.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const FRAME_MAGIC = Buffer.from('DDF1', 'ascii');
const FLAG_ENCRYPTED = 0b0000_0001;
const FLAG_GZIP = 0b0000_0010;
const KNOWN_FLAGS = FLAG_ENCRYPTED | FLAG_GZIP;

/** Default ceiling on a decoded frame. Guards against decompression bombs. */
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;
/** Compressing below this size costs more than it saves. */
const COMPRESS_THRESHOLD_BYTES = 1024;

export interface EncodeOptions {
  /** Omit to produce a plaintext frame (only sensible for the in-memory transport). */
  key?: WorkspaceKey;
  /**
   * `'auto'` (default) compresses when the payload is over 1 KiB and gzip
   * actually shrinks it. `false` disables it; `true` always compresses.
   */
  compress?: boolean | 'auto';
}

export interface DecodeOptions {
  keys?: KeyRing;
  maxFrameBytes?: number;
  /** Set to allow unencrypted frames. Defaults to `false` when `keys` is given. */
  allowPlaintext?: boolean;
}

export async function encodeFrame(
  envelope: Envelope,
  options: EncodeOptions = {},
): Promise<Uint8Array> {
  const { header, payload } = splitEnvelope(envelope);
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
  const headerLen = Buffer.allocUnsafe(4);
  headerLen.writeUInt32BE(headerJson.length, 0);
  const plaintext = Buffer.concat([headerLen, headerJson, Buffer.from(payload)]);

  const mode = options.compress ?? 'auto';
  let body = plaintext;
  let flags = 0;
  if (mode === true || (mode === 'auto' && plaintext.length > COMPRESS_THRESHOLD_BYTES)) {
    const compressed = await gzipAsync(plaintext);
    if (mode === true || compressed.length < plaintext.length) {
      body = compressed;
      flags |= FLAG_GZIP;
    }
  }

  if (!options.key) {
    return Buffer.concat([buildAad(flags, ''), body]);
  }

  flags |= FLAG_ENCRYPTED;
  const aad = buildAad(flags, options.key.id);
  const sealed = seal(options.key, body, aad);
  return Buffer.concat([aad, sealed.iv, sealed.ciphertext, sealed.tag]);
}

/** Everything before the iv: magic, flags, key id. Authenticated, not encrypted. */
function buildAad(flags: number, keyId: string): Buffer {
  const keyIdBytes = Buffer.from(keyId, 'ascii');
  if (keyIdBytes.length > 255) {
    throw new BridgeError('INTERNAL', 'key id longer than 255 bytes');
  }
  return Buffer.concat([FRAME_MAGIC, Buffer.from([flags, keyIdBytes.length]), keyIdBytes]);
}

export interface DecodedFrame {
  envelope: Envelope;
  /** Key id the frame was sealed with, absent for plaintext frames. */
  keyId?: string;
  encrypted: boolean;
  compressed: boolean;
  /** Size of the frame as it appeared on the transport. */
  wireBytes: number;
}

export async function decodeFrame(
  frame: Uint8Array,
  options: DecodeOptions = {},
): Promise<DecodedFrame> {
  const buf = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  const maxBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;

  if (buf.length < 6 || !buf.subarray(0, 4).equals(FRAME_MAGIC)) {
    throw new BridgeError('DECODE_FAILED', 'not a Bridge frame (bad magic)');
  }
  const flags = buf.readUInt8(4);
  if ((flags & ~KNOWN_FLAGS) !== 0) {
    throw new BridgeError('DECODE_FAILED', `frame sets unknown flags 0x${flags.toString(16)}`);
  }
  const encrypted = (flags & FLAG_ENCRYPTED) !== 0;
  const compressed = (flags & FLAG_GZIP) !== 0;
  const keyIdLen = buf.readUInt8(5);
  const keyIdEnd = 6 + keyIdLen;
  if (buf.length < keyIdEnd) throw new BridgeError('DECODE_FAILED', 'truncated frame key id');
  const keyId = buf.subarray(6, keyIdEnd).toString('ascii');

  let body: Buffer;
  if (encrypted) {
    if (!options.keys) {
      throw new BridgeError('DECRYPT_FAILED', 'frame is encrypted but no workspace keys supplied');
    }
    const ivEnd = keyIdEnd + IV_BYTES;
    if (buf.length < ivEnd + TAG_BYTES) throw new BridgeError('DECODE_FAILED', 'truncated frame');
    const aad = buf.subarray(0, keyIdEnd);
    const iv = buf.subarray(keyIdEnd, ivEnd);
    const ciphertext = buf.subarray(ivEnd, buf.length - TAG_BYTES);
    const tag = buf.subarray(buf.length - TAG_BYTES);
    body = open(options.keys.get(keyId), iv, ciphertext, tag, aad);
  } else {
    const allowPlaintext = options.allowPlaintext ?? options.keys === undefined;
    if (!allowPlaintext) {
      throw new BridgeError('UNAUTHORIZED', 'refusing unencrypted frame on an encrypted workspace');
    }
    body = buf.subarray(keyIdEnd);
  }

  const plaintext = compressed
    ? await gunzipAsync(body, { maxOutputLength: maxBytes }).catch((cause: unknown) => {
        // zlib signals the output cap with ERR_BUFFER_TOO_LARGE. That is a size
        // problem, not a corruption problem, and callers act on it differently.
        if ((cause as NodeJS.ErrnoException | undefined)?.code === 'ERR_BUFFER_TOO_LARGE') {
          throw new BridgeError(
            'PAYLOAD_TOO_LARGE',
            `frame exceeds ${maxBytes} bytes after decompression`,
            { cause },
          );
        }
        throw new BridgeError('DECODE_FAILED', 'frame body failed to decompress', { cause });
      })
    : body;

  if (plaintext.length > maxBytes) {
    throw new BridgeError('PAYLOAD_TOO_LARGE', `frame exceeds ${maxBytes} bytes after decoding`);
  }
  if (plaintext.length < 4) throw new BridgeError('DECODE_FAILED', 'truncated envelope');
  const headerLen = plaintext.readUInt32BE(0);
  if (headerLen > plaintext.length - 4) {
    throw new BridgeError('DECODE_FAILED', 'envelope header length out of range');
  }
  let header: unknown;
  try {
    header = JSON.parse(plaintext.subarray(4, 4 + headerLen).toString('utf8'));
  } catch (cause) {
    throw new BridgeError('DECODE_FAILED', 'envelope header is not valid JSON', { cause });
  }
  assertValidHeader(header);
  // Copy rather than subarray: a view would pin the whole decoded buffer.
  const payload = new Uint8Array(plaintext.subarray(4 + headerLen));

  const result: DecodedFrame = {
    envelope: { ...(header as EnvelopeHeader), payload },
    encrypted,
    compressed,
    wireBytes: buf.length,
  };
  if (encrypted) result.keyId = keyId;
  return result;
}

/** Cheap check used by stores that may contain files Bridge did not write. */
export function looksLikeFrame(bytes: Uint8Array): boolean {
  return bytes.length >= 6 && Buffer.from(bytes.subarray(0, 4)).equals(FRAME_MAGIC);
}
