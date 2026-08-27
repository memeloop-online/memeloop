import { OrchestrationError } from '../orchestration/errors.js';
import type { RemoteOrchestrationRequest, RemoteOrchestrationResponse, RemoteOrchestrationTransport, RemoteOrchestrationTransportOptions } from '../orchestration/remoteClient.js';
import { createJsonFrameReader, encodeJsonFrames, JsonFrameError } from './jsonFrame.js';
import type { DeviceConnectionGrant, DeviceNetworkService, MemeLoopDuplexStream } from './types.js';

export const DEVICE_ORCHESTRATION_PROTOCOL = '/memeloop/orchestration/2.0.0' as const;
export const DEVICE_ORCHESTRATION_FRAME_LIMITS = Object.freeze({
  maxPayloadBytes: 1024 * 1024,
  requestIdleTimeoutMs: 10_000,
  requestTotalTimeoutMs: 30_000,
  watchIdleTimeoutMs: 90_000,
  watchBookmarkIntervalMs: 30_000,
});
const DEFAULT_MAX_FRAME_BYTES = DEVICE_ORCHESTRATION_FRAME_LIMITS.maxPayloadBytes;
const REQUEST_IDLE_TIMEOUT_MS = DEVICE_ORCHESTRATION_FRAME_LIMITS.requestIdleTimeoutMs;
const REQUEST_TOTAL_TIMEOUT_MS = DEVICE_ORCHESTRATION_FRAME_LIMITS.requestTotalTimeoutMs;
const WATCH_IDLE_TIMEOUT_MS = DEVICE_ORCHESTRATION_FRAME_LIMITS.watchIdleTimeoutMs;
const WATCH_BOOKMARK_INTERVAL_MS = DEVICE_ORCHESTRATION_FRAME_LIMITS.watchBookmarkIntervalMs;

export interface DeviceOrchestrationTransportOptions {
  deviceNetwork: Pick<DeviceNetworkService, 'openStream'>;
  peerId: string;
  grantProvider?: (
    peerId: string,
    signal?: AbortSignal,
  ) => DeviceConnectionGrant | undefined | Promise<DeviceConnectionGrant | undefined>;
  maxFrameBytes?: number;
}

export interface DeviceOrchestrationStreamHandlerInput {
  remotePeerId: string;
  stream: MemeLoopDuplexStream;
  authorize?: (presentedGrant: DeviceConnectionGrant | undefined) => boolean | Promise<boolean>;
}

export type RemoteOrchestrationHandler = {
  request(
    request: RemoteOrchestrationRequest,
    options?: RemoteOrchestrationTransportOptions,
  ): Promise<RemoteOrchestrationResponse>;
  watch(
    request: RemoteOrchestrationRequest,
    options?: RemoteOrchestrationTransportOptions,
  ): AsyncIterable<RemoteOrchestrationResponse>;
};

export interface DeviceOrchestrationStreamHandlerOptions {
  resolveHandler: (
    remotePeerId: string,
  ) => RemoteOrchestrationHandler | Promise<RemoteOrchestrationHandler>;
  maxFrameBytes?: number;
}

export type DeviceOrchestrationStreamHandler = (
  input: DeviceOrchestrationStreamHandlerInput,
) => Promise<void>;

interface DeviceOrchestrationRequestEnvelope {
  type: 'memeloop-device-orchestration-request-v2';
  request: RemoteOrchestrationRequest;
  deadline?: string;
  grant?: DeviceConnectionGrant;
}

function orchestrationTransportError(
  code: 'CANCELLED' | 'EXHAUSTED' | 'INVALID' | 'UNAVAILABLE',
  message: string,
): OrchestrationError {
  return new OrchestrationError({
    code,
    message,
    retryable: code === 'UNAVAILABLE',
  });
}

function assertFrameLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 256) {
    throw new TypeError('maxFrameBytes must be a safe integer of at least 256');
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw orchestrationTransportError('CANCELLED', 'device orchestration request was cancelled');
  }
}

