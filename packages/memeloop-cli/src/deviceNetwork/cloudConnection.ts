import { randomBytes } from 'node:crypto';

import { signDeviceIdentityPayload } from '@memeloop/libp2p';
import {
  buildDeviceHeartbeatMessage,
  type CloudDeviceClient as CoreCloudDeviceClient,
  type CloudDeviceRecord,
  type Device,
  type DeviceCapabilities,
  type DeviceCloudCommitFence,
  DeviceCloudConnectionCoordinator,
  type DeviceCloudConnectionSnapshot,
  type DeviceCloudLiveDirectoryCapability,
  type DeviceRelayReservationToken,
  type DeviceSyncOptions,
  type DeviceTrustStore,
  hasValidDirectCloudDeviceAddress,
  reconcileCloudDeviceDirectory,
  StandardDeviceCloudConnectionAdapter,
  type StandardDeviceCloudConnectionAdapterOptions,
  type SyncResult,
  type TrustedDeviceRecord,
} from 'memeloop';

import type { DeviceCloudClient } from './cloudClient.js';
import type { CliDeviceIdentity } from './identity.js';
import { signDeviceBinding } from './identity.js';
import type { CliCloudDirectorySnapshotTrustStore } from './trustStore.js';

type HeartbeatSigner = StandardDeviceCloudConnectionAdapterOptions['signHeartbeat'];
type BindingSigner = StandardDeviceCloudConnectionAdapterOptions['signDeviceBinding'];

export interface CliCloudNetworkAdapter extends DeviceCloudLiveDirectoryCapability {
  configureRelayReservation(
    token: DeviceRelayReservationToken,
    signal: AbortSignal,
    fence: DeviceCloudCommitFence,
  ): Promise<void>;
  clearRelayReservation(signal?: AbortSignal): Promise<void>;
  getMultiaddrs(): string[];
  syncWithDevice?(peerId: string, options?: DeviceSyncOptions): Promise<SyncResult>;
}

export interface CliCloudConnectionOptions {
  capabilities: () => DeviceCapabilities;
  client: DeviceCloudClient;
  clearCloudAuthorizer: (signal: AbortSignal) => void | Promise<void>;
  configureCloudAuthorizer: (
    value: { issuer: 'memeloop-cloud'; publicKeyMultibase: string },
    signal: AbortSignal,
    fence: DeviceCloudCommitFence,
  ) => void | Promise<void>;
  heartbeatIntervalMs?: number;
  identity: CliDeviceIdentity;
  logWarning?: (message: string, error: unknown) => void;
  network: CliCloudNetworkAdapter;
  now?: () => number;
  onStatus?: (
    snapshot: DeviceCloudConnectionSnapshot,
    fence: DeviceCloudCommitFence,
  ) => void | Promise<void>;
  relayRenewalWindowMs?: number;
  signDeviceBinding?: BindingSigner;
  signHeartbeat?: HeartbeatSigner;
  trustStore: CliCloudDirectorySnapshotTrustStore;
}

/** Core's public-address classifier retained under the established CLI name. */
export function hasValidDirectDeviceAddress(addresses: readonly string[]): boolean {
  return hasValidDirectCloudDeviceAddress(addresses);
}

function createDefaultHeartbeatSigner(identity: CliDeviceIdentity): HeartbeatSigner {
  return async ({ signal, ...unsigned }) => {
    signal.throwIfAborted();
    const nonce = randomBytes(32).toString('base64url');
    const signature = await signDeviceIdentityPayload({
      identity,
      payload: buildDeviceHeartbeatMessage({ ...unsigned, nonce }),
    });
    signal.throwIfAborted();
    return { nonce, signature };
  };
}

/** CLI host wiring over the portable, generation-safe Cloud lifecycle. */
export class CliCloudConnection {
  private readonly coordinator: DeviceCloudConnectionCoordinator<DeviceCloudClient>;

