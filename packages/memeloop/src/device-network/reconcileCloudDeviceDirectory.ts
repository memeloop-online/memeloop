import type { CloudDeviceRecord, Device, DeviceTrustStore, TrustedDeviceRecord } from './types.js';

const DEFAULT_CLOUD_DEVICE_FRESHNESS_MS = 3 * 60_000;

type Awaitable<T> = T | Promise<T>;

/**
 * Host-owned live address/discovery overlay. Implementations can bridge this
 * to libp2p, a browser transport, or a mobile transport without Core importing
 * any one of those concrete network stacks.
 */
export interface DeviceCloudLiveDirectoryCapability {
  listCloudDeviceAddressPeerIds(): Awaitable<readonly string[]>;
  setCloudDeviceAddresses(peerId: string, multiaddrs: readonly string[]): Awaitable<void>;
  removeCloudDeviceAddresses(peerId: string): Awaitable<void>;
  upsertCloudDiscoveredDevice?(device: Device): Awaitable<void>;
  removeCloudDiscoveredDevice?(peerId: string): Awaitable<void>;
  upsertCloudTrustedDevice?(record: TrustedDeviceRecord): Awaitable<void>;
  removeCloudTrustedDevice?(peerId: string): Awaitable<void>;
}

export interface CloudDeviceDirectoryReconcileLogger {
  warn(message: string, details?: Record<string, unknown>): void;
}

export interface CloudDeviceDirectoryReconcileResult {
  cloudDevices: CloudDeviceRecord[];
  devices: Device[];
  removedPeerIds: string[];
}

/** Reconcile a fetched Cloud snapshot into durable trust and a live address overlay. */
export async function reconcileCloudDeviceDirectory(input: {
  cloudDevices: readonly CloudDeviceRecord[];
  excludePeerIds?: Iterable<string>;
  freshnessMs?: number;
  liveDirectory: DeviceCloudLiveDirectoryCapability;
  logger?: CloudDeviceDirectoryReconcileLogger;
  now?: () => number;
  trustStore: DeviceTrustStore;
}): Promise<CloudDeviceDirectoryReconcileResult> {
  const now = input.now?.() ?? Date.now();
  const freshnessMs = input.freshnessMs ?? DEFAULT_CLOUD_DEVICE_FRESHNESS_MS;
  if (!Number.isFinite(freshnessMs) || freshnessMs < 0) {
    throw new TypeError('freshnessMs must be finite and non-negative');
  }
  const existingRecords = await input.trustStore.loadTrustedDevices();
  const liveAddressPeerIds = await input.liveDirectory.listCloudDeviceAddressPeerIds();
  const existingByPeerId = new Map(existingRecords.map(record => [record.peerId, record]));
  const excludedPeerIds = new Set(input.excludePeerIds ?? []);
  const recordsByPeerId = new Map<string, CloudDeviceRecord>();
  for (const record of input.cloudDevices) {
    if (recordsByPeerId.has(record.peerId)) throw new Error('cloud_directory_duplicate_peer');
    recordsByPeerId.set(record.peerId, record);
  }
  const activeCloudDevices = [...recordsByPeerId.values()].filter(
    record => record.revokedAt === undefined && !excludedPeerIds.has(record.peerId),
  );
  const activePeerIds = new Set(activeCloudDevices.map(record => record.peerId));
  const removedPeerIds: string[] = [];

  const previousCloudPeerIds = new Set([
    ...existingRecords
      .filter(record => record.trustMode === 'cloud-account')
      .map(record => record.peerId),
    ...liveAddressPeerIds,
  ]);
  for (const peerId of previousCloudPeerIds) {
    if (activePeerIds.has(peerId)) continue;
    const existing = existingByPeerId.get(peerId);
    if (existing?.trustMode === 'cloud-account') {
      await input.trustStore.removeTrustedDevice(peerId);
      await input.liveDirectory.removeCloudTrustedDevice?.(peerId);
    }
    await input.liveDirectory.removeCloudDeviceAddresses(peerId);
    await input.liveDirectory.removeCloudDiscoveredDevice?.(peerId);
    removedPeerIds.push(peerId);
  }

  const devices: Device[] = [];
  for (const cloudDevice of activeCloudDevices) {
    const existing = existingByPeerId.get(cloudDevice.peerId);
    const trustMode = existing?.trustMode === 'local-pairing'
      ? 'local-pairing' as const
      : 'cloud-account' as const;
    let trustedRecord = existing;
    if (trustMode === 'cloud-account') {
      trustedRecord = {
        peerId: cloudDevice.peerId,
        publicKeyMultibase: cloudDevice.publicKeyMultibase,
        deviceName: cloudDevice.deviceName,
        platform: cloudDevice.platform,
        trustMode,
        accountId: cloudDevice.accountId,
        createdAt: existing?.createdAt ?? now,
        lastSeen: cloudDevice.lastSeen,
        revokedAt: cloudDevice.revokedAt,
      };
      if (
        existing?.trustMode === 'cloud-account' &&
        existing.publicKeyMultibase !== cloudDevice.publicKeyMultibase
      ) {
        input.logger?.warn(
          '[device-network] Cloud directory rotated a cloud-account device public key',
          { peerId: existing.peerId, accountId: existing.accountId },
        );
      }
      if (!existing || !sameTrustedDevice(existing, trustedRecord)) {
        await input.trustStore.saveTrustedDevice(trustedRecord);
      }
      await input.liveDirectory.upsertCloudTrustedDevice?.(trustedRecord);
    }

    const device = cloudRecordToDevice(cloudDevice, trustMode, now, freshnessMs);
    await input.liveDirectory.setCloudDeviceAddresses(
      device.peerId,
      device.multiaddrs ?? [],
    );
    await input.liveDirectory.upsertCloudDiscoveredDevice?.(device);
    devices.push(device);
  }

  return { cloudDevices: activeCloudDevices, devices, removedPeerIds };
}

export function cloudRecordToDevice(
  cloudDevice: CloudDeviceRecord,
  trustMode: Device['trustMode'],
  now = Date.now(),
  freshnessMs = DEFAULT_CLOUD_DEVICE_FRESHNESS_MS,
): Device {
  const directMultiaddrs = normalizedAddresses(cloudDevice.multiaddrs)
    .filter(address => !address.includes('/p2p-circuit'));
  const relayMultiaddrs = normalizedAddresses([
    ...cloudDevice.multiaddrs.filter(address => address.includes('/p2p-circuit')),
    ...cloudDevice.relayReservations,
  ]);
  const paths: Device['reachability']['paths'] = [
    ...(directMultiaddrs.length > 0 ? ['direct' as const] : []),
    ...(relayMultiaddrs.length > 0 ? ['relay' as const] : []),
  ];
  const fresh = Number.isFinite(cloudDevice.lastSeen) &&
    cloudDevice.lastSeen >= now - freshnessMs;
  return {
    peerId: cloudDevice.peerId,
    displayName: cloudDevice.deviceName,
    platform: cloudDevice.platform,
    trustMode,
    trusted: true,
    reachability: {
      state: fresh && paths.length > 0 ? 'online' : 'offline',
      paths: fresh ? paths : [],
    },
    capabilities: cloudDevice.capabilities,
    multiaddrs: normalizedAddresses([...directMultiaddrs, ...relayMultiaddrs]),
    lastSeen: cloudDevice.lastSeen,
  };
}

function normalizedAddresses(addresses: readonly string[]): string[] {
  return [...new Set(addresses.map(address => address.trim()).filter(Boolean))];
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
