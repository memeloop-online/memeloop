import { describe, expect, it, vi } from 'vitest';

import { cloudRecordToDevice, reconcileCloudDeviceDirectory } from '../reconcileCloudDeviceDirectory.js';
import type { CloudDeviceRecord, DeviceTrustStore, TrustedDeviceRecord } from '../types.js';

const capabilities = {
  tools: [],
  mcpServers: [],
  hasWiki: false,
  imChannels: [],
  wikis: [],
};

function trusted(peerId: string, trustMode: TrustedDeviceRecord['trustMode']): TrustedDeviceRecord {
  return {
    peerId,
    publicKeyMultibase: `key-${peerId}`,
    deviceName: peerId,
    platform: 'desktop',
    trustMode,
    accountId: trustMode === 'cloud-account' ? 'account-1' : undefined,
    createdAt: 1,
  };
}

function cloud(peerId: string, overrides: Partial<CloudDeviceRecord> = {}): CloudDeviceRecord {
  return {
    accountId: 'account-1',
    peerId,
    publicKeyMultibase: `key-${peerId}`,
    deviceName: peerId,
    platform: 'desktop',
    capabilities,
    multiaddrs: ['/ip4/192.168.1.20/tcp/4001', ' '],
    relayReservations: [
      '/dns4/relay.example.test/tcp/443/wss/p2p/relay/p2p-circuit',
      '/dns4/relay.example.test/tcp/443/wss/p2p/relay/p2p-circuit',
    ],
    lastSeen: 1_000,
    ...overrides,
  };
}

describe('reconcileCloudDeviceDirectory', () => {
  it('preserves local pairing while injecting and removing only the Cloud live overlay', async () => {
    let records = [trusted('local-peer', 'local-pairing'), trusted('stale-peer', 'cloud-account')];
    const trustStore: DeviceTrustStore = {
      loadTrustedDevices: vi.fn(async () => [...records]),
      saveTrustedDevice: vi.fn(async (record) => {
        records = records.filter(current => current.peerId !== record.peerId);
        records.push(record);
      }),
      removeTrustedDevice: vi.fn(async (peerId) => {
        records = records.filter(record => record.peerId !== peerId);
      }),
    };
    const liveDirectory = {
      listCloudDeviceAddressPeerIds: vi.fn(async () => ['local-peer', 'stale-live-peer']),
      setCloudDeviceAddresses: vi.fn(),
      removeCloudDeviceAddresses: vi.fn(),
      upsertCloudDiscoveredDevice: vi.fn(),
      removeCloudDiscoveredDevice: vi.fn(),
      upsertCloudTrustedDevice: vi.fn(),
      removeCloudTrustedDevice: vi.fn(),
    };

    const result = await reconcileCloudDeviceDirectory({
      cloudDevices: [
        cloud('self-peer'),
        cloud('local-peer', { publicKeyMultibase: 'cloud-must-not-rotate-local-key' }),
        cloud('cloud-peer'),
        cloud('revoked-peer', { revokedAt: 999 }),
      ],
      excludePeerIds: ['self-peer'],
      liveDirectory,
      now: () => 1_000,
      trustStore,
    });

    expect(result.cloudDevices.map(device => device.peerId)).toEqual(['local-peer', 'cloud-peer']);
    expect(result.removedPeerIds).toEqual(['stale-peer', 'stale-live-peer']);
    expect(trustStore.removeTrustedDevice).toHaveBeenCalledWith('stale-peer');
    expect(liveDirectory.removeCloudTrustedDevice).toHaveBeenCalledWith('stale-peer');
    expect(liveDirectory.removeCloudDeviceAddresses).toHaveBeenCalledWith('stale-peer');
    expect(liveDirectory.removeCloudDeviceAddresses).toHaveBeenCalledWith('stale-live-peer');
    expect(liveDirectory.removeCloudDiscoveredDevice).toHaveBeenCalledWith('stale-peer');
    expect(trustStore.saveTrustedDevice).toHaveBeenCalledTimes(1);
    expect(trustStore.saveTrustedDevice).toHaveBeenCalledWith(expect.objectContaining({
      peerId: 'cloud-peer',
      trustMode: 'cloud-account',
    }));
    expect(records.find(record => record.peerId === 'local-peer')).toMatchObject({
      publicKeyMultibase: 'key-local-peer',
      trustMode: 'local-pairing',
    });
    expect(liveDirectory.setCloudDeviceAddresses).toHaveBeenCalledWith('local-peer', [
      '/ip4/192.168.1.20/tcp/4001',
      '/dns4/relay.example.test/tcp/443/wss/p2p/relay/p2p-circuit',
    ]);
    expect(liveDirectory.upsertCloudDiscoveredDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        peerId: 'local-peer',
        trustMode: 'local-pairing',
        reachability: { state: 'online', paths: ['direct', 'relay'] },
      }),
    );
  });

  it('marks stale records offline without retaining stale dial paths', () => {
    expect(cloudRecordToDevice(cloud('peer-1', { lastSeen: 1 }), 'cloud-account', 1_000, 100))
      .toMatchObject({
        reachability: { state: 'offline', paths: [] },
        multiaddrs: [
          '/ip4/192.168.1.20/tcp/4001',
          '/dns4/relay.example.test/tcp/443/wss/p2p/relay/p2p-circuit',
        ],
      });
  });

  it('rejects duplicate peer records instead of applying an ambiguous key rotation', async () => {
    const trustStore: DeviceTrustStore = {
      loadTrustedDevices: vi.fn(async () => []),
      saveTrustedDevice: vi.fn(),
      removeTrustedDevice: vi.fn(),
    };
    await expect(reconcileCloudDeviceDirectory({
      cloudDevices: [cloud('peer-1'), cloud('peer-1', { publicKeyMultibase: 'other-key' })],
      liveDirectory: {
        listCloudDeviceAddressPeerIds: vi.fn(async () => []),
        setCloudDeviceAddresses: vi.fn(),
        removeCloudDeviceAddresses: vi.fn(),
      },
      trustStore,
    })).rejects.toThrow('cloud_directory_duplicate_peer');
  });
});
