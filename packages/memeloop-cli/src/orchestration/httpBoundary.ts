import type { IncomingMessage, ServerResponse } from 'node:http';

/** Common JSON response headers for the trusted Node HTTP adapters. */
export function replyJson(response: ServerResponse, status: number, body: unknown): void {
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

/** Read a request body without ever buffering beyond the configured limit. */
export async function readBoundedBody(
  request: IncomingMessage,
  limit: number,
  errorPrefix = 'request exceeds',
): Promise<string> {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('invalid request body limit');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string'
      ? Buffer.from(chunk, 'utf8')
      : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > limit) throw new RangeError(`${errorPrefix} ${limit} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface HttpAbortLifecycle {
  signal: AbortSignal;
  dispose(): void;
}

/**
 * Bind request/response lifecycle events to one idempotent AbortController.
 * The listeners are removed after the operation so a completed request cannot
 * abort a later operation that happens to reuse the same response object.
 */
export function bindHttpAbortLifecycle(
  request: IncomingMessage,
  response: ServerResponse,
  reasonPrefix: string,
): HttpAbortLifecycle {
  const controller = new AbortController();
  const abort = (reason: Error) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onRequestAbort = () => {
    abort(new Error(`${reasonPrefix} request aborted`));
  };
  const onResponseClose = () => {
    if (!response.writableEnded) abort(new Error(`${reasonPrefix} response closed`));
  };
  request.once('aborted', onRequestAbort);
  response.once('close', onResponseClose);
  return {
    signal: controller.signal,
    dispose: () => {
      request.removeListener('aborted', onRequestAbort);
      response.removeListener('close', onResponseClose);
    },
  };
}
