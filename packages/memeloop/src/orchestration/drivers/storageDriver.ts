import type { AgentVolumeClaimResource, AgentVolumeResource, StorageClassResource, VolumeAccessMode } from '../resources.js';

export interface StorageDriverCapabilities {
  name: string;
  accessModes: VolumeAccessMode[];
  snapshots: boolean;
  encryption: boolean;
  /** The host stack has a wired replica transport/controller. */
  replication?: boolean;
  /** The host stack has a wired durable backup implementation. */
  backup?: boolean;
  maxVolumeBytes?: number;
}

/** Shared claim/class capability gate used at binding and immediately pre-effect. */
export function storageDriverSatisfiesClass(
  capability: StorageDriverCapabilities,
  claim: AgentVolumeClaimResource,
  storageClass: StorageClassResource,
): boolean {
  const replicaFactor = storageClass.spec.replication?.factor ?? 1;
  const backupRequested = storageClass.spec.backup?.schedule !== undefined ||
    storageClass.spec.backup?.retentionCount !== undefined;
  return capability.name === storageClass.spec.driver &&
    capability.accessModes.includes(claim.spec.accessMode) &&
    (!storageClass.spec.allowedAccessModes?.length ||
      storageClass.spec.allowedAccessModes.includes(claim.spec.accessMode)) &&
    (!claim.spec.dataSourceRef || capability.snapshots) &&
    (!storageClass.spec.snapshotSupport || capability.snapshots) &&
    (!storageClass.spec.encryption?.enabled || capability.encryption) &&
    Number.isSafeInteger(replicaFactor) &&
    replicaFactor >= 1 &&
    (replicaFactor === 1 || capability.replication === true) &&
    (!backupRequested || capability.backup === true) &&
    (capability.maxVolumeBytes === undefined ||
      (claim.spec.sizeBytes ?? 0) <= capability.maxVolumeBytes);
}

export interface StorageProvisionRequest {
  claim: AgentVolumeClaimResource;
  storageClass: StorageClassResource;
}

export interface StorageProvisionResult {
  /** Opaque and stable for the claim UID. */
  driverHandle: string;
  capacityBytes?: number;
  topology?: { nodeId?: string; zone?: string };
}

export interface StoragePublishRequest {
  volume: AgentVolumeResource;
  nodeId: string;
  workloadUid: string;
  readOnly: boolean;
}

export interface StoragePublishResult {
  /** Opaque and stable for volume/workload/node. */
  publishHandle: string;
  /** Host path or runtime-native mount descriptor; never parsed by core. */
  mountPath: string;
}

/** CSI-like host port. Provision/publish/delete/unpublish must be idempotent. */
export interface StorageDriver {
  getCapabilities(): Promise<StorageDriverCapabilities>;
  getHealth(): Promise<{ healthy: boolean; detail?: string; checkedAt: string }>;
  provision(request: StorageProvisionRequest): Promise<StorageProvisionResult>;
  delete(volume: AgentVolumeResource): Promise<void>;
  publish(request: StoragePublishRequest): Promise<StoragePublishResult>;
  getPublished(publishHandle: string): Promise<StoragePublishResult | undefined>;
  unpublish(publishHandle: string): Promise<void>;
}
