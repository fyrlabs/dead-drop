import { afterEach, describe, expect, it } from 'vitest';

import { decodeHttpRequest, encodeHttpResponse } from '#dead-drop/protocol/index.js';
import {
  HTTP_STREAM_OFFER_HEADER,
  encodeHttpStreamHead,
  encodeHttpStreamPart,
  httpStreamChannel,
  type HttpStreamPart,
} from '#dead-drop/protocol/stream.js';
import { connect, type ConnectHandle } from '#dead-drop/runtime/connect.js';
import { TestClock } from '#dead-drop/core/clock.js';
import type { Clock } from '#dead-drop/core/clock.js';
import type { Workspace } from '#dead-drop/runtime/workspace.js';
import { createLogger } from '#dead-drop/core/observability/logger.js';

type EventHandler = (payload: Uint8Array, context: unknown) => void;

/**
 * A workspace that answers one request and lets the test post body parts.
 *
 * `offered` is the stream id the connect server minted, which is the thing the
 * exposure would read off the request. Capturing it is how these tests prove
 * the id travels in the request rather than coming back in the head.
 */
function stubWorkspace(reply: (streamId: string | undefined) => Uint8Array) {
  const subscriptions = new Map<string, Set<EventHandler>>();
  let offered: string | undefined;

  const workspace = {
    subscribe(channel: string, handler: EventHandler) {
      let handlers = subscriptions.get(channel);
      if (!handlers) {
        handlers = new Set();
        subscriptions.set(channel, handlers);
      }
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) subscriptions.delete(channel);
      };
    },
    async request(_target: string, _channel: string, payload: Uint8Array) {
      const request = decodeHttpRequest(payload);
      const raw = request.headers[HTTP_STREAM_OFFER_HEADER];
      offered = Array.isArray(raw) ? raw[0] : raw;
      return { payload: reply(offered) };
    },
  } as unknown as Workspace;

  const post = (part: HttpStreamPart): void => {
    if (!offered) throw new Error('no stream id was offered');
    const handlers = subscriptions.get(httpStreamChannel(offered));
    if (!handlers) throw new Error('nothing is subscribed to the stream channel');
    for (const handler of handlers) handler(encodeHttpStreamPart(part), {});
  };

  return {
    workspace,
    subscriptions,
    post,
    streamId: () => offered,
    /** True while the connect server is still listening for parts. */
    listening: () => (offered ? subscriptions.has(httpStreamChannel(offered)) : false),
  };
}

const streamHead = (streamId: string | undefined) =>
  encodeHttpStreamHead({
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'text/plain' },
    streamId: streamId ?? 'str_missing00000000000000',
  });

const chunk = (seq: number, text: string): HttpStreamPart => ({
  kind: 'chunk',
  seq,
  body: Buffer.from(text, 'utf8'),
});

let open: ConnectHandle | undefined;

async function start(workspace: Workspace, clock?: Clock, streamGapTimeoutMs?: number) {
  open = await connect({
    workspace,
    target: 'peer-a',
    exposure: 'web',
    logger: createLogger({ level: 'silent' }),
    ...(clock ? { clock } : {}),
    ...(streamGapTimeoutMs !== undefined ? { streamGapTimeoutMs } : {}),
  });
  return open;
}

/** Waits for a condition the server reaches on its own timeline. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe('receiving a streamed response', () => {
  it('offers a stream id in the request and writes the body it gets back', async () => {
    const stub = stubWorkspace(streamHead);
    const handle = await start(stub.workspace);

    const response = fetch(`${handle.url}/`);
    await until(() => stub.listening(), 'the stream subscription');

    stub.post(chunk(0, 'one '));
    stub.post(chunk(1, 'two '));
    stub.post({ kind: 'end', seq: 2 });

    const settled = await response;
    expect(settled.status).toBe(200);
    expect(await settled.text()).toBe('one two ');
    expect(stub.streamId()).toMatch(/^str_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('orders parts that arrive shuffled', async () => {
    const stub = stubWorkspace(streamHead);
    const handle = await start(stub.workspace);

    const response = fetch(`${handle.url}/`);
    await until(() => stub.listening(), 'the stream subscription');

    // Delivery is best-effort, so the transport is allowed to do exactly this.
    stub.post(chunk(2, 'three'));
    stub.post(chunk(0, 'one '));
    stub.post({ kind: 'end', seq: 3 });
    stub.post(chunk(1, 'two '));

    expect(await (await response).text()).toBe('one two three');
  });

  it('releases the subscription once the stream has ended', async () => {
    const stub = stubWorkspace(streamHead);
    const handle = await start(stub.workspace);

    const response = fetch(`${handle.url}/`);
    await until(() => stub.listening(), 'the stream subscription');
    stub.post({ kind: 'end', seq: 0 });
    await response;

    expect(stub.listening()).toBe(false);
  });

  it('truncates the connection when the remote stream fails part-way', async () => {
    const stub = stubWorkspace(streamHead);
    const handle = await start(stub.workspace);

    const response = fetch(`${handle.url}/`);
    await until(() => stub.listening(), 'the stream subscription');

    stub.post(chunk(0, 'partial'));
    stub.post({ kind: 'error', seq: 1, code: 'TRANSPORT_ERROR', message: 'upstream went away' });

    // The status was already sent, so the only signal left is a broken body.
    // Reading it has to fail rather than quietly returning the partial text.
    const settled = await response;
    expect(settled.status).toBe(200);
    await expect(settled.text()).rejects.toThrow();
    expect(stub.listening()).toBe(false);
  });

  it('fails a stream that stalls longer than the gap timeout', async () => {
    const clock = new TestClock(1000);
    const stub = stubWorkspace(streamHead);
    const handle = await start(stub.workspace, clock, 400);

    const response = fetch(`${handle.url}/`);
    await until(() => stub.listening(), 'the stream subscription');

    stub.post(chunk(0, 'first'));
    // Part 1 never comes. Nothing else should keep this response open.
    await clock.advance(500);

    await expect((await response).text()).rejects.toThrow();
    expect(stub.listening()).toBe(false);
  });

  it('releases the subscription when the local client hangs up', async () => {
    const stub = stubWorkspace(streamHead);
    const handle = await start(stub.workspace);

    const aborter = new AbortController();
    // The head has already arrived by the time this resolves, which is exactly
    // the state a browser is in while it reads an open event stream.
    const response = fetch(`${handle.url}/`, { signal: aborter.signal });
    await until(() => stub.listening(), 'the stream subscription');
    stub.post(chunk(0, 'started'));
    const settled = await response;

    aborter.abort();
    await expect(settled.text()).rejects.toThrow();

    // An event stream ends by the reader going away. That has to release the
    // subscription, or every closed tab leaks one.
    await until(() => !stub.listening(), 'the subscription to be released');
  });
});

describe('receiving an ordinary response', () => {
  it('still answers a buffered reply and leaves nothing subscribed', async () => {
    const stub = stubWorkspace(() =>
      encodeHttpResponse({
        status: 201,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('buffered', 'utf8'),
      }),
    );
    const handle = await start(stub.workspace);

    const settled = await fetch(`${handle.url}/`);
    expect(settled.status).toBe(201);
    expect(await settled.text()).toBe('buffered');
    expect(stub.listening()).toBe(false);
  });
});
