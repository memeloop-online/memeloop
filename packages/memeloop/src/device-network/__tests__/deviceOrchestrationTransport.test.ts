import { describe, expect, it, vi } from 'vitest';

import type { AgentOrchestrationClient } from '../../orchestration/client.js';
import {
  createRemoteOrchestrationHandler,
  REMOTE_ORCHESTRATION_PROTOCOL,
  type RemoteOrchestrationRequest,
  type RemoteOrchestrationResponse,
} from '../../orchestration/remoteClient.js';
import { createDeviceOrchestrationStreamHandler, createDeviceOrchestrationTransport } from '../deviceOrchestrationTransport.js';
import { createJsonFrameReader, encodeJsonFrame } from '../jsonFrame.js';
import type { DeviceNetworkService, MemeLoopDuplexStream } from '../types.js';

function response(requestId: string, result: unknown): RemoteOrchestrationResponse {
  return {
    protocol: REMOTE_ORCHESTRATION_PROTOCOL,
    requestId,
    ok: true,
    result,
  };
}

function scriptedStream(lines: unknown[]): MemeLoopDuplexStream & {
  written: Uint8Array[];
  closed: boolean;
  aborted: number;
} {
  const written: Uint8Array[] = [];
  let closed = false;
  let aborted = 0;
  return {
    source: (async function*() {
      const frames = lines.map((line) => encodeJsonFrame(line));
      const bytes = new Uint8Array(frames.reduce((size, frame) => size + frame.byteLength, 0));
      let offset = 0;
      for (const frame of frames) {
        bytes.set(frame, offset);
        offset += frame.byteLength;
      }
      yield bytes.subarray(0, Math.max(1, Math.floor(bytes.byteLength / 2)));
      yield bytes.subarray(Math.max(1, Math.floor(bytes.byteLength / 2)));
    })(),
    async sink(source) {
      for await (const chunk of source) written.push(chunk);
    },
    async close() {
      closed = true;
    },
    abort() {
      aborted += 1;
    },
    get written() {
      return written;
    },
    get closed() {
      return closed;
    },
    get aborted() {
      return aborted;
    },
  };
}

function deferredResponseStream(): MemeLoopDuplexStream & {
  respond(value: unknown): void;
  closed: boolean;
  aborted: number;
} {
  let respond: ((value: Uint8Array) => void) | undefined;
  let closed = false;
  let aborted = 0;
  const response = new Promise<Uint8Array>((resolve) => {
    respond = resolve;
  });
  return {
    source: (async function*() {
      yield await response;
    })(),
    async sink(source) {
      for await (const _chunk of source) {
        // consume the request
      }
    },
    async close() {
      closed = true;
    },
    abort() {
      aborted += 1;
    },
    respond(value) {
      respond?.(encodeJsonFrame(value));
    },
    get closed() {
      return closed;
    },
    get aborted() {
      return aborted;
    },
  };
}

async function decodeWritten(stream: ReturnType<typeof scriptedStream>): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (
    const value of createJsonFrameReader(
      (async function*() {
        yield* stream.written;
      })(),
      {
        maxPayloadBytes: 1024 * 1024,
        idleTimeoutMs: 100,
        totalTimeoutMs: 100,
      },
    )
  ) values.push(value);
  return values;
}

function networkReturning(stream: MemeLoopDuplexStream): DeviceNetworkService {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    getLocalDevice: vi.fn(),
    listDevices: vi.fn(),
    observeDevices: vi.fn(),
    listPairingSessions: vi.fn(),
    observePairingSessions: vi.fn(),
    requestLocalPairing: vi.fn(),
    acceptPairing: vi.fn(),
    rejectPairing: vi.fn(),
    removeTrustedDevice: vi.fn(),
    openStream: vi.fn(async () => stream),
    sendRpc: vi.fn(),
    syncWithDevice: vi.fn(),
  } as unknown as DeviceNetworkService;
}

const getRequest: RemoteOrchestrationRequest = {
  protocol: REMOTE_ORCHESTRATION_PROTOCOL,
  requestId: 'get-1',
  operation: 'get',
  payload: {
    reference: {
      apiVersion: 'run.memeloop.io/v1alpha1',
      kind: 'AgentRun',
      name: 'run-1',
    },
  },
};

