import type { Stream } from '@libp2p/interface';
import { describe, expect, it, vi } from 'vitest';

import { encodeJsonFrame } from 'memeloop';

import { createDeviceIdentity, PortableLibp2pDeviceNetworkService, type RawSeedDeviceIdentity } from '../portableLibp2pDeviceNetworkService.js';

const capabilities = {
  tools: [],
  mcpServers: [],
  hasWiki: false,
  agentLoop: false,
  imChannels: [],
  wikis: [],
};

type PairingRequest = ReturnType<typeof pairingRequest>;

function pairingRequest(
  identity: RawSeedDeviceIdentity,
  index = 1,
  overrides: Record<string, unknown> = {},
) {
  const createdAt = Date.now();
  return {
    type: 'memeloop-local-pairing-request-v2',
    sessionId: `pairing-test-${index}`,
    requestNonce: index.toString(16).padStart(32, '0'),
    createdAt,
    expiresAt: createdAt + 5 * 60_000,
    device: {
      peerId: identity.peerId,
      publicKeyMultibase: identity.publicKeyMultibase,
      deviceName: identity.deviceName,
      platform: identity.platform,
      capabilities,
      multiaddrs: [`/ip4/127.0.0.1/tcp/41001/p2p/${identity.peerId}`],
    },
    ...overrides,
  };
}

function decodeFrame(frame: Uint8Array): Record<string, unknown> {
  const length = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, false);
  return JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + length))) as Record<string, unknown>;
}

function requestStream(request: unknown): {
  stream: Stream;
  abort: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  sent: Uint8Array[];
} {
  const sent: Uint8Array[] = [];
  const abort = vi.fn();
  const close = vi.fn(async () => undefined);
  const frame = encodeJsonFrame(request);
  return {
    stream: {
      send(chunk: Uint8Array) {
        sent.push(chunk);
      },
      abort,
      close,
      async *[Symbol.asyncIterator]() {
        yield frame;
      },
    } as unknown as Stream,
    abort,
    close,
    sent,
  };
}

async function serviceWithIdentities(): Promise<{
  service: PortableLibp2pDeviceNetworkService;
  local: RawSeedDeviceIdentity;
  remote: RawSeedDeviceIdentity;
  attacker: RawSeedDeviceIdentity;
}> {
  const [local, remote, attacker] = await Promise.all([
    createDeviceIdentity('desktop', 'local'),
    createDeviceIdentity('mobile', 'remote'),
    createDeviceIdentity('cli', 'attacker'),
  ]);
  return {
    local,
    remote,
    attacker,
    service: new PortableLibp2pDeviceNetworkService({
      identity: local,
      authorizer: { canOpenProtocol: async () => true },
      nodeFactory: async () => {
        throw new Error('node factory must not run');
      },
    }),
  };
}

async function handlePairing(
  service: PortableLibp2pDeviceNetworkService,
  stream: Stream,
  remotePeerId: string,
): Promise<void> {
  await (service as unknown as {
    handlePairingStream(stream: Stream, remotePeerId: string): Promise<void>;
  }).handlePairingStream(stream, remotePeerId);
}

function privateMap(service: PortableLibp2pDeviceNetworkService, key: string): Map<unknown, unknown> {
  return Reflect.get(service, key) as Map<unknown, unknown>;
}

