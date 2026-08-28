/**
 * The consuming half of proxy mode.
 *
 * `ddrop connect my-api` starts a local HTTP server; every request it receives
 * is packed into a dead-drop request, carried by whatever transport is configured,
 * answered by the remote runtime's exposure, and unpacked back into an HTTP
 * response. A browser or curl on this machine sees an ordinary local server.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';

import {
  DeadDropError,
  HTTP_REQUEST_CONTENT_TYPE,
  decodeHttpResponse,
  decodeJson,
  encodeHttpRequest,
  isErrorPayload,
  sanitiseHeaders,
} from '../protocol/index.js';
import {
  HTTP_STREAM_OFFER_HEADER,
  createStreamId,
  decodeHttpStreamHead,
  decodeHttpStreamPart,
  httpStreamChannel,
  isHttpStreamHead,
} from '../protocol/stream.js';
import { systemClock, type Clock, type Logger } from '../core/index.js';

import { httpChannel, statusForError } from './exposure.js';
import { HttpStreamReader } from './stream-reader.js';
import type { Workspace } from './workspace.js';

export interface ConnectOptions {
  workspace: Workspace;
  /** Peer that hosts the exposure. */
  target: string;
  /** Exposure name on the remote peer. */
  exposure: string;
  /** Local port. 0 asks the OS for a free one. */
  port?: number;
  host?: string;
  logger: Logger;
  /** Per-request timeout. Default 60s: a transport hop can be slow. */
  timeoutMs?: number;
  /** Largest request body accepted from a local client. Default 32 MiB. */
  maxBodyBytes?: number;
  /**
   * Longest a streamed body may stall mid-flight before the response is failed.
   * Default 60s. This bounds a gap between parts, not the stream: an event
   * stream that keeps sending may run as long as it likes.
   */
  streamGapTimeoutMs?: number;
  clock?: Clock;
}

export interface ConnectHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
const DEFAULT_STREAM_GAP_TIMEOUT_MS = 60_000;

export async function connect(options: ConnectOptions): Promise<ConnectHandle> {
  const logger = options.logger.child({ connect: options.exposure, target: options.target });
  const channel = httpChannel(options.exposure);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const gapTimeoutMs = options.streamGapTimeoutMs ?? DEFAULT_STREAM_GAP_TIMEOUT_MS;
  const clock = options.clock ?? systemClock;

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      logger.error('failed to answer a local request', { error: String(error) });
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('dead-drop failed to answer this request.');
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request, maxBodyBytes);
    if (body === undefined) {
      response.writeHead(413, { 'content-type': 'text/plain' });
      response.end('Request body is too large.');
      return;
    }

    // We mint the stream id and offer it, rather than letting the exposure name
    // one in its head. Body parts are sent the moment the head is handed back
    // and nothing orders the two, so an id we learned from the head would let a
    // part arrive for a stream we were not yet listening to. Offering it also
    // means an exposure can tell we understand streams at all.
    const streamId = createStreamId();
    const payload = encodeHttpRequest({
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      headers: {
        ...sanitiseHeaders(request.headers as Record<string, string | string[] | undefined>),
        [HTTP_STREAM_OFFER_HEADER]: streamId,
      },
      body,
    });

    // Subscribed before the request goes out, for the same reason.
    const stream = receiveStream({
      workspace: options.workspace,
      streamId,
      response,
      clock,
      gapTimeoutMs,
      logger,
    });

    try {
      const envelope = await options.workspace.request(options.target, channel, payload, {
        timeoutMs,
        contentType: HTTP_REQUEST_CONTENT_TYPE,
      });
      const reply = unwrapRemoteError(envelope.payload);

      if (isHttpStreamHead(reply)) {
        const head = decodeHttpStreamHead(reply);
        response.writeHead(head.status, head.statusText, head.headers);
        // `flushHeaders` matters for an event stream: without it the browser
        // sees nothing until the first chunk is large enough to flush itself.
        response.flushHeaders();
        await stream.finished;
        return;
      }

      stream.cancel();
      const remote = decodeHttpResponse(reply);
      response.writeHead(remote.status, remote.statusText, remote.headers);
      response.end(Buffer.from(remote.body));
    } catch (error) {
      stream.cancel();
      const deadDropError = DeadDropError.from(error);
      logger.warn('remote request failed', {
        method: request.method,
        path: request.url,
        code: deadDropError.code,
        error: deadDropError.message,
      });
      // A stream that failed part-way has already sent its status and some of
      // its body, so there is no status left to send. Destroying the socket is
      // the only signal left that the body is truncated; ending it cleanly
      // would tell the client it received everything.
      if (response.headersSent) {
        response.destroy();
        return;
      }
      // Surfacing the dead-drop error code as an HTTP status keeps the failure
      // legible to a browser without leaking transport detail into the body.
      response.writeHead(statusForError(deadDropError), { 'content-type': 'text/plain' });
      response.end(
        `dead-drop could not reach ${options.target}/${options.exposure}: ${deadDropError.code}`,
      );
    }
  }

  const host = options.host ?? '127.0.0.1';
  server.listen(options.port ?? 0, host);
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);
  const url = `http://${host}:${port}`;
  logger.info('local endpoint ready', { url });

  return {
    url,
    port,
    close: () => closeServer(server),
  };
}

