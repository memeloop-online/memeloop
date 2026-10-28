import type { Ed25519PrivateKey, Libp2p } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { describe, expect, it, vi } from 'vitest';

import type { DeviceCloudCommitFence, DeviceRelayReservationToken, LocalDeviceIdentity } from 'memeloop';
import {
  buildDeviceRelayReservationTokenMessage,
  createDeviceIdentity,
  type Libp2pNodeFactoryOptions,
  PortableLibp2pDeviceNetworkService,
} from '../portableLibp2pDeviceNetworkService.js';

async function signingKey(seedByte = 41): Promise<{
  privateKey: Ed25519PrivateKey;
  publicKeyMultibase: string;
}> {
  const { generateKeyPairFromSeed, publicKeyToProtobuf } = await import('@libp2p/crypto/keys');
  const { toString } = await import('uint8arrays');
  const privateKey = await generateKeyPairFromSeed('Ed25519', new Uint8Array(32).fill(seedByte));
  return {
    privateKey,
    publicKeyMultibase: `libp2p-pub:${toString(publicKeyToProtobuf(privateKey.publicKey), 'base64url')}`,
  };
}

async function signedToken(input: {
  peerId: string;
  relayMultiaddrs: string[];
  bootstrapMultiaddrs?: string[];
  issuedAt?: number;
  expiresAt?: number;
  seedByte?: number;
}): Promise<DeviceRelayReservationToken> {
  const { toString } = await import('uint8arrays');
  const { privateKey } = await signingKey(input.seedByte);
  const unsigned = {
    issuer: 'memeloop-cloud' as const,
    accountId: 'account-1',
    peerId: input.peerId,
    relayMultiaddrs: input.relayMultiaddrs,
    bootstrapMultiaddrs: input.bootstrapMultiaddrs ?? input.relayMultiaddrs,
    issuedAt: input.issuedAt ?? 1_000,
    expiresAt: input.expiresAt ?? 60_000,
  };
  return {
    ...unsigned,
    signature: toString(
      await privateKey.sign(buildDeviceRelayReservationTokenMessage(unsigned)),
      'base64url',
    ),
  };
}

function fakeNode(identity: LocalDeviceIdentity): Libp2p {
  const node = {
    peerId: peerIdFromString(identity.peerId),
    status: 'stopped',
    addEventListener: vi.fn(),
    handle: vi.fn(async () => undefined),
    start: vi.fn(async () => {
      node.status = 'started';
    }),
    stop: vi.fn(async () => {
      node.status = 'stopped';
    }),
    getMultiaddrs: vi.fn(() => []),
    dial: vi.fn(async () => undefined),
    hangUp: vi.fn(async () => undefined),
  };
  return node as unknown as Libp2p;
}

function createService(input: {
  identity: LocalDeviceIdentity;
  key: () => string | undefined;
  now: () => number;
  nodeFactory?: (options: Libp2pNodeFactoryOptions) => Promise<Libp2p>;
}): PortableLibp2pDeviceNetworkService {
  return new PortableLibp2pDeviceNetworkService({
    identity: input.identity,
    relayReservationVerification: {
      getVerificationPublicKeyMultibase: input.key,
      reservationTtlMs: 9_000,
      reservationSafetyMarginMs: 1_000,
      now: input.now,
    },
    nodeFactory: input.nodeFactory ?? (async () => fakeNode(input.identity)),
  });
}

function generationContext(generation = 1): {
  controller: AbortController;
  fence: DeviceCloudCommitFence;
  makeStale(): void;
} {
  const controller = new AbortController();
  let current = true;
  const fence = {
    generation,
    signal: controller.signal,
    isCurrent: () => current && !controller.signal.aborted,
    throwIfStale: () => {
      if (!current || controller.signal.aborted) throw new Error('stale_generation');
    },
    commitSynchronous: (operation: () => unknown) => {
      if (!current || controller.signal.aborted) return false;
      operation();
      return true;
    },
  } as DeviceCloudCommitFence;
  return {
    controller,
    fence,
    makeStale: () => {
      current = false;
      controller.abort(new Error('stale_generation'));
    },
  };
}

