import type { CloudDeviceRecord, DeviceTrustStore, TrustedDeviceRecord } from 'memeloop';
import { describe, expect, it, vi } from 'vitest';

import type { DeviceCloudClient } from '../cloudClient.js';
import { syncCliCloudDirectory } from '../cloudDirectory.js';

const capabilities = { tools: [], mcpServers: [], hasWiki: false, agentLoop: false, imChannels: [], wikis: [] };

function trusted(peerId: string, trustMode: TrustedDeviceRecord['trustMode']): TrustedDeviceRecord {
  return {
    peerId,
    publicKeyMultibase: `key-${peerId}`,
    deviceName: peerId,
    platform: 'cli',
    trustMode,
    createdAt: 1,
  };
}

function cloud(peerId: string): CloudDeviceRecord {
  return {
    peerId,
    accountId: 'account-1',
    publicKeyMultibase: `key-${peerId}`,
    deviceName: peerId,
    platform: 'cli',
    capabilities,
    multiaddrs: ['/ip4/127.0.0.1/tcp/4001'],
    relayReservations: ['/dns4/relay.example.test/tcp/443/wss/p2p/relay/p2p-circuit'],
    lastSeen: 2,
  };
}

describe('syncCliCloudDirectory', () => {
  it('removes disappeared Cloud trust and preserves local-pairing provenance', async () => {
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
    const client = {
      listDevices: vi.fn().mockResolvedValue([cloud('self-peer'), cloud('local-peer'), cloud('cloud-peer')]),
    } as unknown as DeviceCloudClient;
    const networkRecords = new Map(records.map(record => [record.peerId, record]));
    const network = {
      getTrustedDevice: vi.fn((peerId: string) => networkRecords.get(peerId)),
      removeTrustedDevice: vi.fn(async (peerId: string) => {
        networkRecords.delete(peerId);
      }),
      upsertTrustedDevice: vi.fn((record: TrustedDeviceRecord) => {
        networkRecords.set(record.peerId, record);
      }),
      upsertDiscoveredDevice: vi.fn(),
    };

    await expect(syncCliCloudDirectory({
      client,
      localPeerId: 'self-peer',
      network,
      now: () => 2,
      trustStore,
    })).resolves.toHaveLength(2);
    expect(network.removeTrustedDevice).toHaveBeenCalledWith('stale-peer');
    expect(network.upsertTrustedDevice).toHaveBeenCalledTimes(1);
    expect(network.upsertTrustedDevice).toHaveBeenCalledWith(expect.objectContaining({
      peerId: 'cloud-peer',
      trustMode: 'cloud-account',
    }));
    expect(network.upsertDiscoveredDevice).toHaveBeenCalledWith(expect.objectContaining({
      peerId: 'local-peer',
      trustMode: 'local-pairing',
      multiaddrs: [
        '/ip4/127.0.0.1/tcp/4001',
        '/dns4/relay.example.test/tcp/443/wss/p2p/relay/p2p-circuit',
      ],
      reachability: { state: 'online', paths: ['direct', 'relay'] },
    }));
    expect(network.upsertDiscoveredDevice).not.toHaveBeenCalledWith(expect.objectContaining({ peerId: 'self-peer' }));
  });
});
