import { describe, expect, it } from 'vitest';

import { DeadDropError } from '#dead-drop/protocol/errors.js';
import {
  decodeHttpStreamHead,
  decodeHttpStreamPart,
  encodeHttpStreamHead,
  encodeHttpStreamPart,
  httpStreamChannel,
  type HttpStreamPart,
} from '#dead-drop/protocol/stream.js';

const STREAM = 'strm_01JABCDEF';

/** A payload with the u32be head length in front, for feeding decoders bad input. */
function framed(json: string): Uint8Array {
  const head = Buffer.from(json, 'utf8');
  const out = Buffer.alloc(4 + head.length);
  out.writeUInt32BE(head.length, 0);
  head.copy(out, 4);
  return new Uint8Array(out);
}

describe('http stream head', () => {
  it('round-trips status, headers and stream id', () => {
    const decoded = decodeHttpStreamHead(
      encodeHttpStreamHead({
        status: 200,
        statusText: 'OK',
        streamId: STREAM,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    expect(decoded).toEqual({
      status: 200,
      statusText: 'OK',
      streamId: STREAM,
      headers: { 'content-type': 'text/event-stream' },
    });
  });

  it('strips hop-by-hop headers, as the buffered path does', () => {
    // content-length is meaningless on a stream and actively harmful: the
    // receiver writes bytes as they arrive and cannot honour a declared length.
    const decoded = decodeHttpStreamHead(
      encodeHttpStreamHead({
        status: 200,
        streamId: STREAM,
        headers: { 'content-length': '10', connection: 'keep-alive', 'x-keep': 'yes' },
      }),
    );
    expect(decoded.headers).toEqual({ 'x-keep': 'yes' });
  });

  it('refuses a stream id that would not be safe in a channel name', () => {
    expect(() =>
      encodeHttpStreamHead({ status: 200, streamId: '../../etc', headers: {} }),
    ).toThrowError(DeadDropError);
  });

  it('rejects a status outside the http range', () => {
    expect(() =>
      decodeHttpStreamHead(framed(`{"status":900,"streamId":"${STREAM}"}`)),
    ).toThrowError(/status is out of range/);
  });

  it('rejects a head whose stream id would not be safe in a channel name', () => {
    expect(() =>
      decodeHttpStreamHead(framed('{"status":200,"streamId":"../../etc"}')),
    ).toThrowError(/no usable stream id/);
  });

  it('rejects headers that are not strings', () => {
    expect(() =>
      decodeHttpStreamHead(framed(`{"status":200,"streamId":"${STREAM}","headers":{"x":7}}`)),
    ).toThrowError(/not a string/);
  });

  it('names the channel its body travels on', () => {
    expect(httpStreamChannel(STREAM)).toBe(`httpstream/${STREAM}`);
  });
});

describe('http stream parts', () => {
  it('round-trips a chunk without copying the body through json', () => {
    const body = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const decoded = decodeHttpStreamPart(encodeHttpStreamPart({ kind: 'chunk', seq: 7, body }));
    expect(decoded).toEqual({ kind: 'chunk', seq: 7, body });
  });

  it('round-trips end and error', () => {
    expect(decodeHttpStreamPart(encodeHttpStreamPart({ kind: 'end', seq: 3 }))).toEqual({
      kind: 'end',
      seq: 3,
    });
    const error: HttpStreamPart = {
      kind: 'error',
      seq: 4,
      code: 'TRANSPORT_ERROR',
      message: 'upstream went away',
    };
    expect(decodeHttpStreamPart(encodeHttpStreamPart(error))).toEqual(error);
  });

  it('refuses a negative or fractional sequence', () => {
    expect(() => encodeHttpStreamPart({ kind: 'end', seq: -1 })).toThrowError(DeadDropError);
    expect(() => encodeHttpStreamPart({ kind: 'end', seq: 1.5 })).toThrowError(DeadDropError);
  });

  it('refuses an error part with nothing in it', () => {
    // An error that decodes to a blank would be delivered as a clean end, which
    // is the one failure a caller cannot detect for itself.
    expect(() => decodeHttpStreamPart(framed('{"kind":"error","seq":1}'))).toThrowError(
      /missing code or message/,
    );
  });

  it('refuses a kind it does not know', () => {
    expect(() => decodeHttpStreamPart(framed('{"kind":"nope","seq":1}'))).toThrowError(
      /unknown stream part kind nope/,
    );
  });
});
