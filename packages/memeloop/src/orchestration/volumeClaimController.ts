import type { Controller } from './controllerRunner.js';
import type { DriverRequestEnvelope } from './drivers/driverRequest.js';
import { type StorageDriver, type StorageDriverCapabilities, storageDriverSatisfiesClass, type StorageProvisionResult } from './drivers/storageDriver.js';
import type { StorageManagementDriver, StorageProvisionPayload } from './drivers/storageManagement.js';
import type { AgentVolumeClaimResource, AgentVolumeClaimStatus, AgentVolumeResource, NodeTrustClass, StorageClassResource } from './resources.js';

export interface StorageDriverEndpoint {
  nodeId: string;
  healthy: boolean;
  capabilities: StorageDriverCapabilities[];
  trust: NodeTrustClass;
  labels?: Record<string, string>;
  activeVolumes?: number;
  maxVolumes?: number;
  availableBytes?: number;
}

export interface VolumeClaimBindingControllerOptions {
  getStorageClass(claim: AgentVolumeClaimResource): Promise<StorageClassResource | null>;
  listDrivers(): Promise<StorageDriverEndpoint[]>;
  requiredNodeForClaim?(claim: AgentVolumeClaimResource): Promise<string | undefined>;
  now?: () => Date;
}

/** Independently binds a claim to a healthy provisioner endpoint. */
export function createVolumeClaimBindingController(
  options: VolumeClaimBindingControllerOptions,
): Controller<AgentVolumeClaimResource['spec']> {
  const now = options.now ?? (() => new Date());
  return {
    async reconcile(request) {
      const claim = request.resource as AgentVolumeClaimResource;
      const status = claim.status ?? {};
      if (status.phase && status.phase !== 'Pending') return { ready: true };
      const storageClass = await options.getStorageClass(claim);
      const reconciledAt = now().toISOString();
      if (!storageClass) {
        return {
          status: {
            ...status,
            phase: 'Pending',
            conditions: [{
              type: 'VolumeScheduled',
              status: 'False',
              reason: 'StorageClassUnavailable',
              message: 'referenced StorageClass is unavailable',
              lastTransitionTime: reconciledAt,
            }],
          } satisfies AgentVolumeClaimStatus,
          requeueAfterMs: 1000,
        };
      }
      const requiredNode = await options.requiredNodeForClaim?.(claim);
      const candidates = (await options.listDrivers()).flatMap((endpoint) => {
        if (
          !endpoint.healthy ||
          endpoint.trust !== 'trusted' ||
          (requiredNode && endpoint.nodeId !== requiredNode)
        ) return [];
        if (
          endpoint.maxVolumes !== undefined &&
          (endpoint.activeVolumes ?? 0) >= endpoint.maxVolumes
        ) return [];
        if (
          endpoint.availableBytes !== undefined &&
          (claim.spec.sizeBytes ?? 0) > endpoint.availableBytes
        ) return [];
        if (
          claim.spec.selector &&
          Object.entries(claim.spec.selector).some(([key, value]) => endpoint.labels?.[key] !== value)
        ) return [];
        const capability = endpoint.capabilities.find((item) => storageDriverSatisfiesClass(item, claim, storageClass));
        return capability ? [{ endpoint, capability }] : [];
      }).sort((left, right) =>
        (left.endpoint.activeVolumes ?? 0) - (right.endpoint.activeVolumes ?? 0) ||
        left.endpoint.nodeId.localeCompare(right.endpoint.nodeId)
      );
      const selected = candidates[0];
      if (!selected) {
        const { assignedNode: _node, assignedDriver: _driver, binding: _binding, ...unbound } = status;
        return {
          status: {
            ...unbound,
            phase: 'Pending',
            conditions: [{
              type: 'VolumeScheduled',
              status: 'False',
              reason: 'NoEligibleStorageDriver',
              message: `no healthy driver satisfies StorageClass '${storageClass.metadata.name}'`,
              lastTransitionTime: reconciledAt,
            }],
          } satisfies AgentVolumeClaimStatus,
          requeueAfterMs: 1000,
        };
      }
      if (
        status.assignedNode === selected.endpoint.nodeId &&
        status.assignedDriver === selected.capability.name &&
        status.binding?.leaseEpoch === request.leaseEpoch &&
        status.binding.storageClassResourceVersion === storageClass.metadata.resourceVersion
      ) return { ready: true };
      return {
        status: {
          ...status,
          phase: 'Pending',
          assignedNode: selected.endpoint.nodeId,
          assignedDriver: selected.capability.name,
          binding: {
            leaseEpoch: request.leaseEpoch,
            storageClassResourceVersion: storageClass.metadata.resourceVersion,
            boundAt: reconciledAt,
          },
          conditions: [{
            type: 'VolumeScheduled',
            status: 'True',
            reason: 'StorageDriverSelected',
            message: `bound to '${selected.capability.name}' on '${selected.endpoint.nodeId}'`,
            lastTransitionTime: reconciledAt,
          }],
        } satisfies AgentVolumeClaimStatus,
        ready: true,
      };
    },
  };
}