async function configureRelayReservation(
  service: PortableLibp2pDeviceNetworkService,
  token: DeviceRelayReservationToken,
  context = generationContext(),
): Promise<void> {
  await service.configureRelayReservation(token, context.controller.signal, context.fence);
}

describe('portable relay reservation validation', () => {
  it('rejects missing keys, forged signatures, wrong subjects, and insufficient lifetimes locally', async () => {
    const local = await createDeviceIdentity('cli', 'local');
    const relay = await createDeviceIdentity('cli', 'relay');
    const relayAddress = `/ip4/127.0.0.1/tcp/4001/p2p/${relay.peerId}`;
    const { publicKeyMultibase } = await signingKey();
    const token = await signedToken({ peerId: local.peerId, relayMultiaddrs: [relayAddress] });
    const service = createService({
      identity: local,
      key: () => publicKeyMultibase,
      now: () => 2_000,
    });

    const signalGeneration = generationContext(1);
    const mismatchedFenceGeneration = generationContext(2);
    await expect(service.configureRelayReservation(
      token,
      signalGeneration.controller.signal,
      mismatchedFenceGeneration.fence,
    )).rejects.toThrow('relay_generation_signal_mismatch');

    await expect(
      configureRelayReservation(
        createService({
          identity: local,
          key: () => undefined,
          now: () => 2_000,
        }),
        token,
      ),
    ).rejects.toThrow('relay_admission_verification_key_unavailable');

    await expect(configureRelayReservation(service, {
      ...token,
      signature: `${token.signature}tampered`,
    })).rejects.toThrow('invalid_relay_reservation_token');
    await expect(configureRelayReservation(
      service,
      await signedToken({
        peerId: relay.peerId,
        relayMultiaddrs: [relayAddress],
      }),
    )).rejects.toThrow('invalid_relay_reservation_token');
    await expect(configureRelayReservation(
      service,
      await signedToken({
        peerId: local.peerId,
        relayMultiaddrs: [relayAddress],
        expiresAt: 11_999,
      }),
    )).rejects.toThrow('relay_reservation_token_ttl_insufficient');
  });

  it('binds every relay multiaddr to one direct relay PeerId audience', async () => {
    const local = await createDeviceIdentity('cli', 'local');
    const relayA = await createDeviceIdentity('cli', 'relay-a');
    const relayB = await createDeviceIdentity('cli', 'relay-b');
    const { publicKeyMultibase } = await signingKey();
    const service = createService({
      identity: local,
      key: () => publicKeyMultibase,
      now: () => 2_000,
    });

    await expect(configureRelayReservation(
      service,
      await signedToken({
        peerId: local.peerId,
        relayMultiaddrs: [
          `/ip4/127.0.0.1/tcp/4001/p2p/${relayA.peerId}`,
          `/ip4/127.0.0.1/tcp/4002/p2p/${relayB.peerId}`,
        ],
      }),
    )).rejects.toThrow('relay_reservation_token_audience_invalid');
    await expect(configureRelayReservation(
      service,
      await signedToken({
        peerId: local.peerId,
        relayMultiaddrs: [
          `/ip4/127.0.0.1/tcp/4001/p2p/${relayA.peerId}/p2p-circuit`,
        ],
      }),
    )).rejects.toThrow('relay_reservation_token_audience_invalid');
  });

  it('caches a locally verified pre-start token and applies it only while it covers a full reservation', async () => {
    const local = await createDeviceIdentity('cli', 'local');
    const relay = await createDeviceIdentity('cli', 'relay');
    const relayAddress = `/ip4/127.0.0.1/tcp/4001/p2p/${relay.peerId}`;
    const { publicKeyMultibase } = await signingKey();
    let now = 2_000;
    const factoryOptions: Libp2pNodeFactoryOptions[] = [];
    const service = createService({
      identity: local,
      key: () => publicKeyMultibase,
      now: () => now,
      nodeFactory: async (options) => {
        factoryOptions.push(options);
        return fakeNode(local);
      },
    });
    const internals = service as unknown as {
      admitRelayReservation: (
        token: DeviceRelayReservationToken,
        signal: AbortSignal,
        fence: DeviceCloudCommitFence,
      ) => Promise<void>;
      reserveRelayListeners: (
        addresses: string[],
        signal: AbortSignal,
        fence: DeviceCloudCommitFence,
        effects: unknown,
      ) => Promise<void>;
    };
    const admit = vi.spyOn(internals, 'admitRelayReservation').mockResolvedValue(undefined);
    const reserve = vi.spyOn(internals, 'reserveRelayListeners').mockResolvedValue(undefined);
    const token = await signedToken({
      peerId: local.peerId,
      relayMultiaddrs: [relayAddress],
      expiresAt: 20_000,
    });

    const context = generationContext();
    await configureRelayReservation(service, token, context);
    await service.start();
    expect(factoryOptions[0]?.bootstrapMultiaddrs).toContain(relayAddress);
    expect(admit).toHaveBeenCalledWith(token, context.controller.signal, context.fence);
    expect(reserve).toHaveBeenCalledWith(
      [relayAddress],
      context.controller.signal,
      context.fence,
      expect.any(Object),
    );
    await service.stop();

    admit.mockClear();
    reserve.mockClear();
    now = 11_000;
    await service.start();
    expect(factoryOptions[1]?.bootstrapMultiaddrs).not.toContain(relayAddress);
    expect(admit).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    await service.stop();
  });

  it('rolls back a hostile delayed generation before a replacement can own relay state', async () => {
    const local = await createDeviceIdentity('cli', 'local');
    const relay = await createDeviceIdentity('cli', 'relay');
    const relayAddress = `/ip4/127.0.0.1/tcp/4001/p2p/${relay.peerId}`;
    const { publicKeyMultibase } = await signingKey();
    const service = createService({
      identity: local,
      key: () => publicKeyMultibase,
      now: () => 2_000,
    });
    await service.start();

    type TestEffects = {
      bootstrapMultiaddrs: Set<string>;
      relayMultiaddrs: Set<string>;
      listeners: Set<{ close(): Promise<void> }>;
    };
    const listenerA = { close: vi.fn(async () => undefined) };
    const listenerB = { close: vi.fn(async () => undefined) };
    let releaseA!: () => void;
    let markAStarted!: () => void;
    const aRelease = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const aStarted = new Promise<void>((resolve) => {
      markAStarted = resolve;
    });
    const tokenA = await signedToken({
      peerId: local.peerId,
      relayMultiaddrs: [relayAddress],
      expiresAt: 20_000,
    });
    const tokenB = await signedToken({
      peerId: local.peerId,
      relayMultiaddrs: [relayAddress],
      expiresAt: 21_000,
    });
    const internals = service as unknown as {
      applyRelayReservation(
        verified: { token: DeviceRelayReservationToken },
        signal: AbortSignal,
        fence: DeviceCloudCommitFence,
      ): Promise<TestEffects>;
      verifiedRelayReservation?: { token: DeviceRelayReservationToken };
    };
    vi.spyOn(internals, 'applyRelayReservation').mockImplementation(async (verified) => {
      if (verified.token === tokenA) {
        markAStarted();
        await aRelease;
        return {
          bootstrapMultiaddrs: new Set(),
          relayMultiaddrs: new Set([relayAddress]),
          listeners: new Set([listenerA]),
        };
      }
      return {
        bootstrapMultiaddrs: new Set(),
        relayMultiaddrs: new Set([relayAddress]),
        listeners: new Set([listenerB]),
      };
    });

    const generationA = generationContext(1);
    const configuringA = configureRelayReservation(service, tokenA, generationA);
    await aStarted;
    generationA.makeStale();
    releaseA();
    await expect(configuringA).rejects.toThrow('stale_generation');
    expect(listenerA.close).toHaveBeenCalledOnce();
    expect(internals.verifiedRelayReservation).toBeUndefined();

    const generationB = generationContext(2);
    await configureRelayReservation(service, tokenB, generationB);
    expect(internals.verifiedRelayReservation?.token).toBe(tokenB);
    expect(listenerB.close).not.toHaveBeenCalled();

    await service.clearRelayReservation();
    expect(listenerB.close).toHaveBeenCalledOnce();
    expect(internals.verifiedRelayReservation).toBeUndefined();
    await service.stop();
  });
});
