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
      undefined,
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
    const client = {
      getCapabilities: vi.fn(),
      apply: vi.fn(),
      get: vi.fn(async () => ({ accepted: true })),
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
    expect(await decodeWritten(requestStream)).toEqual([response('get-1', { accepted: true })]);

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
});