interface StreamSession {
  /** Resolves when the body has been written whole; rejects if the stream fails. */
  finished: Promise<void>;
  /** Tears down a subscription for a reply that turned out not to be a stream. */
  cancel(): void;
}

/**
 * Listens for the parts of one streamed body and writes them to the client.
 *
 * Ordering is the reader's job, not the transport's: parts are accepted in
 * whatever order they arrive and released as each gap closes. Everything here
 * is about ending: a stream can finish, fail, stall, or lose the client it was
 * being written to, and all four have to release the subscription and the timer.
 */
function receiveStream(options: {
  workspace: Workspace;
  streamId: string;
  response: ServerResponse;
  clock: Clock;
  gapTimeoutMs: number;
  logger: Logger;
}): StreamSession {
  const { workspace, streamId, response, clock, gapTimeoutMs, logger } = options;
  const reader = new HttpStreamReader(clock.now(), { gapTimeoutMs });

  let settle: { resolve: () => void; reject: (error: unknown) => void } | undefined;
  const finished = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Nothing awaits `finished` unless the reply turns out to be a stream head,
  // and an unobserved rejection would take the process down.
  finished.catch(() => undefined);

  let closed = false;
  // Collected rather than held in named bindings, so that everything acquired
  // is released by one path however the stream ends.
  const teardown: Array<() => void> = [];

  const stop = (): void => {
    if (closed) return;
    closed = true;
    for (const release of teardown.splice(0)) release();
    reader.discard();
  };

  const fail = (error: unknown): void => {
    stop();
    settle?.reject(error);
  };

  teardown.push(
    workspace.subscribe(httpStreamChannel(streamId), (payload) => {
      if (closed) return;
      try {
        const { ready, done } = reader.accept(decodeHttpStreamPart(payload), clock.now());
        for (const chunk of ready) response.write(Buffer.from(chunk));
        if (done) {
          stop();
          response.end();
          settle?.resolve();
        }
      } catch (error) {
        logger.warn('streamed response failed', { streamId, error: String(error) });
        fail(error);
      }
    }),
  );

  // A sender that stops sending would otherwise hold this response open for
  // ever. The reader is driven rather than owning a timer, so the tick is here.
  teardown.push(
    clock.setInterval(Math.max(1, Math.floor(gapTimeoutMs / 4)), () => {
      if (closed) return;
      try {
        reader.checkTimeout(clock.now());
      } catch (error) {
        logger.warn('streamed response stalled', { streamId, error: String(error) });
        fail(error);
      }
    }),
  );

  // The client hanging up is the ordinary end of an event stream. It is not a
  // failure, and it must not leave the subscription behind.
  response.on('close', () => {
    if (closed) return;
    stop();
    settle?.resolve();
  });

  return { finished, cancel: stop };
}

/**
 * Raises the remote failure a `response` envelope describes, if that is what it
 * carries, and otherwise hands the payload back untouched.
 *
 * A workspace answers a request it cannot serve with a JSON error document
 * rather than an encoded HTTP response: no handler for the channel, or a
 * handler that threw. Feeding that to `decodeHttpResponse` reads the first four
 * bytes of `{"error"` as a length prefix, so asking for an exposure that does
 * not exist used to fail with `DECODE_FAILED`, HTTP 500 and the message "http
 * message head length out of range" — blaming the framing for what is really a
 * missing exposure. `Workspace.call` already unwraps these on the RPC path;
 * proxy mode is the half that did not.
 */
function unwrapRemoteError(payload: Uint8Array): Uint8Array {
  // Only a JSON document can be an error document, and a real encoded response
  // never starts with `{`, so this costs nothing on the success path.
  if (payload[0] !== 0x7b) return payload;
  let decoded: unknown;
  try {
    decoded = decodeJson(payload);
  } catch {
    return payload;
  }
  if (isErrorPayload(decoded)) throw DeadDropError.fromJSON(decoded.error);
  return payload;
}

async function readBody(request: IncomingMessage, limit: number): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).length;
    if (total > limit) {
      request.destroy();
      return undefined;
    }
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    // Idle keep-alive sockets would otherwise hold the process open.
    server.closeIdleConnections?.();
  });
}
