import { describe, expect, it } from 'vitest';

import { decodeHttpResponse, encodeHttpRequest } from '#dead-drop/protocol/index.js';
import {
  HTTP_STREAM_OFFER_HEADER,
  decodeHttpStreamHead,
  decodeHttpStreamPart,
  httpStreamChannel,
  isHttpStreamHead,
  type HttpStreamPart,
} from '#dead-drop/protocol/stream.js';
import { registerExposure } from '#dead-drop/runtime/exposure.js';
import type { ExposureConfig } from '#dead-drop/runtime/config.js';
import type { Workspace } from '#dead-drop/runtime/workspace.js';
import { createLogger } from '#dead-drop/core/observability/logger.js';

const STREAM_ID = 'str_01JQTESTSTREAMIDAAAAAAAAAA';

type Handler = (
  payload: Uint8Array,
  context: { identity: string; from: string },
) => Promise<Uint8Array>;

interface Sent {
  target: string;
  channel: string;
  part: HttpStreamPart;
}

/**
 * A workspace that captures the handler and every part the pump sends.
 *
 * `settled` is what a test waits on: the pump is started by `registerExposure`
 * and deliberately not awaited, so there is nothing else to hold on to.
 */
function stubWorkspace(): {
  workspace: Workspace;
  handler: () => Handler;
  sent: Sent[];
  settled: Promise<void>;
} {
  let installed: Handler | undefined;
  const sent: Sent[] = [];
  let finish: () => void;
  const settled = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const workspace = {
    handle(_channel: string, handler: Handler) {
      installed = handler;
      return () => undefined;
    },
    registerExposure() {},
    async sendTo(target: string, channel: string, payload: Uint8Array) {
      const part = decodeHttpStreamPart(payload);
      sent.push({ target, channel, part });
      if (part.kind !== 'chunk') finish();
      return 'msg_stub';
    },
  } as unknown as Workspace;
  return {
    workspace,
    handler: () => {
      if (!installed) throw new Error('no handler was registered');
      return installed;
    },
    sent,
    settled,
  };
}

/** `null` means the caller offered no stream id at all. */
function request(offer: string | null) {
  return encodeHttpRequest({
    method: 'GET',
    path: '/',
    headers: offer === null ? {} : { [HTTP_STREAM_OFFER_HEADER]: offer },
    body: new Uint8Array(0),
  });
}

/** Runs one request through an exposure and returns the reply plus what was sent. */
async function proxy(
  config: Omit<ExposureConfig, 'name' | 'type'>,
  response: Response,
  offer: string | null = STREAM_ID,
) {
  const { workspace, handler, sent, settled } = stubWorkspace();
  registerExposure(workspace, { name: 'web', type: 'http', ...config } as ExposureConfig, {
    logger: createLogger({ level: 'silent' }),
    fetchImpl: (async () => response) as unknown as typeof fetch,
  });
  const payload = await handler()(request(offer), { identity: 'peer-b', from: 'peer-b-c1' });
  return { payload, sent, settled };
}

const streamingOn = {
  target: 'http://localhost:9999',
  streaming: { enabled: true },
} satisfies Omit<ExposureConfig, 'name' | 'type'>;

/** A response whose body arrives in the given pieces and declares no length. */
function chunked(pieces: string[], headers: Record<string, string> = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(Buffer.from(piece, 'utf8'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers });
}

