export type JsonFrameErrorCode =
  | 'FRAME_TOO_LARGE'
  | 'TRUNCATED_FRAME'
  | 'INVALID_UTF8'
  | 'INVALID_JSON'
  | 'IDLE_TIMEOUT'
  | 'TOTAL_TIMEOUT'
  | 'ABORTED';

export class JsonFrameError extends Error {
  public readonly code: JsonFrameErrorCode;

  constructor(code: JsonFrameErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'JsonFrameError';
    this.code = code;
  }
}

export interface JsonFrameReaderOptions {
  maxPayloadBytes: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  signal?: AbortSignal;
  abort?: (error: JsonFrameError) => void | Promise<void>;
  /** Receives failures thrown by the abort notification hook. */
  onAbortError?: (error: unknown, frameError: JsonFrameError) => void;
  /** Receives failures thrown while closing the source iterator. */
  onCleanupError?: (error: unknown) => void;
}

const HEADER_BYTES = 4;
const MAX_UINT32 = 0xffff_ffff;

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function validateMaxPayloadBytes(maxPayloadBytes: number): void {
  assertPositiveInteger(maxPayloadBytes, 'maxPayloadBytes');
  if (maxPayloadBytes > MAX_UINT32) {
    throw new TypeError('maxPayloadBytes must fit in an unsigned 32-bit frame length');
  }
}

export function encodeJsonFrame(value: unknown, maxPayloadBytes = MAX_UINT32): Uint8Array {
  validateMaxPayloadBytes(maxPayloadBytes);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new JsonFrameError('INVALID_JSON', 'JSON frame value cannot be serialized', {
      cause: error,
    });
  }
  if (serialized === undefined) {
    throw new JsonFrameError('INVALID_JSON', 'JSON frame value cannot be serialized');
  }
  const payload = new TextEncoder().encode(serialized);
  if (payload.byteLength > maxPayloadBytes) {
    throw new JsonFrameError(
      'FRAME_TOO_LARGE',
      `JSON frame payload exceeds ${maxPayloadBytes} bytes`,
    );
  }
  const frame = new Uint8Array(HEADER_BYTES + payload.byteLength);
  new DataView(frame.buffer, frame.byteOffset, HEADER_BYTES).setUint32(0, payload.byteLength, false);
  frame.set(payload, HEADER_BYTES);
  return frame;
}

export async function* encodeJsonFrames(
  values: AsyncIterable<unknown> | Iterable<unknown>,
  maxPayloadBytes = MAX_UINT32,
): AsyncIterable<Uint8Array> {
  for await (const value of values) {
    yield encodeJsonFrame(value, maxPayloadBytes);
  }
}

function abortedError(signal?: AbortSignal): JsonFrameError {
  return new JsonFrameError('ABORTED', 'JSON frame reading was aborted', {
    cause: signal?.reason,
  });
}

interface JsonFrameDeadline {
  at: number;
  code: 'IDLE_TIMEOUT' | 'TOTAL_TIMEOUT';
  message: string;
}

/**
 * Select the deadline that governs one iterator pull. The selection remains
 * stable for the lifetime of that pull: a delayed timer must report the first
 * deadline that was crossed, rather than whichever deadlines happen to be
 * expired when its callback runs. Total timeout wins an exact tie so a frame
 * whose idle and total budgets end together is classified deterministically.
 */
function selectReadDeadline(
  idleDeadline: number,
  totalDeadline: number | undefined,
): JsonFrameDeadline {
  if (totalDeadline !== undefined && totalDeadline <= idleDeadline) {
    return {
      at: totalDeadline,
      code: 'TOTAL_TIMEOUT',
      message: 'JSON frame total timeout expired',
    };
  }
  return {
    at: idleDeadline,
    code: 'IDLE_TIMEOUT',
    message: 'JSON frame idle timeout expired',
  };
}