async function openAuthenticatedStream(
  options: DeviceOrchestrationTransportOptions,
  signal?: AbortSignal,
): Promise<{
  stream: MemeLoopDuplexStream;
  grant: DeviceConnectionGrant | undefined;
}> {
  const grant = await options.grantProvider?.(options.peerId, signal);
  return {
    stream: await options.deviceNetwork.openStream(
      options.peerId,
      DEVICE_ORCHESTRATION_PROTOCOL,
      {
        presentedGrant: grant,
        signal,
      },
    ),
    grant,
  };
}

async function writeRequest(
  stream: MemeLoopDuplexStream,
  request: RemoteOrchestrationRequest,
  grant: DeviceConnectionGrant | undefined,
  deadline: string | undefined,
  maxFrameBytes: number,
): Promise<void> {
  const envelope: DeviceOrchestrationRequestEnvelope = {
    type: 'memeloop-device-orchestration-request-v2',
    request,
    ...(deadline ? { deadline } : {}),
    ...(grant ? { grant } : {}),
  };
  await stream.sink(encodeJsonFrames([envelope], maxFrameBytes));
}

function abortStreamOnce(stream: MemeLoopDuplexStream): (error: Error) => Promise<void> {
  let aborted = false;
  return async (error) => {
    if (aborted) return;
    aborted = true;
    await stream.abort(error);
  };
}

function frameReader(
  stream: MemeLoopDuplexStream,
  maxFrameBytes: number,
  idleTimeoutMs: number,
  signal: AbortSignal | undefined,
  abort: (error: Error) => Promise<void>,
): AsyncIterable<unknown> {
  return createJsonFrameReader(stream.source, {
    maxPayloadBytes: maxFrameBytes,
    idleTimeoutMs,
    totalTimeoutMs: REQUEST_TOTAL_TIMEOUT_MS,
    signal,
    abort,
  });
}

function mapFrameError(error: unknown): never {
  if (!(error instanceof JsonFrameError)) throw error;
  if (error.code === 'ABORTED') {
    throw orchestrationTransportError('CANCELLED', error.message);
  }
  if (error.code === 'FRAME_TOO_LARGE') {
    throw orchestrationTransportError('EXHAUSTED', error.message);
  }
  if (error.code === 'IDLE_TIMEOUT' || error.code === 'TOTAL_TIMEOUT') {
    throw orchestrationTransportError('UNAVAILABLE', error.message);
  }
  throw orchestrationTransportError('INVALID', error.message);
}

/**
 * Carry the portable resource protocol over an already authenticated and
 * encrypted device-network stream. No bearer credential crosses the link:
 * authorization is bound to the paired peer identity opening the protocol.
 */
