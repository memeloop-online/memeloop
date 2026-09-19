import type { PortableLlmRequest } from '../../llm/request.js';
import { assertPortableLlmStreamPart, type PortableLlmStreamPart } from '../../llm/response.js';
import type { ILLMProvider } from '../../types.js';

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === 'object' &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function';
}

export interface StreamLlmOptions {
  /** Receives failures raised while closing a provider stream. */
  onCleanupError?: (error: unknown) => void;
}

export function chunkToText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (
    chunk != null && typeof chunk === 'object' &&
    (chunk as { type?: unknown }).type === 'text-delta'
  ) {
    const text = (chunk as { text?: unknown }).text;
    if (typeof text !== 'string') throw new TypeError('text-delta chunk must contain text');
    return text;
  }
  if (chunk != null && typeof chunk === 'object' && 'content' in chunk) {
    const content = (chunk as { content?: unknown }).content;
    if (typeof content === 'string') return content;
    const serialized = JSON.stringify(content);
    if (serialized === undefined) throw new TypeError('chunk content is not JSON-serializable');
    return serialized;
  }
  const serialized = JSON.stringify(chunk);
  if (serialized === undefined) throw new TypeError('chunk is not JSON-serializable');
  return serialized;
}

export async function* streamLlm(
  provider: ILLMProvider,
  request: PortableLlmRequest,
  options: StreamLlmOptions = {},
): AsyncGenerator<PortableLlmStreamPart, void, unknown> {
  const signal = request.signal;
  signal?.throwIfAborted();
  const raw = provider.chat(request);
  const resolved = raw != null && typeof (raw as Promise<unknown>).then === 'function'
    ? await waitForAbortable(raw as Promise<unknown>, signal)
    : raw;
  signal?.throwIfAborted();
  if (isAsyncIterable(resolved)) {
    const iterator = resolved[Symbol.asyncIterator]();
    let completed = false;
    let returned = false;
    const returnIterator = (): void => {
      if (returned) return;
      returned = true;
      const reportCleanupError = (error: unknown): void => {
        try {
          options.onCleanupError?.(error);
        } catch (diagnosticError) {
          void diagnosticError;
        }
      };
      try {
        const close = iterator.return?.();
        if (close !== undefined) {
          // Provider cleanup is best-effort. A non-cooperative iterator may
          // never settle its return promise, and a broken one may reject it;
          // neither is allowed to delay request cancellation or surface an
          // unhandled rejection after the caller has already moved on.
          void Promise.resolve(close).catch((error: unknown) => {
            reportCleanupError(error);
          });
        }
      } catch (error) {
        reportCleanupError(error);
      }
    };
    try {
      while (true) {
        signal?.throwIfAborted();
        const next = await waitForAbortable(iterator.next(), signal);
        if (next.done) {
          completed = true;
          break;
        }
        signal?.throwIfAborted();
        assertPortableLlmStreamPart(next.value);
        yield next.value;
      }
    } finally {
      // A pending provider iterator is an owned resource. Abort and consumer
      // cancellation both close it; normal exhaustion has already released it.
      if (!completed) returnIterator();
    }
    signal?.throwIfAborted();
    return;
  }
  signal?.throwIfAborted();
  assertPortableLlmStreamPart(resolved);
  yield resolved;
}

function waitForAbortable<T>(operation: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(operation);
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(toError(signal.reason, 'Operation aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(toError(error, 'LLM provider operation failed'));
      },
    );
  });
}

function toError(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) return value;
  return value === undefined
    ? new DOMException(fallbackMessage, 'AbortError')
    : new Error(fallbackMessage, { cause: value });
}
