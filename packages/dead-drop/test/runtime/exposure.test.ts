import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { decodeHttpResponse, encodeHttpRequest } from '#dead-drop/protocol/index.js';
import { registerExposure } from '#dead-drop/runtime/exposure.js';
import type { ExposureConfig } from '#dead-drop/runtime/config.js';
import type { Workspace } from '#dead-drop/runtime/workspace.js';
import { createLogger } from '#dead-drop/core/observability/logger.js';

type Handler = (
  payload: Uint8Array,
  context: { identity: string; from: string },
) => Promise<Uint8Array>;

/** Just enough workspace to capture the handler `registerExposure` installs. */
function stubWorkspace(): { workspace: Workspace; handler: () => Handler } {
  let installed: Handler | undefined;
  const workspace = {
    handle(_channel: string, handler: Handler) {
      installed = handler;
      return () => undefined;
    },
    registerExposure() {},
  } as unknown as Workspace;
  return {
    workspace,
    handler: () => {
      if (!installed) throw new Error('no handler was registered');
      return installed;
    },
  };
}

async function proxy(
  config: Omit<ExposureConfig, 'name' | 'type'>,
  fetchImpl: typeof fetch,
  request = { method: 'GET', path: '/', headers: {}, body: new Uint8Array(0) },
) {
  const { workspace, handler } = stubWorkspace();
  registerExposure(workspace, { name: 'web', type: 'http', ...config } as ExposureConfig, {
    logger: createLogger({ level: 'silent' }),
    fetchImpl,
  });
  const payload = await handler()(encodeHttpRequest(request), {
    identity: 'peer-b',
    from: 'peer-b',
  });
  return decodeHttpResponse(payload);
}

describe('http exposure and compressed targets', () => {
  it('does not label a decoded body with the encoding fetch already undid', async () => {
    // What Node's fetch really does: the body arrives decoded, the header stays.
    const fetchImpl = (async () =>
      new Response('<h1>hi</h1>', {
        status: 200,
        headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
      })) as unknown as typeof fetch;

    const response = await proxy({ target: 'http://localhost:3000' }, fetchImpl);

    expect(response.headers['content-encoding']).toBeUndefined();
    expect(Buffer.from(response.body).toString('utf8')).toBe('<h1>hi</h1>');
  });

  it('asks the target for identity even when the caller offered gzip', async () => {
    let seen: string | null = null;
    const fetchImpl = (async (_url: URL, init: RequestInit) => {
      seen = new Headers(init.headers).get('accept-encoding');
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    await proxy({ target: 'http://localhost:3000' }, fetchImpl, {
      method: 'GET',
      path: '/',
      headers: { 'accept-encoding': 'gzip, deflate, br' },
      body: new Uint8Array(0),
    });

    expect(seen).toBe('identity');
  });

  it('leaves content-encoding on a request body alone', async () => {
    // The request path is the reason this strip is not in `sanitiseHeaders`:
    // a client's gzipped body needs the header to survive to the target.
    let seen: string | null = null;
    const body = new Uint8Array(gzipSync(Buffer.from('{"n":1}')));
    const fetchImpl = (async (_url: URL, init: RequestInit) => {
      seen = new Headers(init.headers).get('content-encoding');
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    await proxy({ target: 'http://localhost:3000' }, fetchImpl, {
      method: 'POST',
      path: '/api',
      headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
      body,
    });

    expect(seen).toBe('gzip');
  });
});