  constructor(options: CliCloudConnectionOptions) {
    const backgroundSyncWithDevice = options.network.syncWithDevice?.bind(options.network);
    const adapter = new StandardDeviceCloudConnectionAdapter({
      capabilities: options.capabilities,
      clearConnectionGrantPublicKey: options.clearCloudAuthorizer,
      clearTokenCache: (client, signal) => {
        const cacheClient = client as DeviceCloudClient;
        return cacheClient.clearCachedTokens(signal);
      },
      commitCloudDirectorySnapshot: async (input, fence) => {
        await commitCliCloudDirectorySnapshot({
          ...input,
          fence,
          liveDirectory: options.network,
          trustStore: options.trustStore,
        });
      },
      configureConnectionGrantPublicKey: options.configureCloudAuthorizer,
      identity: options.identity,
      liveDirectory: options.network,
      network: {
        getMultiaddrs: () => options.network.getMultiaddrs(),
        configureRelayReservation: async (token, signal, fence) => {
          signal.throwIfAborted();
          await options.network.configureRelayReservation(token, signal, fence);
          fence.throwIfStale();
        },
        clearRelayReservation: async (signal) => {
          signal.throwIfAborted();
          await options.network.clearRelayReservation(signal);
          signal.throwIfAborted();
        },
      },
      now: options.now,
      relayTokenSafetyMarginMs: options.relayRenewalWindowMs,
      signDeviceBinding: options.signDeviceBinding ?? (async ({ accountId, identity, nonce }) =>
        await signDeviceBinding({
          identity: identity as CliDeviceIdentity,
          accountId,
          nonce,
        })),
      signHeartbeat: options.signHeartbeat ?? createDefaultHeartbeatSigner(options.identity),
      ...(backgroundSyncWithDevice
        ? {
          syncDevice: async (client: CoreCloudDeviceClient, peerId: string, signal: AbortSignal) => {
            signal.throwIfAborted();
            const presentedGrant = await client.createConnectionGrant({
              subjectPeerId: options.identity.peerId,
              allowedPeerIds: [peerId],
              protocols: ['/memeloop/sync/2.0.0'],
              rpcMethodScope: { mode: 'none' },
              conversationScope: { mode: 'all' },
              definitionScope: { mode: 'none' },
            }, signal);
            signal.throwIfAborted();
            return backgroundSyncWithDevice(peerId, { presentedGrant, signal });
          },
        }
        : {}),
      trustStore: options.trustStore,
    });
    this.coordinator = new DeviceCloudConnectionCoordinator({
      adapter,
      configuration: options.client,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      logWarning: options.logWarning,
      now: options.now,
      onStatus: options.onStatus,
    });
  }

  public get snapshot(): DeviceCloudConnectionSnapshot {
    return this.coordinator.snapshot;
  }

  public start(): Promise<void> {
    return this.coordinator.start();
  }

  public stop(): Promise<void> {
    return this.coordinator.stop();
  }

  public dispose(): Promise<void> {
    return this.stop();
  }

  public runNow(): Promise<void> {
    return this.coordinator.runNow();
  }

  public setClient(client: DeviceCloudClient | undefined): Promise<void> {
    return this.coordinator.setConfiguration(client);
  }
}

async function commitCliCloudDirectorySnapshot(input: {
  cloudDevices: readonly CloudDeviceRecord[];
  excludePeerIds: readonly string[];
  fence: DeviceCloudCommitFence;
  freshnessMs?: number;
  liveDirectory: DeviceCloudLiveDirectoryCapability;
  now: number;
  trustStore: CliCloudDirectorySnapshotTrustStore;
}): Promise<void> {
  input.fence.throwIfStale();
  const existing = await input.trustStore.loadTrustedDevices();
  input.fence.throwIfStale();
  const cloudAccountRecords = planCloudAccountSnapshot({
    cloudDevices: input.cloudDevices,
    excludePeerIds: input.excludePeerIds,
    existing,
    now: input.now,
  });
  const committed = input.trustStore.commitCloudAccountSnapshot(
    cloudAccountRecords,
    input.fence,
  );
  if (!committed) {
    input.fence.throwIfStale();
    throw new Error('cloud_directory_commit_rejected');
  }

  // Durable trust is already atomically published. Reconcile only the live
  // overlay using a no-op persistence view, fencing every host invocation.
  const liveOnlyTrustStore: DeviceTrustStore = {
    loadTrustedDevices: async () => [...committed],
    saveTrustedDevice: async () => undefined,
    removeTrustedDevice: async () => undefined,
  };
  await reconcileCloudDeviceDirectory({
    cloudDevices: input.cloudDevices,
    excludePeerIds: input.excludePeerIds,
    ...(input.freshnessMs === undefined ? {} : { freshnessMs: input.freshnessMs }),
    liveDirectory: fencedLiveDirectory(input.liveDirectory, input.fence),
    now: () => input.now,
    trustStore: liveOnlyTrustStore,
  });
  input.fence.throwIfStale();
}

