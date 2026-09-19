import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Libp2p, PrivateKey, Stream } from '@libp2p/interface';
import { tcp } from '@libp2p/tcp';
import { multiaddr } from '@multiformats/multiaddr';
import { createLibp2p } from 'libp2p';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDeviceOrchestrationStreamHandler,
  createDeviceOrchestrationTransport,
  createJsonFrameReader,
  type DeviceRpcHandlerInput,
  encodeJsonFrame,
  type FullAgentStorage,
  REMOTE_ORCHESTRATION_PROTOCOL,
} from 'memeloop';

import { createDeviceIdentity, encodePublicKeyMultibase, LIBP2P_DEVICE_NETWORK_FRAME_LIMITS, Libp2pDeviceNetworkService } from '../libp2pDeviceNetworkService.js';

const protocols = [
  '/memeloop/pairing/2.0.0',
  '/memeloop/rpc/2.0.0',
  '/memeloop/sync/2.0.0',
  '/memeloop/orchestration/2.0.0',
] as const;

type TestedProtocol = typeof protocols[number];

const maxPayloadBytes: Record<TestedProtocol, number> = {
  '/memeloop/pairing/2.0.0': LIBP2P_DEVICE_NETWORK_FRAME_LIMITS.pairing.maxPayloadBytes,
  '/memeloop/rpc/2.0.0': LIBP2P_DEVICE_NETWORK_FRAME_LIMITS.rpc.maxPayloadBytes,
  '/memeloop/sync/2.0.0': LIBP2P_DEVICE_NETWORK_FRAME_LIMITS.sync.maxPayloadBytes,
  '/memeloop/orchestration/2.0.0': 1024 * 1024,
};

const capabilities = {
  tools: [],
  mcpServers: [],
  hasWiki: false,
  agentLoop: true,
  imChannels: [],
  wikis: [],
};

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal || signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => {
      resolve();
    }, { once: true });
  });
}

