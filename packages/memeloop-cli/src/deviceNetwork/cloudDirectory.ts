import { type CloudDeviceRecord, type Device, type DeviceTrustStore, syncCloudDevices, type TrustedDeviceRecord } from 'memeloop';

import type { DeviceCloudClient } from './cloudClient.js';

const CLOUD_DEVICE_FRESHNESS_MS = 3 * 60_000;

export interface CliCloudDirectoryNetwork {
  getTrustedDevice(peerId: string): TrustedDeviceRecord | undefined;
  removeTrustedDevice(peerId: string): Promise<void>;
  upsertDiscoveredDevice(device: Device): void;
  upsertTrustedDevice(record: TrustedDeviceRecord): void;
}

/** Reconciles the Cloud directory into both durable trust and the live CLI node. */
export async function syncCliCloudDirectory(input: {
  client: DeviceCloudClient;
  localPeerId: string;
  network: CliCloudDirectoryNetwork;
  now?: () => number;
  trustStore: DeviceTrustStore;
}): Promise<CloudDeviceRecord[]> {
  const previousCloudRecords = (await input.trustStore.loadTrustedDevices())
    .filter(record => record.trustMode === 'cloud-account');
  const devices = await syncCloudDevices({
    cloudClient: input.client,
    excludePeerIds: [input.localPeerId],
    trustStore: input.trustStore,
  });
  const activePeerIds = new Set(devices.map(device => device.peerId));
  for (const stale of previousCloudRecords) {
    if (!activePeerIds.has(stale.peerId)) await input.network.removeTrustedDevice(stale.peerId);
  }
  for (const device of devices) {
    const existing = input.network.getTrustedDevice(device.peerId);
    const trustMode = existing?.trustMode === 'local-pairing' ? 'local-pairing' : 'cloud-account';
    const directMultiaddrs = device.multiaddrs.filter(address => !address.includes('/p2p-circuit'));
    const relayMultiaddrs = [
      ...new Set([
        ...device.multiaddrs.filter(address => address.includes('/p2p-circuit')),
        ...device.relayReservations,
      ]),
    ];
    const advertisedPaths: Device['reachability']['paths'] = [
      ...(directMultiaddrs.length > 0 ? ['direct' as const] : []),
      ...(relayMultiaddrs.length > 0 ? ['relay' as const] : []),
    ];
    const dialableMultiaddrs = [...new Set([...directMultiaddrs, ...relayMultiaddrs])];
    const fresh = device.lastSeen >= (input.now?.() ?? Date.now()) - CLOUD_DEVICE_FRESHNESS_MS;
    if (trustMode === 'cloud-account') {
      input.network.upsertTrustedDevice({
        peerId: device.peerId,
        publicKeyMultibase: device.publicKeyMultibase,
        deviceName: device.deviceName,
        platform: device.platform,
        trustMode,
        accountId: device.accountId,
        createdAt: existing?.createdAt ?? Date.now(),
        lastSeen: device.lastSeen,
      });
    }
    input.network.upsertDiscoveredDevice({
      peerId: device.peerId,
      displayName: device.deviceName,
      platform: device.platform,
      trustMode,
      trusted: true,
      reachability: {
        state: fresh && advertisedPaths.length > 0 ? 'online' : 'offline',
        paths: fresh ? advertisedPaths : [],
      },
      capabilities: device.capabilities,
      multiaddrs: dialableMultiaddrs,
      lastSeen: device.lastSeen,
    });
  }
  return devices;
}
