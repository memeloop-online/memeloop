import { describe, expect, it, vi } from 'vitest';

import { syncCloudDevices } from '../syncCloudDevices.js';
import type { CloudDeviceClient, CloudDeviceRecord, DeviceTrustStore, TrustedDeviceRecord } from '../types.js';

function mockCloudClient(devices: CloudDeviceRecord[]): CloudDeviceClient {
  return {
    listDevices: vi.fn(async () => devices),
    getConnectionGrantPublicKey: vi.fn(),
    createConnectionGrant: vi.fn(),
    createRelayReservation: vi.fn(),
    createBindingNonce: vi.fn(),
    registerDevice: vi.fn(),
    heartbeat: vi.fn(),
  };
}

function mockTrustStore(initial: TrustedDeviceRecord[] = []): DeviceTrustStore & { records: Map<string, TrustedDeviceRecord> } {
  const records = new Map(initial.map((r) => [r.peerId, r]));
  return {
    records,
    loadTrustedDevices: vi.fn(async () => [...records.values()]),
    saveTrustedDevice: vi.fn(async (record: TrustedDeviceRecord) => {
      records.set(record.peerId, record);
    }),
    removeTrustedDevice: vi.fn(async (peerId: string) => {
      records.delete(peerId);
    }),
  };
}

function makeCloudDevice(overrides: Partial<CloudDeviceRecord> = {}): CloudDeviceRecord {
  return {
    accountId: 'account-1',
    peerId: 'peer-1',
    publicKeyMultibase: 'libp2p-pub:test-key',
    deviceName: 'Cloud Device',
    platform: 'desktop',
    capabilities: { tools: [], mcpServers: [], hasWiki: false, imChannels: [], wikis: [] },
    multiaddrs: [],
    relayReservations: [],
    lastSeen: 1000,
    ...overrides,
  };
}

