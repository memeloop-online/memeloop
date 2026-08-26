export type BoundedResponseTextErrorCode =
  | 'response_invalid_utf8'
  | 'response_too_large'
  | 'response_timeout';

/** Stable, content-free failure raised before an HTTP body can exhaust memory. */
export class BoundedResponseTextError extends Error {
  constructor(public readonly code: BoundedResponseTextErrorCode) {
    super(code);
    this.name = 'BoundedResponseTextError';
  }
}

export interface FetchBoundedTextOptions {
  maximumBytes: number;
  timeoutMs: number;
}

export interface BoundedTextResponse {
  response: Response;
  text: string;
}

/** Fetch and decode one strict UTF-8 response without ever buffering beyond the byte cap. */
export async function fetchBoundedText(
  input: string | URL,
  init: RequestInit,
  options: FetchBoundedTextOptions,
): Promise<BoundedTextResponse> {
  assertPositiveBound(options.maximumBytes, 'maximumBytes');
  assertPositiveBound(options.timeoutMs, 'timeoutMs');
  const controller = new AbortController();
  const parentSignal = init.signal ?? undefined;
  const abortFromParent = (): void => {
    if (!controller.signal.aborted) controller.abort(parentSignal?.reason);
  };
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new BoundedResponseTextError('response_timeout'));
    }
  }, options.timeoutMs);
  try {
    throwIfAborted(controller.signal);
    const response = await fetch(input, { ...init, signal: controller.signal });
    const text = await readBoundedResponseText(
      response,
      options.maximumBytes,
      controller.signal,
    );
    return { response, text };
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}

/** Decode a response stream incrementally with strict UTF-8 and exact byte accounting. */
export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  assertPositiveBound(maximumBytes, 'maximumBytes');
  if (signal?.aborted) {
    await cancelBody(response.body, 'response_aborted');
    throwIfAborted(signal);
  }
  const declaredLengthText = response.headers.get('content-length');
  if (declaredLengthText && /^\d+$/u.test(declaredLengthText)) {
    const declaredLength = Number(declaredLengthText);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maximumBytes) {
      await cancelBody(response.body, 'response_too_large');
      throw new BoundedResponseTextError('response_too_large');
    }
  }
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let totalBytes = 0;
  let result = '';
  let cancelled = false;
  const cancelReader = async (reason: string): Promise<void> => {
    if (cancelled) return;
    cancelled = true;
    try {
      await reader.cancel(reason);
    } catch {
      // The primary bounded-read outcome remains authoritative.
    }
  };
  const abortReader = (): void => {
    void cancelReader('response_aborted');
  };
  signal?.addEventListener('abort', abortReader, { once: true });
  try {
    for (;;) {
      throwIfAborted(signal);
      const chunk = await reader.read();
      throwIfAborted(signal);
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maximumBytes) {
        await cancelReader('response_too_large');
        throw new BoundedResponseTextError('response_too_large');
      }
      try {
        result += decoder.decode(chunk.value, { stream: true });
      } catch {
        await cancelReader('response_invalid_utf8');
        throw new BoundedResponseTextError('response_invalid_utf8');
      }
    }
    try {
      result += decoder.decode();
    } catch {
      throw new BoundedResponseTextError('response_invalid_utf8');
    }
    return result;
  } finally {
    signal?.removeEventListener('abort', abortReader);
    reader.releaseLock();
  }
}

function assertPositiveBound(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000_000) {
    throw new RangeError(`invalid_${field}`);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('Operation aborted', 'AbortError');
}

async function cancelBody(body: ReadableStream<Uint8Array> | null, reason: string): Promise<void> {
  if (!body) return;
  try {
    await body.cancel(reason);
  } catch {
    // Size validation is authoritative even when a body cannot be cancelled.
  }
}