function concatenate(...chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function withTimeout<T>(label: string, operation: Promise<T>, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label}_timeout`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readFirstFrame(stream: Stream, limit: number): Promise<Record<string, unknown>> {
  const source = (async function*(): AsyncIterable<Uint8Array> {
    for await (const chunk of stream) {
      yield chunk instanceof Uint8Array ? chunk : chunk.subarray();
    }
  })();
  const reader = createJsonFrameReader(source, {
    maxPayloadBytes: limit,
    idleTimeoutMs: 2_000,
    totalTimeoutMs: 5_000,
  })[Symbol.asyncIterator]();
  try {
    const result = await reader.next();
    if (result.done || typeof result.value !== 'object' || result.value === null) {
      throw new Error('response_frame_missing');
    }
    return result.value as Record<string, unknown>;
  } finally {
    void reader.return?.();
  }
}

async function readFramesToEnd(stream: Stream, limit: number): Promise<unknown[]> {
  const source = (async function*(): AsyncIterable<Uint8Array> {
    for await (const chunk of stream) {
      yield chunk instanceof Uint8Array ? chunk : chunk.subarray();
    }
  })();
  const frames = [];
  for await (
    const frame of createJsonFrameReader(source, {
      maxPayloadBytes: limit,
      idleTimeoutMs: 2_000,
      totalTimeoutMs: 5_000,
    })
  ) {
    frames.push(frame);
  }
  return frames;
}

async function readReset(stream: Stream): Promise<boolean> {
  try {
    for await (const _chunk of stream) {
      // A framing violation must reset before yielding an application response.
    }
    return false;
  } catch {
    return true;
  }
}

describe('real libp2p v2 framing matrix', () => {
  let rawNode: Libp2p;
  let rawPrivateKey: PrivateKey;
  let service: Libp2pDeviceNetworkService;
  let requestIndex = 0;
  let cancelRpc = false;
  let rpcStarted = deferred();
  let rpcCleaned = deferred();
  let rpcSignal: AbortSignal | undefined;
  let cancelSync = false;
  let syncStarted = deferred();
  let syncCleaned = deferred();
  let syncSignal: AbortSignal | undefined;
  let cancelWatch = false;
  let watchStarted = deferred();
  let watchCleaned = deferred();
  let watchSignal: AbortSignal | undefined;
  const rpcHandler = vi.fn(async (input: DeviceRpcHandlerInput) => {
    if (cancelRpc) {
      rpcSignal = input.signal;
      rpcStarted.resolve();
      await waitForAbort(input.signal);
      rpcCleaned.resolve();
      return { late: true };
    }
    return { echo: input.parameters };
  });
  const syncStorage = {
    getEventVersionFrontiersForKeys: vi.fn(async (
      _keys: unknown,
      options?: { signal?: AbortSignal },
    ) => {
      if (cancelSync) {
        syncSignal = options?.signal;
        syncStarted.resolve();
        await waitForAbort(options?.signal);
        syncCleaned.resolve();
      }
      return [];
    }),
    getEventVersionFrontierPage: vi.fn(async () => ({ items: [] })),
  } as unknown as FullAgentStorage;

  const dial = async (protocol: TestedProtocol): Promise<Stream> =>
    rawNode.dialProtocol(
      service.getMultiaddrs().map(address => multiaddr(address)),
      protocol,
      { runOnLimitedConnection: true },
    );

  const requestFor = async (protocol: TestedProtocol): Promise<Record<string, unknown>> => {
    requestIndex += 1;
    const id = `real-frame-${requestIndex}`;
    if (protocol === '/memeloop/pairing/2.0.0') {
      return {
        type: 'memeloop-local-pairing-request-v2',
        sessionId: `pairing-${id}`,
        requestNonce: requestIndex.toString(16).padStart(32, '0'),
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        device: {
          peerId: rawNode.peerId.toString(),
          publicKeyMultibase: await encodePublicKeyMultibase(rawPrivateKey.publicKey),
          deviceName: 'Raw framing peer',
          platform: 'cli',
          capabilities,
          multiaddrs: [],
        },
      };
    }
    if (protocol === '/memeloop/rpc/2.0.0') {
      return {
        type: 'memeloop-rpc-request-v2',
        id,
        method: 'memeloop.agent.getDefinitions',
        params: {},
      };
    }
    if (protocol === '/memeloop/sync/2.0.0') {
      return {
        type: 'memeloop-sync-request-v2',
        id,
        method: 'exchangeVersionFrontierPage',
        params: { localFrontiers: [], includeRemotePage: true },
      };
    }
    return {
      type: 'memeloop-device-orchestration-request-v2',
      request: {
        protocol: REMOTE_ORCHESTRATION_PROTOCOL,
        requestId: id,
        operation: 'get',
        payload: {
          reference: {
            apiVersion: 'run.memeloop.io/v1alpha1',
            kind: 'AgentRun',
            name: id,
          },
        },
      },
    };
  };

  const expectValidExchange = async (
    protocol: TestedProtocol,
    split: 'byte' | 'header-payload' | 'coalesced',
  ): Promise<void> => {
    const stream = await dial(protocol);
    const frame = encodeJsonFrame(await requestFor(protocol), maxPayloadBytes[protocol]);
    if (split === 'byte') {
      for (const byte of frame) stream.send(Uint8Array.of(byte));
    } else if (split === 'header-payload') {
      stream.send(frame.subarray(0, 2));
      stream.send(frame.subarray(2, 7));
      stream.send(frame.subarray(7));
    } else {
      stream.send(frame);
    }
    if (protocol === '/memeloop/orchestration/2.0.0') await stream.close();
    let response: Record<string, unknown>;
    try {
      response = await withTimeout(
        `${protocol}_response`,
        readFirstFrame(stream, maxPayloadBytes[protocol]),
      );
    } catch (error) {
      throw new Error(`${protocol}_valid_exchange_failed`, { cause: error });
    }
    if (protocol !== '/memeloop/orchestration/2.0.0') {
      expect(response.type).toEqual(expect.stringContaining('-v2'));
    }
    if (protocol === '/memeloop/pairing/2.0.0') expect(response.accepted).toBe(true);
    if (protocol === '/memeloop/rpc/2.0.0') expect(response.ok).toBe(true);
    if (protocol === '/memeloop/sync/2.0.0') {
      expect(response.ok).toBe(true);
    }
    if (protocol === '/memeloop/orchestration/2.0.0') expect(response.ok).toBe(true);
    await stream.close().catch(() => undefined);
  };

  beforeEach(async () => {
    const identity = await createDeviceIdentity('desktop', 'Framing service');
    service = new Libp2pDeviceNetworkService({
      identity,
      authorizer: { canOpenProtocol: async () => true },
      enableCircuitRelay: false,
      enableMdns: false,
      listen: { addresses: ['/ip4/127.0.0.1/tcp/0'] },
      rpcHandler,
      syncStorage,
      orchestrationHandler: createDeviceOrchestrationStreamHandler({
        resolveHandler: async remotePeerId => ({
          async request(request) {
            return {
              protocol: REMOTE_ORCHESTRATION_PROTOCOL,
              requestId: request.requestId,
              ok: true,
              result: { remotePeerId },
            };
          },
          async *watch(request, options) {
            if (!cancelWatch) return;
            watchSignal = options?.signal;
            watchStarted.resolve();
            try {
              await waitForAbort(options?.signal);
            } finally {
              watchCleaned.resolve();
            }
            yield {
              protocol: REMOTE_ORCHESTRATION_PROTOCOL,
              requestId: request.requestId,
              ok: true,
              result: { late: true },
            };
          },
        }),
      }),
    });
    rawPrivateKey = await generateKeyPair('Ed25519');
    rawNode = await createLibp2p({
      privateKey: rawPrivateKey,
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      start: false,
    });
    await service.start();
    await rawNode.start();
  });

  afterEach(async () => {
    await Promise.allSettled([rawNode.stop(), service.stop()]);
    rpcHandler.mockClear();
    cancelRpc = false;
    cancelSync = false;
    cancelWatch = false;
    rpcStarted = deferred();
    rpcCleaned = deferred();
    syncStarted = deferred();
    syncCleaned = deferred();
    watchStarted = deferred();
    watchCleaned = deferred();
    rpcSignal = undefined;
    syncSignal = undefined;
    watchSignal = undefined;
  });

  it('carries byte-split, boundary-split, and complete coalesced frames on real streams', async () => {
    await expectValidExchange('/memeloop/pairing/2.0.0', 'byte');
    await expectValidExchange('/memeloop/rpc/2.0.0', 'header-payload');
    await expectValidExchange('/memeloop/sync/2.0.0', 'coalesced');
    await expectValidExchange('/memeloop/orchestration/2.0.0', 'coalesced');
    expect(rpcHandler).toHaveBeenCalledOnce();
  }, 30_000);

  it.each(protocols)('%s resets over-limit and truncated frames and recovers after remote cancel', async protocol => {
    const oversized = await dial(protocol);
    const oversizedHeader = new Uint8Array(4);
    new DataView(oversizedHeader.buffer).setUint32(0, maxPayloadBytes[protocol] + 1, false);
    const oversizedReset = readReset(oversized);
    oversized.send(oversizedHeader);
    await expect(withTimeout(`${protocol}_oversized_reset`, oversizedReset)).resolves.toBe(true);

    const truncated = await dial(protocol);
    const validFrame = encodeJsonFrame(await requestFor(protocol), maxPayloadBytes[protocol]);
    const truncatedReset = readReset(truncated);
    truncated.send(validFrame.subarray(0, Math.min(validFrame.byteLength - 1, 7)));
    await truncated.close();
    await expect(withTimeout(`${protocol}_truncated_reset`, truncatedReset)).resolves.toBe(true);

    const cancelled = await dial(protocol);
    cancelled.send(validFrame.subarray(0, 3));
    cancelled.abort(new Error('remote-test-cancel'));

    await expectValidExchange(protocol, 'coalesced');
  }, 30_000);

  it('cancels an active RPC handler on peer reset, suppresses its late result, and recovers', async () => {
    cancelRpc = true;
    const stream = await dial('/memeloop/rpc/2.0.0');
    stream.send(encodeJsonFrame(
      await requestFor('/memeloop/rpc/2.0.0'),
      maxPayloadBytes['/memeloop/rpc/2.0.0'],
    ));
    await withTimeout('rpc_handler_started', rpcStarted.promise);

    stream.abort(new Error('cancel-active-rpc'));
    await withTimeout('rpc_handler_cleaned', rpcCleaned.promise);

    expect(rpcSignal?.aborted).toBe(true);
    cancelRpc = false;
    await expectValidExchange('/memeloop/rpc/2.0.0', 'coalesced');
  }, 30_000);

  it('cancels active sync storage work on peer reset and recovers', async () => {
    cancelSync = true;
    const stream = await dial('/memeloop/sync/2.0.0');
    stream.send(encodeJsonFrame(
      await requestFor('/memeloop/sync/2.0.0'),
      maxPayloadBytes['/memeloop/sync/2.0.0'],
    ));
    await withTimeout('sync_storage_started', syncStarted.promise);

    stream.abort(new Error('cancel-active-sync'));
    await withTimeout('sync_storage_cleaned', syncCleaned.promise);

    expect(syncSignal?.aborted).toBe(true);
    cancelSync = false;
    await expectValidExchange('/memeloop/sync/2.0.0', 'coalesced');
  }, 30_000);

  it('cancels an active orchestration watch iterator on peer reset and recovers', async () => {
    cancelWatch = true;
    const stream = await dial('/memeloop/orchestration/2.0.0');
    stream.send(encodeJsonFrame({
      type: 'memeloop-device-orchestration-request-v2',
      request: {
        protocol: REMOTE_ORCHESTRATION_PROTOCOL,
        requestId: 'cancel-active-watch',
        operation: 'watch',
        payload: { query: { kind: 'AgentRun' } },
      },
    }, maxPayloadBytes['/memeloop/orchestration/2.0.0']));
    await stream.close();
    await withTimeout('watch_iterator_started', watchStarted.promise);

    stream.abort(new Error('cancel-active-watch'));
    await withTimeout('watch_iterator_cleaned', watchCleaned.promise);

    expect(watchSignal?.aborted).toBe(true);
    cancelWatch = false;
    await expectValidExchange('/memeloop/orchestration/2.0.0', 'coalesced');
  }, 30_000);

  it('consumes bookmark and event frames sent together by a real watch peer in order', async () => {
    const requestId = 'coalesced-watch-response';
    let responseSendCount = 0;
    await rawNode.handle('/memeloop/orchestration/2.0.0', async (stream) => {
      const requests = await readFramesToEnd(
        stream,
        maxPayloadBytes['/memeloop/orchestration/2.0.0'],
      );
      expect(requests).toHaveLength(1);
      const bookmark = encodeJsonFrame({
        protocol: REMOTE_ORCHESTRATION_PROTOCOL,
        requestId,
        ok: true,
        result: { type: 'BOOKMARK', resourceVersion: '7' },
      }, maxPayloadBytes['/memeloop/orchestration/2.0.0']);
      const event = encodeJsonFrame({
        protocol: REMOTE_ORCHESTRATION_PROTOCOL,
        requestId,
        ok: true,
        result: {
          type: 'ADDED',
          resourceVersion: '8',
          resource: { apiVersion: 'run.memeloop.io/v1alpha1', kind: 'AgentRun' },
        },
      }, maxPayloadBytes['/memeloop/orchestration/2.0.0']);
      responseSendCount += 1;
      stream.send(concatenate(bookmark, event));
      await stream.close();
    }, { runOnLimitedConnection: true });

    service.upsertDiscoveredDevice({
      peerId: rawNode.peerId.toString(),
      displayName: 'Raw watch peer',
      platform: 'cli',
      trustMode: 'local-pairing',
      trusted: true,
      reachability: { state: 'online', paths: ['lan'] },
      capabilities,
      multiaddrs: rawNode.getMultiaddrs().map(address => address.toString()),
    });
    const transport = createDeviceOrchestrationTransport({
      deviceNetwork: service,
      peerId: rawNode.peerId.toString(),
    });
    const responses = [];
    for await (
      const response of transport.watch({
        protocol: REMOTE_ORCHESTRATION_PROTOCOL,
        requestId,
        operation: 'watch',
        payload: { query: { kind: 'AgentRun' } },
      })
    ) {
      responses.push(response);
    }

    expect(responseSendCount).toBe(1);
    expect(responses.map(response => response.ok ? response.result : response.error)).toEqual([
      { type: 'BOOKMARK', resourceVersion: '7' },
      {
        type: 'ADDED',
        resourceVersion: '8',
        resource: { apiVersion: 'run.memeloop.io/v1alpha1', kind: 'AgentRun' },
      },
    ]);
  }, 30_000);
});