describe('portable local pairing hardening', () => {
  it('accepts a circuit relay address only when the invited device is the final PeerId', async () => {
    const { service, remote, attacker: relay } = await serviceWithIdentities();
    const address = `/ip4/127.0.0.1/tcp/41001/p2p/${relay.peerId}/p2p-circuit/p2p/${remote.peerId}`;
    const request = pairingRequest(remote, 1, {
      device: {
        ...pairingRequest(remote).device,
        multiaddrs: [address],
      },
    });
    const { stream, abort, sent } = requestStream(request);

    await handlePairing(service, stream, remote.peerId);

    expect(abort).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(await service.listPairingSessions()).toEqual([
      expect.objectContaining({ remotePeerId: remote.peerId, remoteMultiaddrs: [address] }),
    ]);
  });

  it.each([
    ['unknown top-level key', (request: PairingRequest) => ({ ...request, extra: true })],
    ['unsafe timestamp', (request: PairingRequest) => ({ ...request, createdAt: Number.MAX_VALUE })],
    ['overlong lifetime', (request: PairingRequest) => ({ ...request, expiresAt: request.createdAt + 5 * 60_000 + 1 })],
    ['invalid nonce', (request: PairingRequest) => ({ ...request, requestNonce: 'not-a-nonce' })],
    ['unbounded capabilities', (request: PairingRequest) => ({
      ...request,
      device: { ...request.device, capabilities: { ...capabilities, tools: Array(257).fill('tool') } },
    })],
  ])('rejects %s before persistence and aborts the stream once', async (_label, mutate) => {
    const { service, remote } = await serviceWithIdentities();
    const { stream, abort } = requestStream(mutate(pairingRequest(remote)));

    await expect(handlePairing(service, stream, remote.peerId)).rejects.toThrow(
      'invalid_pairing_request',
    );

    expect(abort).toHaveBeenCalledOnce();
    expect(privateMap(service, 'pairingSessions').size).toBe(0);
    expect(privateMap(service, 'discoveredDevices').size).toBe(0);
  });

  it('rejects a request address bound to another PeerId before persistence', async () => {
    const { service, remote, attacker } = await serviceWithIdentities();
    const request = pairingRequest(remote, 1, {
      device: {
        ...pairingRequest(remote).device,
        multiaddrs: [`/ip4/127.0.0.1/tcp/41001/p2p/${attacker.peerId}`],
      },
    });
    const { stream, abort } = requestStream(request);

    await expect(handlePairing(service, stream, remote.peerId)).rejects.toThrow(
      'invalid_pairing_request',
    );
    expect(abort).toHaveBeenCalledOnce();
    expect(privateMap(service, 'pairingSessions').size).toBe(0);
  });

  it('bounds 1000 valid pending requests without growing session or discovery memory', async () => {
    const { service, remote } = await serviceWithIdentities();
    let rejected = 0;
    for (let index = 1; index <= 1_000; index += 1) {
      const { stream } = requestStream(pairingRequest(remote, index));
      try {
        await handlePairing(service, stream, remote.peerId);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('pairing_pending_peer_limit');
        rejected += 1;
      }
    }

    expect(rejected).toBe(996);
    expect(privateMap(service, 'pairingSessions').size).toBe(4);
    expect(privateMap(service, 'pairingAdmissions').size).toBe(0);
    expect(privateMap(service, 'pairingChallenges').size).toBe(4);
    expect(privateMap(service, 'discoveredDevices').size).toBe(1);
  });

  it('rejects duplicate session and nonce challenges without replacing state', async () => {
    const { service, remote } = await serviceWithIdentities();
    const first = pairingRequest(remote, 1);
    await handlePairing(service, requestStream(first).stream, remote.peerId);

    const sameSession = requestStream({ ...pairingRequest(remote, 2), sessionId: first.sessionId });
    await expect(handlePairing(service, sameSession.stream, remote.peerId)).rejects.toThrow(
      'pairing_session_conflict',
    );
    expect(sameSession.abort).toHaveBeenCalledOnce();

    const sameNonce = requestStream({ ...pairingRequest(remote, 2), requestNonce: first.requestNonce });
    await expect(handlePairing(service, sameNonce.stream, remote.peerId)).rejects.toThrow(
      'pairing_nonce_conflict',
    );
    expect(sameNonce.abort).toHaveBeenCalledOnce();
    expect(privateMap(service, 'pairingSessions').size).toBe(1);
  });

  it('deletes expired and stopped pairing state, including pairing-only discovery', async () => {
    const { service, remote } = await serviceWithIdentities();
    const now = Date.now();
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
    await handlePairing(service, requestStream(pairingRequest(remote, 1)).stream, remote.peerId);

    dateNow.mockReturnValue(now + 5 * 60_000 + 1);
    expect(await service.listPairingSessions()).toEqual([]);
    expect(privateMap(service, 'pairingChallenges').size).toBe(0);
    expect(privateMap(service, 'discoveredDevices').size).toBe(0);

    dateNow.mockReturnValue(now + 5 * 60_000 + 2);
    await handlePairing(service, requestStream(pairingRequest(remote, 2)).stream, remote.peerId);
    await service.stop();
    expect(privateMap(service, 'pairingSessions').size).toBe(0);
    expect(privateMap(service, 'pairingAdmissions').size).toBe(0);
    expect(privateMap(service, 'pairingChallenges').size).toBe(0);
    expect(privateMap(service, 'discoveredDevices').size).toBe(0);
    dateNow.mockRestore();
  });

  it('rejects a malicious response address and an invite address with the wrong final PeerId', async () => {
    const { service, remote, attacker } = await serviceWithIdentities();
    let resolveResponse!: (value: Uint8Array) => void;
    const responsePromise = new Promise<Uint8Array>((resolve) => {
      resolveResponse = resolve;
    });
    const abort = vi.fn();
    const stream = {
      send(chunk: Uint8Array) {
        const request = decodeFrame(chunk);
        resolveResponse(encodeJsonFrame({
          type: 'memeloop-local-pairing-response-v2',
          sessionId: request.sessionId,
          requestNonce: request.requestNonce,
          responseNonce: 'f'.repeat(32),
          accepted: true,
          expiresAt: request.expiresAt,
          device: {
            peerId: remote.peerId,
            publicKeyMultibase: remote.publicKeyMultibase,
            deviceName: remote.deviceName,
            platform: remote.platform,
            capabilities,
            multiaddrs: [`/ip4/127.0.0.1/tcp/41001/p2p/${attacker.peerId}`],
          },
        }));
      },
      close: vi.fn(async () => undefined),
      abort,
      async *[Symbol.asyncIterator]() {
        yield await responsePromise;
      },
    } as unknown as Stream;
    const dialProtocol = vi.fn(async () => stream);
    Reflect.set(service, 'libp2p', { dialProtocol, getMultiaddrs: () => [] });

    await expect(service.requestLocalPairing(remote.peerId)).rejects.toThrow(
      'invalid_pairing_response',
    );
    expect(abort).toHaveBeenCalledOnce();
    expect(privateMap(service, 'pairingSessions').size).toBe(0);
    expect(privateMap(service, 'discoveredDevices').size).toBe(0);

    await expect(service.requestLocalPairing(remote.peerId, {
      multiaddrs: [`/ip4/127.0.0.1/tcp/41001/p2p/${attacker.peerId}`],
    })).rejects.toThrow('pairing_address_peer_id_mismatch');
    expect(dialProtocol).toHaveBeenCalledOnce();
    expect(privateMap(service, 'pairingAdmissions').size).toBe(0);
  });
});
