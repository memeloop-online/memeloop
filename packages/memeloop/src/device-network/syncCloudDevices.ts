import type { CloudDeviceClient, CloudDeviceRecord, DeviceTrustStore, TrustedDeviceRecord } from './types.js';

/**
 * Fetch visible cloud devices and merge them into the local trust store.
 * - Cloud devices become trusted with trustMode = "cloud-account".
 * - Explicit local-pairing trust is never replaced by Cloud directory data.
 * - Cloud-account records that are revoked or disappear from the visible
 *   directory are removed so stale discovery metadata cannot bypass revocation.
 * - Returns only active Cloud records for callers to emit as discovered devices.
 */
export async function syncCloudDevices(input: {
  cloudClient: CloudDeviceClient;
  trustStore: DeviceTrustStore;
}): Promise<CloudDeviceRecord[]> {
  const cloudDevices = await input.cloudClient.listDevices();
  const existingRecords = await input.trustStore.loadTrustedDevices();
  const existingByPeerId = new Map(existingRecords.map((r) => [r.peerId, r]));
  const activeCloudDevices = cloudDevices.filter((device) => device.revokedAt === undefined);
  const visibleCloudPeerIds = new Set(activeCloudDevices.map((device) => device.peerId));

  for (const existing of existingRecords) {
    if (
      existing.trustMode === 'cloud-account' &&
      !visibleCloudPeerIds.has(existing.peerId)
    ) {
      await input.trustStore.removeTrustedDevice(existing.peerId);
    }
  }

  for (const cloudDevice of activeCloudDevices) {
    const existing = existingByPeerId.get(cloudDevice.peerId);

    // Local pairing is a separate, explicit trust source. Cloud discovery may
    // describe the same peer but must not rotate its key or downgrade its trust
    // provenance behind the user's back.
    if (existing?.trustMode === 'local-pairing') continue;

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

    if (!existing || !sameTrustedDevice(existing, record)) {
      await input.trustStore.saveTrustedDevice(record);
    }
  }

  return activeCloudDevices;
}

function sameTrustedDevice(left: TrustedDeviceRecord, right: TrustedDeviceRecord): boolean {
  return left.peerId === right.peerId &&
    left.publicKeyMultibase === right.publicKeyMultibase &&
    left.deviceName === right.deviceName &&
    left.platform === right.platform &&
    left.trustMode === right.trustMode &&
    left.accountId === right.accountId &&
    left.createdAt === right.createdAt &&
    left.lastSeen === right.lastSeen &&
    left.revokedAt === right.revokedAt;
}