describe('syncCloudDevices', () => {
  it('saves new cloud devices into empty trust store', async () => {
    const cloud = mockCloudClient([
      makeCloudDevice({ peerId: 'peer-a', deviceName: 'Device A' }),
      makeCloudDevice({ peerId: 'peer-b', deviceName: 'Device B' }),
    ]);
    const store = mockTrustStore();

    const result = await syncCloudDevices({ cloudClient: cloud, trustStore: store });

    expect(result).toHaveLength(2);
    expect(store.records.get('peer-a')).toMatchObject({
      peerId: 'peer-a',
      deviceName: 'Device A',
      trustMode: 'cloud-account',
      accountId: 'account-1',
    });
    expect(store.records.get('peer-b')).toMatchObject({
      peerId: 'peer-b',
      deviceName: 'Device B',
      trustMode: 'cloud-account',
    });
  });

  it('persists mutable cloud directory updates', async () => {
    const existing: TrustedDeviceRecord = {
      peerId: 'peer-1',
      publicKeyMultibase: 'libp2p-pub:test-key',
      deviceName: 'Cloud Device',
      platform: 'desktop',
      trustMode: 'cloud-account',
      accountId: 'account-1',
      createdAt: 500,
      lastSeen: 500,
    };
    const cloud = mockCloudClient([makeCloudDevice({ lastSeen: 1000 })]);
    const store = mockTrustStore([existing]);

    await syncCloudDevices({ cloudClient: cloud, trustStore: store });

    expect(store.saveTrustedDevice).toHaveBeenCalledTimes(1);
    expect(store.records.get('peer-1')?.lastSeen).toBe(1000);
  });

  it('updates trust store when device name or key changes', async () => {
    const existing: TrustedDeviceRecord = {
      peerId: 'peer-1',
      publicKeyMultibase: 'libp2p-pub:old-key',
      deviceName: 'Old Name',
      platform: 'desktop',
      trustMode: 'cloud-account',
      accountId: 'account-1',
      createdAt: 500,
      lastSeen: 500,
    };
    const cloud = mockCloudClient([makeCloudDevice({
      publicKeyMultibase: 'libp2p-pub:new-key',
      deviceName: 'New Name',
      lastSeen: 1000,
    })]);
    const store = mockTrustStore([existing]);
    const logger = { warn: vi.fn() };

    await syncCloudDevices({ cloudClient: cloud, logger, trustStore: store });

    expect(store.saveTrustedDevice).toHaveBeenCalledTimes(1);
    expect(store.records.get('peer-1')?.deviceName).toBe('New Name');
    expect(store.records.get('peer-1')?.publicKeyMultibase).toBe('libp2p-pub:new-key');
    expect(logger.warn).toHaveBeenCalledWith(
      '[device-network] Cloud directory rotated a cloud-account device public key',
      { accountId: 'account-1', peerId: 'peer-1' },
    );
  });

  it('warns through the default logger when a cloud-account key rotates', async () => {
    const existing: TrustedDeviceRecord = {
      peerId: 'peer-1',
      publicKeyMultibase: 'libp2p-pub:old-key',
      deviceName: 'Cloud Device',
      platform: 'desktop',
      trustMode: 'cloud-account',
      accountId: 'account-1',
      createdAt: 500,
    };
    const cloud = mockCloudClient([makeCloudDevice({
      publicKeyMultibase: 'libp2p-pub:new-key',
    })]);
    const store = mockTrustStore([existing]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await syncCloudDevices({ cloudClient: cloud, trustStore: store });

    expect(warn).toHaveBeenCalledWith(
      '[device-network] Cloud directory rotated a cloud-account device public key',
      { accountId: 'account-1', peerId: 'peer-1' },
    );
    warn.mockRestore();
  });

  it('returns empty list when cloud has no devices', async () => {
    const cloud = mockCloudClient([]);
    const store = mockTrustStore();

    const result = await syncCloudDevices({ cloudClient: cloud, trustStore: store });

    expect(result).toEqual([]);
    expect(store.saveTrustedDevice).not.toHaveBeenCalled();
  });

  it('removes cloud-account records that disappear from the visible directory', async () => {
    const staleCloudRecord: TrustedDeviceRecord = {
      peerId: 'revoked-peer',
      publicKeyMultibase: 'libp2p-pub:revoked',
      deviceName: 'Revoked Peer',
      platform: 'desktop',
      trustMode: 'cloud-account',
      accountId: 'account-1',
      createdAt: 100,
    };
    const localPairingRecord: TrustedDeviceRecord = {
      ...staleCloudRecord,
      peerId: 'local-peer',
      trustMode: 'local-pairing',
    };
    const cloud = mockCloudClient([]);
    const store = mockTrustStore([staleCloudRecord, localPairingRecord]);

    await expect(syncCloudDevices({ cloudClient: cloud, trustStore: store })).resolves.toEqual([]);

    expect(store.records.has('revoked-peer')).toBe(false);
    expect(store.records.get('local-peer')).toEqual(localPairingRecord);
  });

  it('filters explicit revoked records and removes their stale cloud trust', async () => {
    const stale: TrustedDeviceRecord = {
      peerId: 'peer-1',
      publicKeyMultibase: 'libp2p-pub:test-key',
      deviceName: 'Cloud Device',
      platform: 'desktop',
      trustMode: 'cloud-account',
      accountId: 'account-1',
      createdAt: 100,
    };
    const cloud = mockCloudClient([makeCloudDevice({ revokedAt: 2_000 })]);
    const store = mockTrustStore([stale]);

    await expect(syncCloudDevices({ cloudClient: cloud, trustStore: store })).resolves.toEqual([]);
    expect(store.records.has('peer-1')).toBe(false);
  });

  it('persists local-pairing device alongside new cloud device', async () => {
    const localPairingRecord: TrustedDeviceRecord = {
      peerId: 'local-pair',
      publicKeyMultibase: 'libp2p-pub:local',
      deviceName: 'Local Peer',
      platform: 'mobile',
      trustMode: 'local-pairing',
      createdAt: 100,
    };
    const cloud = mockCloudClient([makeCloudDevice({ peerId: 'cloud-peer' })]);
    const store = mockTrustStore([localPairingRecord]);

    await syncCloudDevices({ cloudClient: cloud, trustStore: store });

    expect(store.records.get('local-pair')).toEqual(localPairingRecord);
    expect(store.records.get('cloud-peer')).toMatchObject({ trustMode: 'cloud-account' });
  });

  it('never replaces local pairing trust with cloud directory metadata', async () => {
    const localPairingRecord: TrustedDeviceRecord = {
      peerId: 'peer-1',
      publicKeyMultibase: 'libp2p-pub:locally-confirmed',
      deviceName: 'Locally Confirmed',
      platform: 'mobile',
      trustMode: 'local-pairing',
      createdAt: 100,
    };
    const cloud = mockCloudClient([makeCloudDevice({
      publicKeyMultibase: 'libp2p-pub:cloud-rotated',
      deviceName: 'Cloud Name',
    })]);
    const store = mockTrustStore([localPairingRecord]);

    await syncCloudDevices({ cloudClient: cloud, trustStore: store });

    expect(store.saveTrustedDevice).not.toHaveBeenCalled();
    expect(store.records.get('peer-1')).toEqual(localPairingRecord);
  });
});