function planCloudAccountSnapshot(input: {
  cloudDevices: readonly CloudDeviceRecord[];
  excludePeerIds: readonly string[];
  existing: readonly TrustedDeviceRecord[];
  now: number;
}): TrustedDeviceRecord[] {
  const excluded = new Set(input.excludePeerIds);
  const existingByPeerId = new Map(input.existing.map(record => [record.peerId, record]));
  const seenPeerIds = new Set<string>();
  const records: TrustedDeviceRecord[] = [];
  for (const cloudDevice of input.cloudDevices) {
    if (seenPeerIds.has(cloudDevice.peerId)) {
      throw new TypeError('Cloud directory contains a duplicate PeerId');
    }
    seenPeerIds.add(cloudDevice.peerId);
    if (cloudDevice.revokedAt !== undefined || excluded.has(cloudDevice.peerId)) continue;
    const existing = existingByPeerId.get(cloudDevice.peerId);
    if (existing?.trustMode === 'local-pairing') continue;
    records.push({
      peerId: cloudDevice.peerId,
      publicKeyMultibase: cloudDevice.publicKeyMultibase,
      deviceName: cloudDevice.deviceName,
      platform: cloudDevice.platform,
      trustMode: 'cloud-account',
      accountId: cloudDevice.accountId,
      createdAt: existing?.createdAt ?? input.now,
      lastSeen: cloudDevice.lastSeen,
    });
  }
  return records;
}

function fencedLiveDirectory(
  directory: DeviceCloudLiveDirectoryCapability,
  fence: DeviceCloudCommitFence,
): DeviceCloudLiveDirectoryCapability {
  return {
    listCloudDeviceAddressPeerIds: async () => await invokeFenced(fence, () => directory.listCloudDeviceAddressPeerIds()),
    setCloudDeviceAddresses: async (peerId, multiaddrs) => {
      await invokeFenced(fence, () => directory.setCloudDeviceAddresses(peerId, multiaddrs));
    },
    removeCloudDeviceAddresses: async (peerId) => {
      await invokeFenced(fence, () => directory.removeCloudDeviceAddresses(peerId));
    },
    ...(directory.upsertCloudDiscoveredDevice
      ? {
        upsertCloudDiscoveredDevice: async (device: Device) => {
          await invokeFenced(fence, () => directory.upsertCloudDiscoveredDevice!(device));
        },
      }
      : {}),
    ...(directory.removeCloudDiscoveredDevice
      ? {
        removeCloudDiscoveredDevice: async (peerId: string) => {
          await invokeFenced(fence, () => directory.removeCloudDiscoveredDevice!(peerId));
        },
      }
      : {}),
    ...(directory.upsertCloudTrustedDevice
      ? {
        upsertCloudTrustedDevice: async (record: TrustedDeviceRecord) => {
          await invokeFenced(fence, () => directory.upsertCloudTrustedDevice!(record));
        },
      }
      : {}),
    ...(directory.removeCloudTrustedDevice
      ? {
        removeCloudTrustedDevice: async (peerId: string) => {
          await invokeFenced(fence, () => directory.removeCloudTrustedDevice!(peerId));
        },
      }
      : {}),
  };
}

async function invokeFenced<Result>(
  fence: DeviceCloudCommitFence,
  operation: () => Result | Promise<Result>,
): Promise<Result> {
  fence.throwIfStale();
  const result = await operation();
  fence.throwIfStale();
  return result;
}
