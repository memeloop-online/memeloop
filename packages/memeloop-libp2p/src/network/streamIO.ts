import type { Stream } from '@libp2p/interface';
import type { MemeLoopDuplexStream } from 'memeloop/device-network/portable';
import { createJsonFrameReader, encodeJsonFrame, encodeJsonFrames } from 'memeloop/device-network/portable';
import {
  PAIRING_IDLE_TIMEOUT_MS,
  PAIRING_MESSAGE_MAX_BYTES,
  PAIRING_TOTAL_TIMEOUT_MS,
  RPC_IDLE_TIMEOUT_MS,
  RPC_MESSAGE_MAX_BYTES,
  RPC_TOTAL_TIMEOUT_MS,
} from './protocolConstants.js';

const abortedStreams = new WeakSet<Stream>();

export function abortSignalError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('operation_aborted', { cause: signal.reason });
}

export function elapsedMilliseconds(startedAt: number): number {
  const elapsed = Date.now() - startedAt;
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
}

export function linkedTimeoutController(
  externalSignal: AbortSignal,
  timeoutMs: number,
  timeoutCode: string,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort(abortSignalError(externalSignal));
  };
  externalSignal.addEventListener('abort', onAbort, { once: true });
  if (externalSignal.aborted) onAbort();
  const timeout = setTimeout(() => {
    controller.abort(new Error(timeoutCode));
  }, timeoutMs);
  if (typeof timeout === 'object' && 'unref' in timeout) timeout.unref();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      externalSignal.removeEventListener('abort', onAbort);
    },
  };
}

export function raceWithAbortSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(abortSignalError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('operation_failed', { cause: error }));
      },
    );
  });
}

export async function abortableDelay(timeoutMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(abortSignalError(signal));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  signal.throwIfAborted();
}

export function errorWithDiagnostics(code: string, diagnostics: string[]): Error {
  return new Error(code, {
    cause: new AggregateError(
      diagnostics.map((diagnostic) => new Error(diagnostic)),
      `${code}_diagnostics`,
    ),
  });
}

export function abortLibp2pStreamOnce(stream: Stream, error: Error): void {
  if (abortedStreams.has(stream)) return;
  abortedStreams.add(stream);
  stream.abort(error);
}

export async function closeLibp2pStreamBestEffort(
  stream: Stream,
  timeoutMs: number,
  timeoutCode: string,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(timeoutCode));
  }, timeoutMs);
  if (typeof timeout === 'object' && 'unref' in timeout) timeout.unref();
  try {
    await stream.close({ signal: controller.signal });
  } catch (error) {
    abortLibp2pStreamOnce(
      stream,
      controller.signal.aborted
        ? new Error(timeoutCode)
        : error instanceof Error
        ? error
        : new Error('stream_close_failed'),
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function writeJsonMessage(
  stream: Stream,
  message: unknown,
  maxBytes: number = PAIRING_MESSAGE_MAX_BYTES,
): Promise<void> {
  stream.send(encodeJsonFrame(message, maxBytes));
}

export async function readJsonMessage<T>(
  stream: Stream,
  maxBytes: number = PAIRING_MESSAGE_MAX_BYTES,
  idleTimeoutMs: number = PAIRING_IDLE_TIMEOUT_MS,
  totalTimeoutMs: number = PAIRING_TOTAL_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<T> {
  const source = (async function*(): AsyncIterable<Uint8Array> {
    for await (const chunk of stream) {
      yield chunk instanceof Uint8Array ? chunk : chunk.subarray();
    }
  })();
  const reader = createJsonFrameReader(source, {
    maxPayloadBytes: maxBytes,
    idleTimeoutMs,
    totalTimeoutMs,
    signal,
    // Returning after the single request frame is intentional: the same
    // duplex stream remains open for the response. Protocol errors are
    // aborted explicitly in the catch below.
    abort: () => undefined,
  })[Symbol.asyncIterator]();
  try {
    const result = await reader.next();
    if (result.done) throw new Error('json_message_missing');
    return result.value as T;
  } catch (error) {
    abortLibp2pStreamOnce(
      stream,
      error instanceof Error ? error : new Error('json_message_read_failed', { cause: error }),
    );
    throw error;
  } finally {
    void reader.return?.();
  }
}

export async function writeStreamJson(
  stream: MemeLoopDuplexStream,
  message: unknown,
  maxBytes: number = RPC_MESSAGE_MAX_BYTES,
): Promise<void> {
  await stream.sink(encodeJsonFrames([message], maxBytes));
}

export async function readStreamJson(
  stream: MemeLoopDuplexStream,
  maxBytes: number = RPC_MESSAGE_MAX_BYTES,
  idleTimeoutMs: number = RPC_IDLE_TIMEOUT_MS,
  totalTimeoutMs: number = RPC_TOTAL_TIMEOUT_MS,
): Promise<unknown> {
  const reader = createJsonFrameReader(stream.source, {
    maxPayloadBytes: maxBytes,
    idleTimeoutMs,
    totalTimeoutMs,
    abort: () => undefined,
  })[Symbol.asyncIterator]();
  try {
    const result = await reader.next();
    if (result.done) throw new Error('rpc_response_missing');
    return result.value;
  } catch (error) {
    void stream.abort(
      error instanceof Error ? error : new Error('rpc_response_read_failed', { cause: error }),
    );
    throw error;
  } finally {
    void reader.return?.();
  }
}

export function wrapStream(stream: Stream, signal?: AbortSignal): MemeLoopDuplexStream {
  let removeAbortListener = (): void => {};
  const streamLifecycle = new AbortController();
  const onStreamClose = (event: Event): void => {
    if (streamLifecycle.signal.aborted) return;
    const closeEvent = event as Event & { error?: Error };
    streamLifecycle.abort(closeEvent.error ?? new Error('device_stream_closed'));
  };
  stream.addEventListener?.('close', onStreamClose, { once: true });
  const removeStreamCloseListener = (): void => {
    stream.removeEventListener?.('close', onStreamClose);
  };
  const abort = (error: Error): void => {
    removeAbortListener();
    removeStreamCloseListener();
    if (!streamLifecycle.signal.aborted) streamLifecycle.abort(error);
    abortLibp2pStreamOnce(stream, error);
  };
  if (signal) {
    const onAbort = (): void => {
      abort(abortSignalError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => {
      signal.removeEventListener('abort', onAbort);
    };
  }
  const source = streamSource(stream);
  return {
    signal: streamLifecycle.signal,
    source: (async function* abortAwareSource() {
      try {
        yield* source;
      } finally {
        removeAbortListener();
      }
    })(),
    async sink(source) {
      for await (const chunk of source) {
        stream.send(chunk);
      }
      await stream.close();
    },
    close: async () => {
      try {
        await stream.close();
      } finally {
        removeAbortListener();
        removeStreamCloseListener();
      }
    },
    abort,
  };
}

async function* streamSource(stream: Stream): AsyncIterable<Uint8Array> {
  for await (const chunk of stream) {
    if (chunk instanceof Uint8Array) {
      yield chunk;
    } else {
      yield chunk.subarray();
    }
  }
}
