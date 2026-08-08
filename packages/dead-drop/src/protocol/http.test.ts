import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  decodeHttpRequest,
  decodeHttpResponse,
  encodeHttpRequest,
  encodeHttpResponse,
  sanitiseHeaders,
} from './http.js';

describe('http request mapping', () => {
  it('round-trips method, path, headers and a binary body', () => {
    const body = randomBytes(2048);
    const encoded = encodeHttpRequest({
      method: 'POST',
      path: '/users?active=1',
      headers: { 'content-type': 'application/json', 'x-multi': ['a', 'b'] },
      body,
    });
    const decoded = decodeHttpRequest(encoded);
    expect(decoded.method).toBe('POST');
    expect(decoded.path).toBe('/users?active=1');
    expect(decoded.headers['content-type']).toBe('application/json');
    expect(decoded.headers['x-multi']).toEqual(['a', 'b']);
    expect(Buffer.from(decoded.body).equals(body)).toBe(true);
  });

  it('does not base64 the body', () => {
    const body = Buffer.from('x'.repeat(1000));
    const encoded = encodeHttpRequest({ method: 'PUT', path: '/', headers: {}, body });
    expect(encoded.length).toBeLessThan(body.length + 200);
  });

  it('rejects malformed requests', () => {
    const bad = encodeHttpRequest({
      method: 'GET',
      path: '/',
      headers: {},
      body: new Uint8Array(),
    });
    expect(() => decodeHttpRequest(bad.slice(0, 2))).toThrowError(/truncated/);
    const forged = Buffer.concat([lengthPrefix('{"method":"get","path":"/","headers":{}}')]);
    expect(() => decodeHttpRequest(forged)).toThrowError(/method is invalid/);
    const badPath = lengthPrefix('{"method":"GET","path":"users","headers":{}}');
    expect(() => decodeHttpRequest(badPath)).toThrowError(/must start with/);
    const badHeaders = lengthPrefix('{"method":"GET","path":"/","headers":{"a":5}}');
    expect(() => decodeHttpRequest(badHeaders)).toThrowError(/must be a string/);
    const notJson = lengthPrefix('{oops');
    expect(() => decodeHttpRequest(notJson)).toThrowError(/valid JSON/);
    const notObject = lengthPrefix('[1,2]');
    expect(() => decodeHttpRequest(notObject)).toThrowError(/not an object/);
  });
});

describe('http response mapping', () => {
  it('round-trips status, status text and body', () => {
    const encoded = encodeHttpResponse({
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('missing'),
    });
    const decoded = decodeHttpResponse(encoded);
    expect(decoded.status).toBe(404);
    expect(decoded.statusText).toBe('Not Found');
    expect(Buffer.from(decoded.body).toString()).toBe('missing');
  });

  it('rejects out-of-range statuses', () => {
    const forged = lengthPrefix('{"status":42,"headers":{}}');
    expect(() => decodeHttpResponse(forged)).toThrowError(/status is out of range/);
  });

  it('rejects a head length that runs past the buffer', () => {
    const buf = Buffer.alloc(10);
    buf.writeUInt32BE(9999, 0);
    expect(() => decodeHttpResponse(buf)).toThrowError(/out of range/);
  });
});

describe('sanitiseHeaders', () => {
  it('lower-cases names and strips hop-by-hop headers', () => {
    const out = sanitiseHeaders({
      'Content-Type': 'text/html',
      Connection: 'keep-alive',
      'Transfer-Encoding': 'chunked',
      Host: 'localhost:3000',
      'Content-Length': 42,
      'X-Skip': undefined,
    });
    expect(out).toEqual({ 'content-type': 'text/html' });
  });
});

function lengthPrefix(json: string): Buffer {
  const body = Buffer.from(json, 'utf8');
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}