async function readNextChunk(
  iterator: AsyncIterator<Uint8Array>,
  idleDeadline: number,
  totalDeadline: number | undefined,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<Uint8Array>> {
  if (signal?.aborted) throw abortedError(signal);
  const now = Date.now();
  const deadline = selectReadDeadline(idleDeadline, totalDeadline);
  if (deadline.at <= now) {
    throw new JsonFrameError(deadline.code, deadline.message);
  }

  return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => {
      finish(() => {
        reject(abortedError(signal));
      });
    };

    const onTimeout = () => {
      if (settled) return;
      const remainingMs = deadline.at - Date.now();
      if (remainingMs > 0) {
        // Node and browser timers may fire slightly early (and fractional
        // delays are truncated). Never turn that scheduler detail into a
        // timeout classification bug: wait until the selected absolute
        // deadline has actually elapsed.
        timer = setTimeout(onTimeout, Math.max(1, remainingMs));
        return;
      }
      finish(() => {
        reject(new JsonFrameError(deadline.code, deadline.message));
      });
    };

    timer = setTimeout(onTimeout, Math.max(1, deadline.at - now));
    signal?.addEventListener('abort', onAbort, { once: true });
    // Cover an abort racing between the entry check and listener attachment.
    if (signal?.aborted) {
      onAbort();
      return;
    }
    void iterator.next().then(
      (result) => {
        finish(() => {
          resolve(result);
        });
      },
      (error: unknown) => {
        finish(() => {
          reject(
            error instanceof Error ? error : new Error('JSON frame source failed', {
              cause: error,
            }),
          );
        });
      },
    );
  });
}

/**
 * Decode uint32be-length-prefixed, strict UTF-8 JSON frames from an arbitrary
 * chunked byte stream. Buffered remainder is retained so one chunk may contain
 * any number of complete or partial frames.
 */
