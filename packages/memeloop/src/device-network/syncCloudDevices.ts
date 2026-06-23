import type { CloudDeviceClient, CloudDeviceRecord, DeviceTrustStore, TrustedDeviceRecord } from './types.js';

/**
 * Fetch visible cloud devices and merge them into the local trust store.
 * - Cloud devices become trusted with trustMode = "cloud-account".
 * - Already-trusted devices are updated (capabilities, lastSeen, multiaddrs).
 * - Revoked cloud devices are NOT removed from local trust store here
 *   (revocation should be handled via heartbeat/grant failure).
 * - Returns the synced cloud device records for caller to emit as discovered devices.
 */
export async function syncCloudDevices(input: {
  cloudClient: CloudDeviceClient;
  trustStore: DeviceTrustStore;
}): Promise<CloudDeviceRecord[]> {
  const cloudDevices = await input.cloudClient.listDevices();

  if (cloudDevices.length === 0) return [];

  const existingRecords = await input.trustStore.loadTrustedDevices();
  const existingByPeerId = new Map(existingRecords.map((r) => [r.peerId, r]));

  for (const cloudDevice of cloudDevices) {
    const existing = existingByPeerId.get(cloudDevice.peerId);

    const record: TrustedDeviceRecord = {
      peerId: cloudDevice.peerId,
      publicKeyMultibase: cloudDevice.publicKeyMultibase,
      deviceName: cloudDevice.deviceName,
      platform: cloudDevice.platform,
      trustMode: 'cloud-account',
      accountId: cloudDevice.accountId,
      createdAt: existing?.createdAt ?? Date.now(),
      lastSeen: cloudDevice.lastSeen,
      revokedAt: cloudDevice.revokedAt,
    };

    if (existing) {
      // Update mutable fields while preserving trust mode
      existing.lastSeen = cloudDevice.lastSeen;
      existing.revokedAt = cloudDevice.revokedAt;
      // If the device is already trusted via cloud-account, skip persisting again
      // unless key fields changed
      if (
        existing.publicKeyMultibase !== record.publicKeyMultibase ||
        existing.deviceName !== record.deviceName ||
        existing.platform !== record.platform
      ) {
        await input.trustStore.saveTrustedDevice(record);
      }
    } else {
      await input.trustStore.saveTrustedDevice(record);
    }
  }

  return cloudDevices;
}
