import type { AgentVolumeClaimResource, AgentVolumeResource, StorageClassResource, VolumeAccessMode } from '../resources.js';

export interface StorageDriverCapabilities {
  name: string;
  accessModes: VolumeAccessMode[];
  snapshots: boolean;
  encryption: boolean;
  maxVolumeBytes?: number;
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