export interface VolumeClaimExecutionControllerOptions {
  nodeId: string;
  getStorageClass(claim: AgentVolumeClaimResource): Promise<StorageClassResource | null>;
  getDriver(name: string): Promise<StorageDriver | undefined>;
  managed?: {
    getDriver(name: string): Promise<StorageManagementDriver | undefined>;
    createProvisionRequest(input: {
      claim: AgentVolumeClaimResource;
      storageClass: StorageClassResource;
      actor: Parameters<Controller['reconcile']>[0]['actor'];
      leaseEpoch: string;
    }): Promise<DriverRequestEnvelope<StorageProvisionPayload>>;
  };
  ensureVolume(
    claim: AgentVolumeClaimResource,
    storageClass: StorageClassResource,
    provisioned: StorageProvisionResult,
  ): Promise<AgentVolumeResource>;
  now?: () => Date;
}

/** Persists a fencing claim before idempotent volume provisioning. */
export function createVolumeClaimExecutionController(
  options: VolumeClaimExecutionControllerOptions,
): Controller<AgentVolumeClaimResource['spec']> {
  const now = options.now ?? (() => new Date());
  return {
    async reconcile(request) {
      const claim = request.resource as AgentVolumeClaimResource;
      const status = claim.status ?? {};
      if (status.assignedNode !== options.nodeId || !status.assignedDriver || !status.binding) {
        return { ready: true };
      }
      if (status.phase === 'Bound' || status.phase === 'Lost' || status.phase === 'Failed') {
        return { ready: true };
      }
      const storageClass = await options.getStorageClass(claim);
      if (
        !storageClass ||
        storageClass.metadata.resourceVersion !== status.binding.storageClassResourceVersion
      ) {
        return {
          status: {
            ...status,
            phase: 'Failed',
            error: {
              code: 'CONFLICT',
              message: 'StorageClass changed after claim binding',
              retryable: false,
            },
          } satisfies AgentVolumeClaimStatus,
          ready: true,
        };
      }
      const driver = await options.getDriver(status.assignedDriver);
      if (!driver || !(await driver.getHealth()).healthy) {
        return {
          status: {
            ...status,
            phase: 'Failed',
            error: {
              code: 'UNAVAILABLE',
              message: `bound storage driver '${status.assignedDriver}' is unavailable`,
              retryable: true,
            },
          } satisfies AgentVolumeClaimStatus,
          ready: true,
        };
      }
      if (status.phase !== 'Provisioning') {
        return {
          status: {
            ...status,
            phase: 'Provisioning',
            provisionClaim: {
              leaseEpoch: request.leaseEpoch,
              claimedAt: now().toISOString(),
            },
          } satisfies AgentVolumeClaimStatus,
          requeueAfterMs: 1,
        };
      }
      if (status.provisionClaim?.leaseEpoch !== request.leaseEpoch) {
        return {
          status: {
            ...status,
            phase: 'Failed',
            error: {
              code: 'UNKNOWN_EFFECT',
              message: 'controller epoch changed after volume provisioning was claimed',
              retryable: false,
            },
          } satisfies AgentVolumeClaimStatus,
          ready: true,
        };
      }
      const capability = await driver.getCapabilities();
      if (!storageDriverSatisfiesClass(capability, claim, storageClass)) {
        return {
          status: {
            ...status,
            phase: 'Failed',
            error: {
              code: 'FORBIDDEN',
              message: 'storage driver no longer satisfies the bound claim',
              retryable: false,
            },
          } satisfies AgentVolumeClaimStatus,
          ready: true,
        };
      }
      const managedDriver = options.managed
        ? await options.managed.getDriver(status.assignedDriver)
        : undefined;
      const managedVolume = managedDriver && options.managed
        ? await managedDriver.provision(
          await options.managed.createProvisionRequest({
            claim,
            storageClass,
            actor: request.actor,
            leaseEpoch: request.leaseEpoch,
          }),
        )
        : undefined;
      const provisioned = managedVolume
        ? {
          driverHandle: managedVolume.volumeHandle,
          capacityBytes: managedVolume.capacityBytes,
          topology: { nodeId: options.nodeId },
        }
        : await driver.provision({ claim, storageClass });
      const volume = await options.ensureVolume(claim, storageClass, provisioned);
      return {
        status: {
          ...status,
          phase: 'Bound',
          volumeRef: {
            apiVersion: volume.apiVersion,
            kind: volume.kind,
            name: volume.metadata.name,
            uid: volume.metadata.uid,
          },
        } satisfies AgentVolumeClaimStatus,
        ready: true,
      };
    },
  };
}
