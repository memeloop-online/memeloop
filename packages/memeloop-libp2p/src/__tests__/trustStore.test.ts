import { describe, expect, it, vi } from 'vitest';

import type { DeviceTrustStore, TrustedDeviceRecord } from 'memeloop';
import { createDeviceIdentity, Libp2pDeviceNetworkService } from '../libp2pDeviceNetworkService.js';

function createMemoryTrustStore(initial: TrustedDeviceRecord[] = []): DeviceTrustStore & {
  records: Map<string, TrustedDeviceRecord>;
  saveTrustedDevice: ReturnType<typeof vi.fn>;
  removeTrustedDevice: ReturnType<typeof vi.fn>;
} {
  const records = new Map(initial.map((record) => [record.peerId, record]));
  return {
    records,
    loadTrustedDevices: async () => [...records.values()],
    saveTrustedDevice: vi.fn(async (record: TrustedDeviceRecord) => {
      records.set(record.peerId, record);
    }),
    removeTrustedDevice: vi.fn(async (peerId: string) => {
      records.delete(peerId);
    }),
  };
}

describe('Libp2pDeviceNetworkService trust store', () => {
  it('loads trusted devices from the trust store before authorizing sync', async () => {
    const identity = await createDeviceIdentity('cli', 'local');
    const store = createMemoryTrustStore([{
      peerId: 'peer-from-store',
      publicKeyMultibase: 'libp2p-pub:test',
      deviceName: 'stored peer',
      platform: 'cli',
      trustMode: 'local-pairing',
      createdAt: 1,
    }]);
    const service = new Libp2pDeviceNetworkService({
      identity,
      trustStore: store,
      enableMdns: false,
      listen: { addresses: [] },
    });

    await service.start();
    await expect(service.listDevices()).resolves.toContainEqual(expect.objectContaining({
      peerId: 'peer-from-store',
      displayName: 'stored peer',
      trusted: true,
      reachability: { state: 'offline', paths: [] },
    }));
    await expect(service.syncWithDevice('peer-from-store')).rejects.toThrow(
      'sync_storage_not_configured',
    );
    await service.stop();
  });

  it('persists removed local pairing records', async () => {
    const identity = await createDeviceIdentity('cli', 'local');
    const store = createMemoryTrustStore([{
      peerId: 'peer-to-persist',
      publicKeyMultibase: 'libp2p-pub:test',
      deviceName: 'stored peer',
      platform: 'cli',
      trustMode: 'local-pairing',
      createdAt: 1,
    }]);
    const service = new Libp2pDeviceNetworkService({ identity, trustStore: store });

    await service.removeTrustedDevice('peer-to-persist');
    expect(store.removeTrustedDevice).toHaveBeenCalledWith('peer-to-persist');
  });

  it('updates in-memory trusted devices after startup', async () => {
    const identity = await createDeviceIdentity('cli', 'local');
    const store = createMemoryTrustStore();
    const service = new Libp2pDeviceNetworkService({
      identity,
      trustStore: store,
      enableMdns: false,
      listen: { addresses: [] },
    });

    await service.start();
    service.upsertTrustedDevice({
      peerId: 'cloud-peer',
      publicKeyMultibase: 'libp2p-pub:cloud',
      deviceName: 'Cloud Peer',
      platform: 'desktop',
      trustMode: 'cloud-account',
      accountId: 'account-1',
      createdAt: 1,
      lastSeen: 2,
    });

    await expect(service.listDevices()).resolves.toContainEqual(expect.objectContaining({
      peerId: 'cloud-peer',
      displayName: 'Cloud Peer',
      trustMode: 'cloud-account',
      trusted: true,
    }));
    await expect(service.syncWithDevice('cloud-peer')).rejects.toThrow('device_not_trusted');
    await service.stop();
  });
});