describe('device orchestration transport', () => {
  it('carries a correlated request over one authenticated device stream', async () => {
    const stream = scriptedStream([response('get-1', { value: 1 })]);
    const network = networkReturning(stream);
    const transport = createDeviceOrchestrationTransport({
      deviceNetwork: network,
      peerId: 'desktop-peer',
    });

    await expect(transport.request(getRequest)).resolves.toEqual(response('get-1', { value: 1 }));
    expect(await decodeWritten(stream)).toEqual([{
      type: 'memeloop-device-orchestration-request-v2',
      request: getRequest,
    }]);
    expect(network.openStream).toHaveBeenCalledWith(
      'desktop-peer',
      '/memeloop/orchestration/2.0.0',
      { presentedGrant: undefined, signal: undefined },
    );
    expect(stream.closed).toBe(true);
  });

  it('streams every bounded watch response and closes on completion', async () => {
    const watchRequest: RemoteOrchestrationRequest = {
      protocol: REMOTE_ORCHESTRATION_PROTOCOL,
      requestId: 'watch-1',
      operation: 'watch',
      payload: { query: { kind: 'AgentRun' } },
    };
    const stream = scriptedStream([
      response('watch-1', { type: 'ADDED', resourceVersion: '1' }),
      response('watch-1', { type: 'BOOKMARK', resourceVersion: '2' }),
    ]);
    const transport = createDeviceOrchestrationTransport({
      deviceNetwork: networkReturning(stream),
      peerId: 'desktop-peer',
    });

    const observed: RemoteOrchestrationResponse[] = [];
    for await (const event of transport.watch(watchRequest)) observed.push(event);

    expect(observed).toEqual([
      response('watch-1', { type: 'ADDED', resourceVersion: '1' }),
      response('watch-1', { type: 'BOOKMARK', resourceVersion: '2' }),
    ]);
    expect(stream.closed).toBe(true);
  });

  it('routes request and watch streams through the policy-scoped handler', async () => {
    const acceptedResource = {
      apiVersion: 'run.memeloop.io/v1alpha1',
      kind: 'AgentRun',
      metadata: {
        name: 'run-1',
        namespace: 'default',
        uid: 'uid-run-1',
        generation: 1,
        resourceVersion: '1',
        creationTimestamp: '2026-08-25T00:00:00.000Z',
      },
      spec: {},
      status: { actorReportedStatus: { accepted: true } },
    };
    const client = {
      getCapabilities: vi.fn(),
      apply: vi.fn(),
      get: (async () => acceptedResource) as AgentOrchestrationClient['get'],
      list: vi.fn(),
      async *watch() {
        yield {
          type: 'BOOKMARK' as const,
          resourceVersion: '7',
        };
      },
      delete: vi.fn(),
    } satisfies AgentOrchestrationClient;
    const handler = createDeviceOrchestrationStreamHandler({
      resolveHandler: async (peerId) => {
        expect(peerId).toBe('mobile-peer');
        return createRemoteOrchestrationHandler(client);
      },
    });

    const requestStream = scriptedStream([
      {
        type: 'memeloop-device-orchestration-request-v2',
        request: getRequest,
      },
    ]);
    await handler({ remotePeerId: 'mobile-peer', stream: requestStream });
    expect(await decodeWritten(requestStream)).toEqual([response('get-1', acceptedResource)]);

    const watchRequest: RemoteOrchestrationRequest = {
      protocol: REMOTE_ORCHESTRATION_PROTOCOL,
      requestId: 'watch-2',
      operation: 'watch',
      payload: { query: { kind: 'AgentRun' } },
    };
    const watchStream = scriptedStream([
      {
        type: 'memeloop-device-orchestration-request-v2',
        request: watchRequest,
      },
    ]);
    await handler({ remotePeerId: 'mobile-peer', stream: watchStream });
    expect(await decodeWritten(watchStream)).toEqual([
      response('watch-2', { type: 'BOOKMARK', resourceVersion: '7' }),
    ]);
  });

  it('sends quiet-watch bookmarks with the last real resource version', async () => {
    vi.useFakeTimers();
    let finishWatch: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      finishWatch = resolve;
    });
    const client = {
      getCapabilities: vi.fn(),
      apply: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      async *watch() {
        yield {
          type: 'ADDED' as const,
          resourceVersion: '11',
          resource: { kind: 'AgentRun' },
        };
        await finished;
      },
      delete: vi.fn(),
    } as unknown as AgentOrchestrationClient;
    const handler = createDeviceOrchestrationStreamHandler({
      resolveHandler: async () => createRemoteOrchestrationHandler(client),
    });
    const watchRequest: RemoteOrchestrationRequest = {
      protocol: REMOTE_ORCHESTRATION_PROTOCOL,
      requestId: 'watch-keepalive',
      operation: 'watch',
      payload: { query: { kind: 'AgentRun' } },
    };
    const watchStream = scriptedStream([{
      type: 'memeloop-device-orchestration-request-v2',
      request: watchRequest,
    }]);

    try {
      const running = handler({ remotePeerId: 'mobile-peer', stream: watchStream });
      await vi.advanceTimersByTimeAsync(0);
      expect(watchStream.written).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(watchStream.written).toHaveLength(2);

      finishWatch?.();
      await vi.advanceTimersByTimeAsync(0);
      await running;
      expect(await decodeWritten(watchStream)).toEqual([
        response('watch-keepalive', {
          type: 'ADDED',
          resourceVersion: '11',
          resource: { kind: 'AgentRun' },
        }),
        response('watch-keepalive', { type: 'BOOKMARK', resourceVersion: '11' }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when a frame exceeds the configured limit', async () => {
    const stream = scriptedStream([response('get-1', { secret: 'x'.repeat(300) })]);
    const transport = createDeviceOrchestrationTransport({
      deviceNetwork: networkReturning(stream),
      peerId: 'desktop-peer',
      maxFrameBytes: 256,
    });

    await expect(transport.request(getRequest)).rejects.toMatchObject({
      code: 'EXHAUSTED',
    });
    expect(stream.closed).toBe(true);
    expect(stream.aborted).toBe(1);
  });

  it('aborts an in-flight ordinary request stream exactly once and rejects a late response', async () => {
    const stream = deferredResponseStream();
    const transport = createDeviceOrchestrationTransport({
      deviceNetwork: networkReturning(stream),
      peerId: 'desktop-peer',
    });
    const abort = new AbortController();

    const pending = transport.request(getRequest, {
      signal: abort.signal,
      deadline: new Date(Date.now() + 10_000).toISOString(),
    });
    await vi.waitFor(() => {
      expect(stream.closed).toBe(false);
    });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    abort.abort();

    await rejection;
    expect(stream.aborted).toBe(1);

    stream.respond(response('get-1', { late: true }));
    await Promise.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(stream.aborted).toBe(1);
  });

  it('propagates inbound stream cancellation to the handler and never writes its late result', async () => {
    const streamAbort = new AbortController();
    const requestStream = Object.assign(
      scriptedStream([{
        type: 'memeloop-device-orchestration-request-v2',
        request: getRequest,
        deadline: new Date(Date.now() + 10_000).toISOString(),
      }]),
      { signal: streamAbort.signal },
    );
    let resolveGet: ((value: ReturnType<typeof response>) => void) | undefined;
    let delegatedSignal: AbortSignal | undefined;
    const source = {
      getCapabilities: vi.fn(),
      apply: vi.fn(),
      get: (_reference: unknown, options?: { signal?: AbortSignal }) => {
        delegatedSignal = options?.signal;
        return new Promise((resolve) => {
          resolveGet = resolve as typeof resolveGet;
        });
      },
      list: vi.fn(),
      async *watch() {},
      delete: vi.fn(),
    } as unknown as AgentOrchestrationClient;
    const handler = createDeviceOrchestrationStreamHandler({
      resolveHandler: async () => createRemoteOrchestrationHandler(source),
    });

    const running = handler({ remotePeerId: 'mobile-peer', stream: requestStream });
    await vi.waitFor(() => {
      expect(delegatedSignal).toBeDefined();
    });
    streamAbort.abort();
    await running;

    expect(delegatedSignal?.aborted).toBe(true);
    expect(requestStream.written).toHaveLength(0);
    resolveGet?.(response('get-1', { late: true }));
    await Promise.resolve();
    expect(requestStream.written).toHaveLength(0);
  });
});
