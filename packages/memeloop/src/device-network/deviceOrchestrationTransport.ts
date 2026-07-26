import { OrchestrationError } from '../orchestration/errors.js';
import type { RemoteOrchestrationRequest, RemoteOrchestrationResponse, RemoteOrchestrationTransport, RemoteOrchestrationTransportOptions } from '../orchestration/remoteClient.js';
import type { DeviceConnectionGrant, DeviceNetworkService, MemeLoopDuplexStream } from './types.js';

export const DEVICE_ORCHESTRATION_PROTOCOL = '/memeloop/orchestration/1.0.0' as const;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

export interface DeviceOrchestrationTransportOptions {
  deviceNetwork: Pick<DeviceNetworkService, 'openStream'>;
  peerId: string;
  grantProvider?: (
    peerId: string,
  ) => DeviceConnectionGrant | undefined | Promise<DeviceConnectionGrant | undefined>;
  maxFrameBytes?: number;
}

export interface DeviceOrchestrationStreamHandlerInput {
  remotePeerId: string;
  stream: MemeLoopDuplexStream;
  authorize?: (presentedGrant: DeviceConnectionGrant | undefined) => boolean | Promise<boolean>;
}

export type RemoteOrchestrationHandler = {
  request(request: RemoteOrchestrationRequest): Promise<RemoteOrchestrationResponse>;
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
  type: 'memeloop-device-orchestration-request-v1';
  request: RemoteOrchestrationRequest;
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

async function* encodeLines(
  values: AsyncIterable<unknown> | Iterable<unknown>,
  maxFrameBytes: number,
): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  for await (const value of values) {
    const frame = encoder.encode(`${JSON.stringify(value)}\n`);
    if (frame.byteLength > maxFrameBytes) {
      throw orchestrationTransportError(
        'EXHAUSTED',
        `device orchestration frame exceeds ${maxFrameBytes} bytes`,
      );
    }
    yield frame;
  }
}

async function* decodeLines(
  source: AsyncIterable<Uint8Array>,
  maxFrameBytes: number,
): AsyncIterable<unknown> {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of source) {
    buffered += decoder.decode(chunk, { stream: true });
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      if (new TextEncoder().encode(line).byteLength > maxFrameBytes) {
        throw orchestrationTransportError(
          'EXHAUSTED',
          `device orchestration frame exceeds ${maxFrameBytes} bytes`,
        );
      }
      try {
        yield JSON.parse(line) as unknown;
      } catch {
        throw orchestrationTransportError(
          'INVALID',
          'device orchestration stream contains invalid JSON',
        );
      }
    }
    if (new TextEncoder().encode(buffered).byteLength > maxFrameBytes) {
      throw orchestrationTransportError(
        'EXHAUSTED',
        `device orchestration frame exceeds ${maxFrameBytes} bytes`,
      );
    }
  }
  buffered += decoder.decode();
  if (buffered.trim()) {
    try {
      yield JSON.parse(buffered) as unknown;
    } catch {
      throw orchestrationTransportError(
        'INVALID',
        'device orchestration stream contains invalid trailing JSON',
      );
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw orchestrationTransportError('CANCELLED', 'device orchestration request was cancelled');
  }
}

async function openAuthenticatedStream(options: DeviceOrchestrationTransportOptions): Promise<{
  stream: MemeLoopDuplexStream;
  grant: DeviceConnectionGrant | undefined;
}> {
  const grant = await options.grantProvider?.(options.peerId);
  return {
    stream: await options.deviceNetwork.openStream(
      options.peerId,
      DEVICE_ORCHESTRATION_PROTOCOL,
      grant,
    ),
    grant,
  };
}

async function writeRequest(
  stream: MemeLoopDuplexStream,
  request: RemoteOrchestrationRequest,
  grant: DeviceConnectionGrant | undefined,
  maxFrameBytes: number,
): Promise<void> {
  const envelope: DeviceOrchestrationRequestEnvelope = {
    type: 'memeloop-device-orchestration-request-v1',
    request,
    ...(grant ? { grant } : {}),
  };
  await stream.sink(encodeLines([envelope], maxFrameBytes));
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
      const { stream, grant } = await openAuthenticatedStream(options);
      const closeOnAbort = () => {
        void stream.close();
      };
      transportOptions.signal?.addEventListener('abort', closeOnAbort, {
        once: true,
      });
      try {
        await writeRequest(stream, request, grant, maxFrameBytes);
        let response: RemoteOrchestrationResponse | undefined;
        for await (const value of decodeLines(stream.source, maxFrameBytes)) {
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
      } finally {
        transportOptions.signal?.removeEventListener('abort', closeOnAbort);
        await stream.close().catch(() => undefined);
      }
    },
    async *watch(request, transportOptions = {}) {
      throwIfAborted(transportOptions.signal);
      const { stream, grant } = await openAuthenticatedStream(options);
      const closeOnAbort = () => {
        void stream.close();
      };
      transportOptions.signal?.addEventListener('abort', closeOnAbort, {
        once: true,
      });
      try {
        await writeRequest(stream, request, grant, maxFrameBytes);
        for await (const value of decodeLines(stream.source, maxFrameBytes)) {
          throwIfAborted(transportOptions.signal);
          yield value as RemoteOrchestrationResponse;
        }
        throwIfAborted(transportOptions.signal);
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
  let envelope: DeviceOrchestrationRequestEnvelope | undefined;
  for await (const value of decodeLines(stream.source, maxFrameBytes)) {
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
      (value as Record<string, unknown>).type !== 'memeloop-device-orchestration-request-v1' ||
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

/** Bind a trusted peer identity to a policy-scoped orchestration handler. */
export function createDeviceOrchestrationStreamHandler(
  options: DeviceOrchestrationStreamHandlerOptions,
): DeviceOrchestrationStreamHandler {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  assertFrameLimit(maxFrameBytes);
  return async ({ remotePeerId, stream, authorize }) => {
    const abort = new AbortController();
    try {
      const envelope = await readSingleRequest(stream, maxFrameBytes);
      if (authorize && !(await authorize(envelope.grant))) {
        throw orchestrationTransportError('UNAVAILABLE', 'device_not_trusted');
      }
      const request = envelope.request;
      const handler = await options.resolveHandler(remotePeerId);
      if (request.operation === 'watch') {
        await stream.sink(
          encodeLines(handler.watch(request, { signal: abort.signal }), maxFrameBytes),
        );
      } else {
        await stream.sink(encodeLines([await handler.request(request)], maxFrameBytes));
      }
    } finally {
      abort.abort();
      await stream.close().catch(() => undefined);
    }
  };
}
