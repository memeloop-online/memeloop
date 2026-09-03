import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { type AgentOrchestrationClient, createRemoteOrchestrationHandler, REMOTE_ORCHESTRATION_DEADLINE_HEADER, type RemoteOrchestrationRequest } from 'memeloop';

import { bindHttpAbortLifecycle, readBoundedBody, replyJson } from './httpBoundary.js';

export interface RemoteOrchestrationHttpHandlerOptions {
  /** Exact mounted path. Defaults to `/v2/orchestration/resources`. */
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

/**
 * Node/Electron-main HTTP adapter for the portable remote ResourceClient.
 * It owns no server/socket and can be mounted into an existing trusted host.
 */
export function createRemoteOrchestrationHttpHandler(
  client: AgentOrchestrationClient,
  options: RemoteOrchestrationHttpHandlerOptions,
): RemoteOrchestrationHttpHandler {
  const mountedPath = options.path ?? '/v2/orchestration/resources';
  const maxRequestBytes = options.maxRequestBytes ?? 1024 * 1024;
  const handler = createRemoteOrchestrationHandler(client);

  return async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://memeloop.invalid');
      if (request.method !== 'POST' || url.pathname !== mountedPath) {
        replyJson(response, 404, { error: 'not found' });
        return;
      }
      if (!await options.authorize(request)) {
        replyJson(response, 403, { error: 'forbidden' });
        return;
      }
      const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim();
      if (contentType !== 'application/json') {
        replyJson(response, 415, { error: 'content-type must be application/json' });
        return;
      }
      let envelope: RemoteOrchestrationRequest;
      try {
        envelope = JSON.parse(await readBoundedBody(request, maxRequestBytes)) as RemoteOrchestrationRequest;
      } catch (error) {
        replyJson(
          response,
          error instanceof RangeError ? 413 : 400,
          { error: error instanceof RangeError ? error.message : 'invalid JSON request' },
        );
        return;
      }

      const lifecycle = bindHttpAbortLifecycle(request, response, 'remote orchestration HTTP');
      try {
        const deadlineHeader = request.headers[REMOTE_ORCHESTRATION_DEADLINE_HEADER.toLowerCase()];
        const deadline = Array.isArray(deadlineHeader) ? deadlineHeader[0] : deadlineHeader;

        if (envelope.operation !== 'watch') {
          const result = await handler.request(envelope, {
            signal: lifecycle.signal,
            ...(deadline ? { deadline } : {}),
          });
          if (!lifecycle.signal.aborted) replyJson(response, 200, result);
          return;
        }

        response.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
          'X-Content-Type-Options': 'nosniff',
        });
        for await (const event of handler.watch(envelope, { signal: lifecycle.signal })) {
          if (!response.write(`${JSON.stringify(event)}\n`)) {
            await once(response, 'drain');
          }
        }
        response.end();
      } finally {
        lifecycle.dispose();
      }
    } catch (error) {
      options.onError?.(error);
      if (!response.destroyed) {
        replyJson(response, 500, { error: 'remote orchestration handler failed' });
      }
    }
  };
}
