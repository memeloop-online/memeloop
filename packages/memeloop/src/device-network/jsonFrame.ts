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

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice();
  if (right.byteLength === 0) return left;
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

function abortedError(signal?: AbortSignal): JsonFrameError {
  return new JsonFrameError('ABORTED', 'JSON frame reading was aborted', {
    cause: signal?.reason,
  });
}

async function readNextChunk(
  iterator: AsyncIterator<Uint8Array>,
  idleDeadline: number,
  totalDeadline: number | undefined,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<Uint8Array>> {
  if (signal?.aborted) throw abortedError(signal);
  const now = Date.now();
  const deadline = totalDeadline === undefined
    ? idleDeadline
    : Math.min(idleDeadline, totalDeadline);
  if (deadline <= now) {
    throw new JsonFrameError(
      totalDeadline !== undefined && totalDeadline <= idleDeadline ? 'TOTAL_TIMEOUT' : 'IDLE_TIMEOUT',
      totalDeadline !== undefined && totalDeadline <= idleDeadline
        ? 'JSON frame total timeout expired'
        : 'JSON frame idle timeout expired',
    );
  }

  return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => {
      finish(() => {
        reject(abortedError(signal));
      });
    };
    const timer = setTimeout(() => {
      const currentTime = Date.now();
      const totalExpired = totalDeadline !== undefined && currentTime >= totalDeadline;
      finish(() => {
        reject(
          new JsonFrameError(
            totalExpired ? 'TOTAL_TIMEOUT' : 'IDLE_TIMEOUT',
            totalExpired ? 'JSON frame total timeout expired' : 'JSON frame idle timeout expired',
          ),
        );
      });
    }, Math.max(1, deadline - now));
    signal?.addEventListener('abort', onAbort, { once: true });
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
    let buffered: Uint8Array = new Uint8Array(0);
    let expectedPayloadBytes: number | undefined;
    let idleDeadline = Date.now() + options.idleTimeoutMs;
    let totalDeadline: number | undefined;
    let abortCalled = false;

    const abortOnce = async (error: JsonFrameError): Promise<void> => {
      if (abortCalled) return;
      abortCalled = true;
      await Promise.resolve(options.abort?.(error)).catch(() => undefined);
    };

    try {
      for (;;) {
        if (expectedPayloadBytes === undefined && buffered.byteLength >= HEADER_BYTES) {
          expectedPayloadBytes = new DataView(
            buffered.buffer,
            buffered.byteOffset,
            HEADER_BYTES,
          ).getUint32(0, false);
          buffered = buffered.slice(HEADER_BYTES);
          totalDeadline ??= Date.now() + options.totalTimeoutMs;
          if (expectedPayloadBytes > options.maxPayloadBytes) {
            throw new JsonFrameError(
              'FRAME_TOO_LARGE',
              `JSON frame payload exceeds ${options.maxPayloadBytes} bytes`,
            );
          }
        }

        if (
          expectedPayloadBytes !== undefined &&
          buffered.byteLength >= expectedPayloadBytes
        ) {
          const payload = buffered.slice(0, expectedPayloadBytes);
          buffered = buffered.slice(expectedPayloadBytes);
          expectedPayloadBytes = undefined;
          totalDeadline = buffered.byteLength > 0
            ? Date.now() + options.totalTimeoutMs
            : undefined;
          let text: string;
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
          } catch (error) {
            throw new JsonFrameError('INVALID_UTF8', 'JSON frame payload is not valid UTF-8', {
              cause: error,
            });
          }
          let value: unknown;
          try {
            value = JSON.parse(text) as unknown;
          } catch (error) {
            throw new JsonFrameError('INVALID_JSON', 'JSON frame payload is not valid JSON', {
              cause: error,
            });
          }
          yield value;
          idleDeadline = Date.now() + options.idleTimeoutMs;
          continue;
        }

        const result = await readNextChunk(
          iterator,
          idleDeadline,
          totalDeadline,
          options.signal,
        );
        if (result.done) {
          if (buffered.byteLength > 0 || expectedPayloadBytes !== undefined) {
            throw new JsonFrameError('TRUNCATED_FRAME', 'JSON frame stream ended mid-frame');
          }
          return;
        }
        if (!(result.value instanceof Uint8Array)) {
          throw new TypeError('JSON frame source must yield Uint8Array chunks');
        }
        if (result.value.byteLength === 0) continue;
        const now = Date.now();
        idleDeadline = now + options.idleTimeoutMs;
        totalDeadline ??= now + options.totalTimeoutMs;
        buffered = concatBytes(buffered, result.value);
      }
    } catch (error) {
      const frameError = error instanceof JsonFrameError
        ? error
        : new JsonFrameError('ABORTED', 'JSON frame source failed', { cause: error });
      await abortOnce(frameError);
      throw frameError;
    } finally {
      // An async generator can be blocked in an uncooperative await. The
      // underlying stream abort above is the cancellation boundary; waiting
      // for iterator.return() here would let that source deadlock the caller.
      void iterator.return?.().catch(() => undefined);
    }
  })();
}
