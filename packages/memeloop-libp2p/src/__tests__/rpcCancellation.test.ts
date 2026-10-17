import type { Stream } from '@libp2p/interface';
import { describe, expect, it, vi } from 'vitest';

import { AGENT_DEVICE_RPC_METHODS, encodeJsonFrame } from 'memeloop';

import { createDeviceIdentity, PortableLibp2pDeviceNetworkService } from '../portableLibp2pDeviceNetworkService.js';

describe('libp2p RPC cancellation', () => {
  it.each([
    {
      label: 'attachment upload',
      method: AGENT_DEVICE_RPC_METHODS.beginAttachmentUpload,
      parameters: {
        requestId: 'upload-request-1',
        conversationId: 'conversation-1',
        filename: 'note.txt',
        mimeType: 'text/plain',
        totalBytes: 10,
      },
    },
    {
      label: 'LLM turn',
      method: AGENT_DEVICE_RPC_METHODS.runTurn,
      parameters: {
        requestId: 'run-request-1',
        turnId: 'turn-1',
        conversationId: 'conversation-1',
        definitionId: 'definition-1',
        message: 'wait',
      },
    },
  ])('aborts a pending inbound $label exactly once when the remote stream closes', async ({
    method,
    parameters,
  }) => {
    const events = new EventTarget();
    const request = encodeJsonFrame({
      type: 'memeloop-rpc-request-v2',
      id: 'request-1',
      method,
      params: parameters,
    });
    const sent: Uint8Array[] = [];
    const close = vi.fn(async () => undefined);
    const removeEventListener = vi.fn(events.removeEventListener.bind(events));
    let observedSignal: AbortSignal | undefined;
    let abortEvents = 0;
    const rpcHandler = vi.fn(async (input: { signal?: AbortSignal }) => {
      observedSignal = input.signal;
      return new Promise((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => {
          abortEvents += 1;
          reject(
            input.signal?.reason instanceof Error
              ? input.signal.reason
              : new Error('rpc_stream_closed'),
          );
        }, { once: true });
      });
    });
    const stream = {
      send: (chunk: Uint8Array) => {
        sent.push(chunk);
      },
      close,
      abort: vi.fn(),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener,
      async *[Symbol.asyncIterator]() {
        yield request;
      },
    } as unknown as Stream;
    const service = new PortableLibp2pDeviceNetworkService({
      identity: {
        peerId: 'local-peer',
        publicKeyMultibase: 'libp2p-pub:test',
        privateKeyRef: 'test',
        createdAt: 1,
        deviceName: 'local',
        platform: 'cli',
      },
      authorizer: { canOpenProtocol: async () => true },
      rpcHandler,
      nodeFactory: async () => {
        throw new Error('node factory must not run');
      },
    });

    const handling = (service as unknown as {
      handleRpcStream(stream: Stream, remotePeerId: string): Promise<void>;
    }).handleRpcStream(stream, 'remote-peer');
    await vi.waitFor(() => {
      expect(rpcHandler).toHaveBeenCalledOnce();
    });

    const firstClose = Object.assign(new Event('close'), { error: new Error('remote_reset') });
    events.dispatchEvent(firstClose);
    events.dispatchEvent(Object.assign(new Event('close'), { error: new Error('duplicate_reset') }));
    await handling;

    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBe(firstClose.error);
    expect(abortEvents).toBe(1);
    expect(sent).toEqual([]);
    expect(removeEventListener).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('maps an external AbortSignal to exactly one underlying stream abort', async () => {
    const [localIdentity, remoteIdentity] = await Promise.all([
      createDeviceIdentity('cli', 'local'),
      createDeviceIdentity('cli', 'remote'),
    ]);
    let rejectRead: (reason: Error) => void = () => {};
    const pendingRead = new Promise<IteratorResult<Uint8Array>>((_resolve, reject) => {
      rejectRead = reject;
    });
    const stream = {
      send: vi.fn(),
      close: vi.fn(async () => {}),
      abort: vi.fn((error: Error) => {
        rejectRead(error);
      }),
      [Symbol.asyncIterator]() {
        return { next: () => pendingRead };
      },
    };
    const dialProtocol = vi.fn(async (_targets: unknown) => stream);
    const service = new PortableLibp2pDeviceNetworkService({
      identity: localIdentity,
      authorizer: { canOpenProtocol: async () => true },
      enableMdns: false,
      listen: { addresses: [] },
      nodeFactory: async () => {
        throw new Error('node factory must not run');
      },
    });
    Reflect.set(service, 'libp2p', { dialProtocol });
    service.upsertDiscoveredDevice({
      peerId: remoteIdentity.peerId,
      displayName: 'remote',
      platform: 'cli',
      trustMode: 'local-pairing',
      trusted: true,
      reachability: { state: 'online', paths: ['direct'] },
      capabilities: {
        tools: [],
        mcpServers: [],
        hasWiki: false,
        imChannels: [],
        wikis: [],
      },
      multiaddrs: [`/ip4/127.0.0.1/tcp/43123/p2p/${remoteIdentity.peerId}`],
    });
    const abort = new AbortController();

    const result = service.sendRpc(
      remoteIdentity.peerId,
      'memeloop.test.wait',
      {},
      { signal: abort.signal },
    );
    await vi.waitFor(() => {
      expect(stream.send).toHaveBeenCalled();
    });
    abort.abort(new Error('caller_cancelled'));

    await expect(result).rejects.toThrow('caller_cancelled');
    expect(stream.abort).toHaveBeenCalledOnce();
  });

  it('dials strict PeerId-bound Cloud directory addresses without prior discovery', async () => {
    const [localIdentity, remoteIdentity] = await Promise.all([
      createDeviceIdentity('cli', 'local'),
      createDeviceIdentity('cli', 'remote'),
    ]);
    const stream = {
      send: vi.fn(),
      close: vi.fn(async () => {}),
      abort: vi.fn(),
      async *[Symbol.asyncIterator]() {},
    };
    const dialProtocol = vi.fn(async (_targets: unknown) => stream);
    const service = new PortableLibp2pDeviceNetworkService({
      identity: localIdentity,
      authorizer: { canOpenProtocol: async () => true },
      enableMdns: false,
      listen: { addresses: [] },
      nodeFactory: async () => {
        throw new Error('node factory must not run');
      },
    });
    Reflect.set(service, 'libp2p', { dialProtocol });
    const address = `/ip4/127.0.0.1/tcp/43123/ws/p2p/${remoteIdentity.peerId}`;
    service.setCloudDeviceAddresses(remoteIdentity.peerId, [address]);
    service.upsertCloudDiscoveredDevice({
      peerId: remoteIdentity.peerId,
      displayName: 'remote',
      platform: 'cli',
      trustMode: 'cloud-account',
      trusted: true,
      reachability: { state: 'online', paths: ['direct'] },
      capabilities: {
        tools: [],
        mcpServers: [],
        hasWiki: false,
        imChannels: [],
        wikis: [],
      },
    });

    await service.openStream(remoteIdentity.peerId, '/memeloop/rpc/2.0.0');

    expect(dialProtocol).toHaveBeenCalledOnce();
    const dialTargets = dialProtocol.mock.calls[0]?.[0] as Array<{ toString(): string }> | undefined;
    expect(Array.isArray(dialTargets)).toBe(true);
    expect(dialTargets?.map((target) => target.toString())).toEqual([address]);
  });

  it('rejects Cloud directory addresses bound to another PeerId', async () => {
    const [localIdentity, remoteIdentity, attackerIdentity] = await Promise.all([
      createDeviceIdentity('cli', 'local'),
      createDeviceIdentity('cli', 'remote'),
      createDeviceIdentity('cli', 'attacker'),
    ]);
    const service = new PortableLibp2pDeviceNetworkService({
      identity: localIdentity,
      authorizer: { canOpenProtocol: async () => true },
      enableMdns: false,
      listen: { addresses: [] },
      nodeFactory: async () => {
        throw new Error('node factory must not run');
      },
    });

    expect(() => {
      service.setCloudDeviceAddresses(remoteIdentity.peerId, [
        `/ip4/127.0.0.1/tcp/43123/ws/p2p/${attackerIdentity.peerId}`,
      ]);
    }).toThrow('cloud_directory_address_peer_id_mismatch');
  });
});