export function createJsonFrameReader(
  source: AsyncIterable<Uint8Array>,
  options: JsonFrameReaderOptions,
): AsyncIterable<unknown> {
  validateMaxPayloadBytes(options.maxPayloadBytes);
  assertPositiveInteger(options.idleTimeoutMs, 'idleTimeoutMs');
  assertPositiveInteger(options.totalTimeoutMs, 'totalTimeoutMs');

  return (async function* readFrames(): AsyncIterable<unknown> {
    const iterator = source[Symbol.asyncIterator]();
    const header = new Uint8Array(HEADER_BYTES);
    let headerBytes = 0;
    let payload: Uint8Array | undefined;
    let payloadBytes = 0;
    let expectedPayloadBytes: number | undefined;
    let idleDeadline = Date.now() + options.idleTimeoutMs;
    let totalDeadline: number | undefined;
    let abortCalled = false;
    let completed = false;

    const abortOnce = (error: JsonFrameError): void => {
      if (abortCalled) return;
      abortCalled = true;
      const reportAbortHookError = (hookError: unknown): void => {
        try {
          options.onAbortError?.(hookError, error);
        } catch (diagnosticError) {
          // A diagnostic sink is secondary to preserving the framing error.
          void diagnosticError;
        }
      };
      try {
        // Aborting is a notification/cancellation boundary, not part of error
        // delivery. A defective host abort implementation must never prevent
        // the framing error from reaching the caller.
        const result = options.abort?.(error);
        if (result !== undefined) {
          void Promise.resolve(result).catch((hookError: unknown) => {
            reportAbortHookError(hookError);
          });
        }
      } catch (hookError) {
        reportAbortHookError(hookError);
      }
    };

    const decodePayload = (bytes: Uint8Array): unknown => {
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch (error) {
        throw new JsonFrameError('INVALID_UTF8', 'JSON frame payload is not valid UTF-8', {
          cause: error,
        });
      }
      try {
        return JSON.parse(text) as unknown;
      } catch (error) {
        throw new JsonFrameError('INVALID_JSON', 'JSON frame payload is not valid JSON', {
          cause: error,
        });
      }
    };

    const onExternalAbort = (): void => {
      abortOnce(abortedError(options.signal));
    };
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (options.signal?.aborted) onExternalAbort();

    try {
      for (;;) {
        const result = await readNextChunk(
          iterator,
          idleDeadline,
          totalDeadline,
          options.signal,
        );
        if (result.done) {
          if (headerBytes > 0 || expectedPayloadBytes !== undefined) {
            throw new JsonFrameError('TRUNCATED_FRAME', 'JSON frame stream ended mid-frame');
          }
          completed = true;
          return;
        }
        if (!(result.value instanceof Uint8Array)) {
          throw new TypeError('JSON frame source must yield Uint8Array chunks');
        }
        if (result.value.byteLength === 0) continue;
        const now = Date.now();
        idleDeadline = now + options.idleTimeoutMs;
        totalDeadline ??= now + options.totalTimeoutMs;

        // Retain at most the current source chunk and copy every frame byte
        // exactly once into the fixed header or exact-size payload allocation.
        // The source is not pulled again until this chunk is fully consumed,
        // so producers may safely reuse their buffer on the next pull while
        // byte-at-a-time input remains O(n).
        let chunkOffset = 0;
        while (chunkOffset < result.value.byteLength) {
          if (expectedPayloadBytes === undefined) {
            const headerRemaining = HEADER_BYTES - headerBytes;
            const copied = Math.min(headerRemaining, result.value.byteLength - chunkOffset);
            header.set(result.value.subarray(chunkOffset, chunkOffset + copied), headerBytes);
            headerBytes += copied;
            chunkOffset += copied;
            if (headerBytes < HEADER_BYTES) continue;

            expectedPayloadBytes = new DataView(
              header.buffer,
              header.byteOffset,
              HEADER_BYTES,
            ).getUint32(0, false);
            if (expectedPayloadBytes > options.maxPayloadBytes) {
              throw new JsonFrameError(
                'FRAME_TOO_LARGE',
                `JSON frame payload exceeds ${options.maxPayloadBytes} bytes`,
              );
            }
            payload = new Uint8Array(expectedPayloadBytes);
            payloadBytes = 0;
          }

          const payloadRemaining = expectedPayloadBytes - payloadBytes;
          const copied = Math.min(payloadRemaining, result.value.byteLength - chunkOffset);
          if (copied > 0) {
            payload!.set(result.value.subarray(chunkOffset, chunkOffset + copied), payloadBytes);
            payloadBytes += copied;
            chunkOffset += copied;
          }
          if (payloadBytes < expectedPayloadBytes) continue;

          const value = decodePayload(payload!);
          headerBytes = 0;
          payload = undefined;
          payloadBytes = 0;
          expectedPayloadBytes = undefined;
          const hasRemainingChunkBytes = chunkOffset < result.value.byteLength;
          totalDeadline = undefined;
          yield value;
          if (options.signal?.aborted) throw abortedError(options.signal);
          // Consumer backpressure is neither source idleness nor time spent
          // receiving the next frame. Start both clocks only after the
          // consumer resumes and before processing coalesced remainder bytes.
          const resumedAt = Date.now();
          idleDeadline = resumedAt + options.idleTimeoutMs;
          if (hasRemainingChunkBytes) {
            totalDeadline = resumedAt + options.totalTimeoutMs;
          }
        }
      }
    } catch (error) {
      const frameError = error instanceof JsonFrameError
        ? error
        : new JsonFrameError('ABORTED', 'JSON frame source failed', { cause: error });
      abortOnce(frameError);
      throw frameError;
    } finally {
      options.signal?.removeEventListener('abort', onExternalAbort);
      if (!completed) abortOnce(abortedError(options.signal));
      // An async generator can be blocked in an uncooperative await. The
      // underlying stream abort above is the cancellation boundary; waiting
      // for iterator.return() here would let that source deadlock the caller.
      try {
        const returned = iterator.return?.();
        if (returned !== undefined) {
          void Promise.resolve(returned).catch((cleanupError: unknown) => {
            try {
              options.onCleanupError?.(cleanupError);
            } catch (diagnosticError) {
              void diagnosticError;
            }
          });
        }
      } catch (cleanupError) {
        try {
          options.onCleanupError?.(cleanupError);
        } catch (diagnosticError) {
          void diagnosticError;
        }
      }
    }
  })();
}