export function createDeviceOrchestrationTransport(
  options: DeviceOrchestrationTransportOptions,
): RemoteOrchestrationTransport {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  assertFrameLimit(maxFrameBytes);

  return {
    async request(request, transportOptions = {}) {
      throwIfAborted(transportOptions.signal);
      const deadline = transportOptions.deadline;
      const { stream, grant } = await openAuthenticatedStream(options, transportOptions.signal);
      const abort = abortStreamOnce(stream);
      const closeOnAbort = () => {
        void abort(orchestrationTransportError('CANCELLED', 'device orchestration request was cancelled'));
      };
      transportOptions.signal?.addEventListener('abort', closeOnAbort, {
        once: true,
      });
      try {
        await writeRequest(stream, request, grant, deadline, maxFrameBytes);
        let response: RemoteOrchestrationResponse | undefined;
        for await (
          const value of frameReader(
            stream,
            maxFrameBytes,
            REQUEST_IDLE_TIMEOUT_MS,
            transportOptions.signal,
            abort,
          )
        ) {
          if (response) {
            throw orchestrationTransportError(
              'INVALID',
              'device orchestration request returned multiple responses',
            );
          }
          response = value as RemoteOrchestrationResponse;
        }
        throwIfAborted(transportOptions.signal);
        if (!response) {
          throw orchestrationTransportError(
            'UNAVAILABLE',
            'device orchestration request returned no response',
          );
        }
        return response;
      } catch (error) {
        if (error instanceof JsonFrameError) await abort(error);
        mapFrameError(error);
      } finally {
        transportOptions.signal?.removeEventListener('abort', closeOnAbort);
        await stream.close().catch(() => undefined);
      }
    },
    async *watch(request, transportOptions = {}) {
      throwIfAborted(transportOptions.signal);
      const { stream, grant } = await openAuthenticatedStream(options, transportOptions.signal);
      const abort = abortStreamOnce(stream);
      const closeOnAbort = () => {
        void abort(orchestrationTransportError('CANCELLED', 'device orchestration watch was cancelled'));
      };
      transportOptions.signal?.addEventListener('abort', closeOnAbort, {
        once: true,
      });
      try {
        await writeRequest(
          stream,
          request,
          grant,
          transportOptions.deadline,
          maxFrameBytes,
        );
        for await (
          const value of frameReader(
            stream,
            maxFrameBytes,
            WATCH_IDLE_TIMEOUT_MS,
            transportOptions.signal,
            abort,
          )
        ) {
          throwIfAborted(transportOptions.signal);
          yield value as RemoteOrchestrationResponse;
        }
        throwIfAborted(transportOptions.signal);
      } catch (error) {
        if (error instanceof JsonFrameError) await abort(error);
        mapFrameError(error);
      } finally {
        transportOptions.signal?.removeEventListener('abort', closeOnAbort);
        await stream.close().catch(() => undefined);
      }
    },
  };
}

async function readSingleRequest(
  stream: MemeLoopDuplexStream,
  maxFrameBytes: number,
): Promise<DeviceOrchestrationRequestEnvelope> {
  const abort = abortStreamOnce(stream);
  let envelope: DeviceOrchestrationRequestEnvelope | undefined;
  for await (
    const value of frameReader(
      stream,
      maxFrameBytes,
      REQUEST_IDLE_TIMEOUT_MS,
      undefined,
      abort,
    )
  ) {
    if (envelope) {
      throw orchestrationTransportError(
        'INVALID',
        'device orchestration stream accepts exactly one request',
      );
    }
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      (value as Record<string, unknown>).type !== 'memeloop-device-orchestration-request-v2' ||
      (value as Record<string, unknown>).request === null ||
      typeof (value as Record<string, unknown>).request !== 'object'
    ) {
      throw orchestrationTransportError(
        'INVALID',
        'device orchestration request envelope is invalid',
      );
    }
    envelope = value as DeviceOrchestrationRequestEnvelope;
  }
  if (!envelope) {
    throw orchestrationTransportError('INVALID', 'device orchestration request is missing');
  }
  return envelope;
}

