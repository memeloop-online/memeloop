import { describe, expect, it, vi } from 'vitest';

import { createDeviceIdentity, Libp2pDeviceNetworkService } from '../libp2pDeviceNetworkService.js';
import type { DevicePlatform, DeviceTrustStore, TrustedDeviceRecord } from '../types.js';

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

async function startMockPeerServer(platform: DevicePlatform, deviceName: string) {
  const identity = await createDeviceIdentity(platform, deviceName);
  const trustStore = createMemoryTrustStore();
  const service = new Libp2pDeviceNetworkService({
    identity,
    trustStore,
    enableMdns: false,
    listen: { addresses: ['/ip4/127.0.0.1/tcp/0'] },
  });
  await service.start();
  return {
    identity,
    trustStore,
    service,
    multiaddrs: service.getMultiaddrs(),
    async stop() {
      await service.stop();
    },
  };
}

describe('local pairing e2e', () => {
  it('pairs with a mock peer server and persists trust on both devices', async () => {
    const mockPeer = await startMockPeerServer('mobile', 'Mock Mobile');
    const localIdentity = await createDeviceIdentity('desktop', 'Local Desktop');
    const localTrustStore = createMemoryTrustStore();
    const local = new Libp2pDeviceNetworkService({
      identity: localIdentity,
      trustStore: localTrustStore,
      enableMdns: false,
      listen: { addresses: [] },
    });
    await local.start();

    try {
      const observedInboundSessions: number[] = [];
      const unsubscribe = mockPeer.service.observePairingSessions((sessions) => {
        observedInboundSessions.push(sessions.length);
      });

      const outbound = await local.requestLocalPairing(mockPeer.identity.peerId, {
        multiaddrs: mockPeer.multiaddrs,
      });
      const inbound = (await mockPeer.service.listPairingSessions()).find((session) => session.sessionId === outbound.sessionId);

      expect(inbound).toBeDefined();
      expect(outbound.direction).toBe('outbound');
      expect(inbound?.direction).toBe('inbound');
      expect(outbound.status).toBe('pending');
      expect(inbound?.status).toBe('pending');
      expect(outbound.confirmCode).toBe(inbound?.confirmCode);
      expect(outbound.remotePublicKeyMultibase).toBe(mockPeer.identity.publicKeyMultibase);
      expect(inbound?.remotePublicKeyMultibase).toBe(localIdentity.publicKeyMultibase);
      expect(observedInboundSessions.some((count) => count > 0)).toBe(true);

      await mockPeer.service.acceptPairing(inbound!.sessionId);
      await local.acceptPairing(outbound.sessionId);

      expect(localTrustStore.records.get(mockPeer.identity.peerId)).toMatchObject({
        peerId: mockPeer.identity.peerId,
        publicKeyMultibase: mockPeer.identity.publicKeyMultibase,
        deviceName: 'Mock Mobile',
        platform: 'mobile',
        trustMode: 'local-pairing',
      });
      expect(mockPeer.trustStore.records.get(localIdentity.peerId)).toMatchObject({
        peerId: localIdentity.peerId,
        publicKeyMultibase: localIdentity.publicKeyMultibase,
        deviceName: 'Local Desktop',
        platform: 'desktop',
        trustMode: 'local-pairing',
      });

      await expect(local.syncWithDevice(mockPeer.identity.peerId)).resolves.toMatchObject({ ok: true });
      await expect(mockPeer.service.syncWithDevice(localIdentity.peerId)).resolves.toMatchObject({ ok: true });

      unsubscribe();
    } finally {
      await local.stop();
      await mockPeer.stop();
    }
  });
});