describe('streaming a proxied response body', () => {
  it('sends the body as numbered parts on the caller stream channel', async () => {
    const { payload, sent, settled } = await proxy(streamingOn, chunked(['one', 'two', 'three']));
    await settled;

    expect(isHttpStreamHead(payload)).toBe(true);
    const head = decodeHttpStreamHead(payload);
    expect(head.status).toBe(200);
    expect(head.streamId).toBe(STREAM_ID);

    // Addressed to the caller's mailbox address, not its identity: a `ddrop
    // connect` session has a per-process address and that is what replies to.
    expect(sent.every((entry) => entry.target === 'peer-b-c1')).toBe(true);
    expect(sent.every((entry) => entry.channel === httpStreamChannel(STREAM_ID))).toBe(true);

    const chunks = sent.filter((entry) => entry.part.kind === 'chunk');
    expect(chunks.map((entry) => entry.part.seq)).toEqual([0, 1, 2]);
    expect(
      Buffer.concat(
        chunks.map((entry) => Buffer.from((entry.part as { body: Uint8Array }).body)),
      ).toString('utf8'),
    ).toBe('onetwothree');
  });

  it('ends at the sequence number after the last chunk', async () => {
    const { sent, settled } = await proxy(streamingOn, chunked(['a', 'b']));
    await settled;

    const last = sent.at(-1)?.part;
    expect(last).toEqual({ kind: 'end', seq: 2 });
    expect(sent.filter((entry) => entry.part.kind === 'chunk')).toHaveLength(2);
  });

  it('reports a body that fails mid-read as an error part rather than a short one', async () => {
    // The chunk has to be read before the failure, so it is delivered on the
    // first pull and the error raised on the second. Enqueueing and erroring in
    // the same tick would discard the chunk before anything read it.
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(Buffer.from('partial', 'utf8'));
        else controller.error(new Error('upstream went away'));
      },
    });
    const { sent, settled } = await proxy(streamingOn, new Response(body, { status: 200 }));
    await settled;

    const last = sent.at(-1)?.part;
    expect(last?.kind).toBe('error');
    expect((last as { message: string }).message).toContain('upstream went away');
    // The chunk that did make it is still delivered; only the tail is missing.
    expect(sent.filter((entry) => entry.part.kind === 'chunk')).toHaveLength(1);
  });

  it('streams an event stream whatever its size', async () => {
    const { payload, settled } = await proxy(
      { ...streamingOn, streaming: { enabled: true, thresholdBytes: 1024 * 1024 } },
      chunked(['data: tick\n\n'], { 'content-type': 'text/event-stream', 'content-length': '12' }),
    );
    await settled;
    expect(isHttpStreamHead(payload)).toBe(true);
  });

  it('streams a declared body at or above the threshold and buffers one below it', async () => {
    const big = await proxy(
      { ...streamingOn, streaming: { enabled: true, thresholdBytes: 8 } },
      chunked(['12345678'], { 'content-length': '8' }),
    );
    await big.settled;
    expect(isHttpStreamHead(big.payload)).toBe(true);

    const small = await proxy(
      { ...streamingOn, streaming: { enabled: true, thresholdBytes: 9 } },
      chunked(['12345678'], { 'content-length': '8' }),
    );
    expect(isHttpStreamHead(small.payload)).toBe(false);
    expect(decodeHttpResponse(small.payload).status).toBe(200);
    expect(small.sent).toHaveLength(0);
  });
});

describe('when a response is not streamed', () => {
  it('buffers unless the exposure turns streaming on', async () => {
    const { payload, sent } = await proxy({ target: 'http://localhost:9999' }, chunked(['hello']));

    expect(isHttpStreamHead(payload)).toBe(false);
    expect(Buffer.from(decodeHttpResponse(payload).body).toString('utf8')).toBe('hello');
    expect(sent).toHaveLength(0);
  });

  it('buffers for a caller that never offered a stream id', async () => {
    const { payload, sent } = await proxy(streamingOn, chunked(['hello']), null);

    expect(isHttpStreamHead(payload)).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('buffers rather than correcting a stream id outside the alphabet', async () => {
    // A caller that sent a bad id is not listening on whatever we would have
    // corrected it to, so the only safe reply is the one it can already read.
    const { payload, sent } = await proxy(streamingOn, chunked(['hello']), 'not/a/valid/id');

    expect(isHttpStreamHead(payload)).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('buffers a response that has no body at all', async () => {
    const { payload, sent } = await proxy(streamingOn, new Response(null, { status: 204 }));

    expect(isHttpStreamHead(payload)).toBe(false);
    expect(decodeHttpResponse(payload).status).toBe(204);
    expect(sent).toHaveLength(0);
  });
});
