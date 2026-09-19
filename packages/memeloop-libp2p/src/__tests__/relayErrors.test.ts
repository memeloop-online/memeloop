import { describe, expect, it, vi } from 'vitest';

import type { DeviceCloudCommitFence, DeviceRelayReservationToken } from 'memeloop';
import { PortableLibp2pDeviceNetworkService } from '../portableLibp2pDeviceNetworkService.js';

interface RelayServiceInternals {
  libp2p: unknown;
  admitRelayReservation(
    token: DeviceRelayReservationToken,
    signal: AbortSignal,
    fence: DeviceCloudCommitFence,
  ): Promise<void>;
  reserveRelayListeners(
    addresses: string[],
    signal: AbortSignal,
    fence: DeviceCloudCommitFence,
    effects: { bootstrapMultiaddrs: Set<string>; relayMultiaddrs: Set<string>; listeners: Set<unknown> },
  ): Promise<void>;
}

function currentFence(signal: AbortSignal): DeviceCloudCommitFence {
  return {
    generation: 1,
    signal,
    isCurrent: () => true,
    throwIfStale: () => {
      signal.throwIfAborted();
    },
    commitSynchronous: ((operation: () => unknown) => {
      operation();
      return true;
    }) as DeviceCloudCommitFence['commitSynchronous'],
  };
}

function emptyEffects() {
  return {
    bootstrapMultiaddrs: new Set<string>(),
    relayMultiaddrs: new Set<string>(),
    listeners: new Set<unknown>(),
  };
}

function createService(): PortableLibp2pDeviceNetworkService {
  return new PortableLibp2pDeviceNetworkService({
    identity: {
      peerId: 'local-peer',
      publicKeyMultibase: 'libp2p-pub:test',
      privateKeyRef: 'seed',
      privateKeyRawSeedBase64Url: 'seed',
      createdAt: 1,
      deviceName: 'local',
      platform: 'cli',
    },
    nodeFactory: async () => {
      throw new Error('not_used');
    },
  });
}

function relayToken(address: string): DeviceRelayReservationToken {
  return {
    issuer: 'memeloop-cloud',
    accountId: 'account-1',
    peerId: 'local-peer',
    relayMultiaddrs: [address],
    bootstrapMultiaddrs: [],
    issuedAt: 1,
    expiresAt: 2,
    signature: 'signature',
  };
}

async function expectStableError(
  promise: Promise<void>,
  code: string,
  diagnostic: string,
): Promise<void> {
  const error = await promise.catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(code);
  expect((error as Error).cause).toBeInstanceOf(AggregateError);
  const aggregate = (error as Error).cause as AggregateError;
  expect(aggregate.errors).toContainEqual(
    expect.objectContaining({ message: expect.stringContaining(diagnostic) }),
  );
}

describe('relay failure errors', () => {
  it('keeps relay admission error messages stable and retains diagnostics in cause', async () => {
    const service = createService() as unknown as RelayServiceInternals;
    service.libp2p = {
      dialProtocol: vi.fn(async () => {
        throw new Error('dial target unavailable');
      }),
    };
    const address = '/ip4/127.0.0.1/tcp/4001';
    const signal = new AbortController().signal;

    await expectStableError(
      service.admitRelayReservation(relayToken(address), signal, currentFence(signal)),
      'relay_admission_failed',
      `${address}: relay_admission_dial_failed`,
    );
  });

  it('keeps relay reservation error messages stable and retains diagnostics in cause', async () => {
    const service = createService() as unknown as RelayServiceInternals;
    service.libp2p = {
      components: {
        transportManager: {
          getListeners: vi.fn(() => []),
          listen: vi.fn(async () => {
            throw new Error('reservation rejected');
          }),
        },
      },
    };
    const address = '/ip4/127.0.0.1/tcp/4001';
    const signal = new AbortController().signal;

    await expectStableError(
      service.reserveRelayListeners(
        [address],
        signal,
        currentFence(signal),
        emptyEffects(),
      ),
      'relay_reservation_failed',
      `${address} (attempt 1/3): reservation rejected`,
    );
  });
});
