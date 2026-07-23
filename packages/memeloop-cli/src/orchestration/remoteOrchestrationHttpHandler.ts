import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { type AgentOrchestrationClient, createRemoteOrchestrationHandler, type RemoteOrchestrationRequest } from 'memeloop';

export interface RemoteOrchestrationHttpHandlerOptions {
  /** Exact mounted path. Defaults to `/v1/orchestration/resources`. */
  path?: string;
  /** Hard request-body limit. Defaults to 1 MiB. */
  maxRequestBytes?: number;
  /**
   * Host authentication/admission hook. Mandatory: a TCP client must never
   * choose its ControlStore actor merely by reaching this endpoint.
   */
  authorize(request: IncomingMessage): boolean | Promise<boolean>;
  onError?: (error: unknown) => void;
}

export type RemoteOrchestrationHttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>;

function reply(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string'
      ? Buffer.from(chunk, 'utf8')
      : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > limit) {
      throw new RangeError(`request exceeds ${limit} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Node/Electron-main HTTP adapter for the portable remote ResourceClient.
 * It owns no server/socket and can be mounted into an existing trusted host.
 */
export function createRemoteOrchestrationHttpHandler(
  client: AgentOrchestrationClient,
  options: RemoteOrchestrationHttpHandlerOptions,
): RemoteOrchestrationHttpHandler {
  const mountedPath = options.path ?? '/v1/orchestration/resources';
  const maxRequestBytes = options.maxRequestBytes ?? 1024 * 1024;
  const handler = createRemoteOrchestrationHandler(client);

  return async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://memeloop.invalid');
      if (request.method !== 'POST' || url.pathname !== mountedPath) {
        reply(response, 404, { error: 'not found' });
        return;
      }
      if (!await options.authorize(request)) {
        reply(response, 403, { error: 'forbidden' });
        return;
      }
      const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim();
      if (contentType !== 'application/json') {
        reply(response, 415, { error: 'content-type must be application/json' });
        return;
      }
      let envelope: RemoteOrchestrationRequest;
      try {
        envelope = JSON.parse(await readBody(request, maxRequestBytes)) as RemoteOrchestrationRequest;
      } catch (error) {
        reply(
          response,
          error instanceof RangeError ? 413 : 400,
          { error: error instanceof RangeError ? error.message : 'invalid JSON request' },
        );
        return;
      }

      if (envelope.operation !== 'watch') {
        const result = await handler.request(envelope);
        reply(response, 200, result);
        return;
      }

      const abort = new AbortController();
      request.once('aborted', () => {
        abort.abort();
      });
      response.once('close', () => {
        if (!response.writableEnded) abort.abort();
      });
      response.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      });
      for await (const event of handler.watch(envelope, { signal: abort.signal })) {
        if (!response.write(`${JSON.stringify(event)}\n`)) {
          await once(response, 'drain');
        }
      }
      response.end();
    } catch (error) {
      options.onError?.(error);
      if (!response.destroyed) {
        reply(response, 500, { error: 'remote orchestration handler failed' });
      }
    }
  };
}
