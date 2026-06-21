import { describe, expect, it, vi } from 'vitest';

import { createDeviceIdentity, Libp2pDeviceNetworkService } from '../libp2pDeviceNetworkService.js';
import type { DeviceTrustStore, TrustedDeviceRecord } from '../types.js';

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
    await expect(service.syncWithDevice('peer-from-store')).resolves.toMatchObject({
      ok: true,
      peerId: 'peer-from-store',
    });
    await service.stop();
  });

  it('persists accepted and removed local pairing records', async () => {
    const identity = await createDeviceIdentity('cli', 'local');
    const store = createMemoryTrustStore();
    const service = new Libp2pDeviceNetworkService({ identity, trustStore: store });
    const session = await service.requestLocalPairing('peer-to-persist');

    await service.acceptPairing(session.sessionId);
    expect(store.saveTrustedDevice).toHaveBeenCalledWith(expect.objectContaining({
      peerId: 'peer-to-persist',
      trustMode: 'local-pairing',
    }));

    await service.removeTrustedDevice('peer-to-persist');
    expect(store.removeTrustedDevice).toHaveBeenCalledWith('peer-to-persist');
  });
});