async function* withWatchBookmarks(
  source: AsyncIterable<RemoteOrchestrationResponse>,
  request: RemoteOrchestrationRequest,
  signal: AbortSignal,
): AsyncIterable<RemoteOrchestrationResponse> {
  const iterator = source[Symbol.asyncIterator]();
  type WatchActivity =
    | { kind: 'value'; value: IteratorResult<RemoteOrchestrationResponse> }
    | { kind: 'error'; error: unknown }
    | { kind: 'aborted' };

  let activity: WatchActivity | undefined;
  let activityWaiter: ((value: WatchActivity | { kind: 'bookmark' }) => void) | undefined;
  let bookmarkTimer: ReturnType<typeof setTimeout> | undefined;
  let readInFlight = false;
  let lastResourceVersion = watchResourceVersion(request.payload.options) ?? '0';

  const clearBookmarkTimer = () => {
    if (bookmarkTimer !== undefined) clearTimeout(bookmarkTimer);
    bookmarkTimer = undefined;
  };
  const publishActivity = (value: WatchActivity) => {
    if (activityWaiter) {
      const resolve = activityWaiter;
      activityWaiter = undefined;
      clearBookmarkTimer();
      resolve(value);
      return;
    }
    activity = value;
  };
  const readNext = () => {
    if (readInFlight) return;
    readInFlight = true;
    void iterator.next().then(
      (value) => {
        readInFlight = false;
        publishActivity({ kind: 'value', value });
      },
      (error: unknown) => {
        readInFlight = false;
        publishActivity({ kind: 'error', error });
      },
    );
  };
  const waitForActivity = (): Promise<WatchActivity | { kind: 'bookmark' }> => {
    if (activity) {
      const value = activity;
      activity = undefined;
      return Promise.resolve(value);
    }
    if (signal.aborted) return Promise.resolve({ kind: 'aborted' });
    return new Promise((resolve) => {
      activityWaiter = resolve;
      bookmarkTimer = setTimeout(() => {
        bookmarkTimer = undefined;
        activityWaiter = undefined;
        resolve({ kind: 'bookmark' });
      }, WATCH_BOOKMARK_INTERVAL_MS);
    });
  };
  const onAbort = () => {
    publishActivity({ kind: 'aborted' });
  };

  signal.addEventListener('abort', onAbort, { once: true });
  readNext();
  try {
    for (;;) {
      const result = await waitForActivity();
      if (result.kind === 'aborted') return;
      if (result.kind === 'bookmark') {
        yield {
          protocol: request.protocol,
          requestId: request.requestId,
          ok: true,
          result: { type: 'BOOKMARK', resourceVersion: lastResourceVersion },
        };
        continue;
      }
      if (result.kind === 'error') throw result.error;
      if (result.value.done) return;
      const response = result.value.value;
      lastResourceVersion = response.ok
        ? watchResourceVersion(response.result) ?? lastResourceVersion
        : lastResourceVersion;
      yield response;
      readNext();
    }
  } finally {
    clearBookmarkTimer();
    activityWaiter = undefined;
    signal.removeEventListener('abort', onAbort);
    void iterator.return?.();
  }
}

function watchResourceVersion(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const resourceVersion = (value as Record<string, unknown>).resourceVersion;
  return typeof resourceVersion === 'string' && resourceVersion.length > 0
    ? resourceVersion
    : undefined;
}

/** Bind a trusted peer identity to a policy-scoped orchestration handler. */
export function createDeviceOrchestrationStreamHandler(
  options: DeviceOrchestrationStreamHandlerOptions,
): DeviceOrchestrationStreamHandler {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  assertFrameLimit(maxFrameBytes);
  return async ({ remotePeerId, stream, authorize }) => {
    const abort = new AbortController();
    const abortFromStream = (): void => {
      if (!abort.signal.aborted) {
        abort.abort(stream.signal?.reason ?? new Error('device orchestration stream closed'));
      }
    };
    stream.signal?.addEventListener('abort', abortFromStream, { once: true });
    if (stream.signal?.aborted) abortFromStream();
    try {
      const envelope = await readSingleRequest(stream, maxFrameBytes);
      if (authorize && !(await authorize(envelope.grant))) {
        throw orchestrationTransportError('UNAVAILABLE', 'device_not_trusted');
      }
      const request = envelope.request;
      const handler = await options.resolveHandler(remotePeerId);
      if (request.operation === 'watch') {
        await stream.sink(
          encodeJsonFrames(
            withWatchBookmarks(handler.watch(request, { signal: abort.signal }), request, abort.signal),
            maxFrameBytes,
          ),
        );
      } else {
        const response = await handler.request(request, {
          signal: stream.signal,
          deadline: envelope.deadline ?? new Date(Date.now() + REQUEST_TOTAL_TIMEOUT_MS).toISOString(),
        });
        if (stream.signal?.aborted) return;
        await stream.sink(encodeJsonFrames([response], maxFrameBytes));
      }
    } finally {
      stream.signal?.removeEventListener('abort', abortFromStream);
      if (!abort.signal.aborted) abort.abort();
      await stream.close().catch(() => undefined);
    }
  };
}
