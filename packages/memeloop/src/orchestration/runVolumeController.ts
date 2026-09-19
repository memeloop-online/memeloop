import type { Controller } from './controllerRunner.js';
import type { DriverRequestEnvelope } from './drivers/driverRequest.js';
import type { StorageDriver } from './drivers/storageDriver.js';
import type { StorageManagementDriver } from './drivers/storageManagement.js';
import { OrchestrationError } from './errors.js';
import type { AgentRunResource, AgentRunStatus, AgentVolumeClaimResource, AgentVolumeResource, AgentWorkloadResource } from './resources.js';

export interface RunVolumeControllerOptions {
  nodeId: string;
  getWorkload(run: AgentRunResource): Promise<AgentWorkloadResource | null>;
  getClaim(name: string, namespace?: string): Promise<AgentVolumeClaimResource | null>;
  getVolume(claim: AgentVolumeClaimResource): Promise<AgentVolumeResource | null>;
  getDriver(name: string): Promise<StorageDriver | undefined>;
  managed?: {
    getDriver(name: string): Promise<StorageManagementDriver | undefined>;
    createStageRequest(input: {
      run: AgentRunResource;
      volume: AgentVolumeResource;
      nodeId: string;
      actor: Parameters<Controller['reconcile']>[0]['actor'];
      leaseEpoch: string;
    }): Promise<DriverRequestEnvelope<{ volumeHandle: string; nodeId: string }>>;
    createPublishRequest(input: {
      run: AgentRunResource;
      stageHandle: string;
      workloadUid: string;
      readOnly: boolean;
      actor: Parameters<Controller['reconcile']>[0]['actor'];
      leaseEpoch: string;
    }): Promise<
      DriverRequestEnvelope<{
        stageHandle: string;
        workloadUid: string;
        readOnly: boolean;
      }>
    >;
    createUnpublishRequest(input: {
      run: AgentRunResource;
      publishHandle: string;
      actor: Parameters<Controller['reconcile']>[0]['actor'];
      leaseEpoch: string;
    }): Promise<DriverRequestEnvelope<{ publishHandle: string }>>;
    createUnstageRequest(input: {
      run: AgentRunResource;
      stageHandle: string;
      actor: Parameters<Controller['reconcile']>[0]['actor'];
      leaseEpoch: string;
    }): Promise<DriverRequestEnvelope<{ stageHandle: string }>>;
  };
  recordPublished?(
    volume: AgentVolumeResource,
    workload: AgentWorkloadResource,
    nodeId: string,
  ): Promise<void>;
  recordUnpublished?(
    volume: AgentVolumeResource,
    workload: AgentWorkloadResource,
    nodeId: string,
  ): Promise<void>;
  now?: () => Date;
}

/** Publishes independently provisioned claims to a bound Run's workload node. */
export function createRunVolumeController(
  options: RunVolumeControllerOptions,
): Controller<AgentRunResource['spec']> {
  const now = options.now ?? (() => new Date());
  return {
    async reconcile(request) {
      const run = request.resource as AgentRunResource;
      const status = run.status ?? {};
      const workload = await options.getWorkload(run);
      if (!workload || workload.status?.assignedNode !== options.nodeId) return { ready: true };
      const requested = workload.spec.storagePolicy?.volumes ?? [];
      if (requested.length === 0) return { ready: true };

      if (
        (status.volumePhase === 'Ready' || status.volumePhase === 'Publishing') &&
        status.volumeReleaseRequestedAt
      ) {
        return {
          status: { ...status, volumePhase: 'Releasing' } satisfies AgentRunStatus,
          requeueAfterMs: 1,
        };
      }
      if (status.volumePhase === 'Releasing') {
        for (const binding of status.volumeBindings ?? []) {
          const managedDriver = options.managed
            ? await options.managed.getDriver(binding.assignedDriver)
            : undefined;
          if (managedDriver && options.managed && binding.stageHandle) {
            await managedDriver.unpublish(
              await options.managed.createUnpublishRequest({
                run,
                publishHandle: binding.publishHandle,
                actor: request.actor,
                leaseEpoch: request.leaseEpoch,
              }),
            );
            await managedDriver.unstage(
              await options.managed.createUnstageRequest({
                run,
                stageHandle: binding.stageHandle,
                actor: request.actor,
                leaseEpoch: request.leaseEpoch,
              }),
            );
          } else {
            const driver = await options.getDriver(binding.assignedDriver);
            if (!driver) {
              throw new OrchestrationError({
                code: 'UNAVAILABLE',
                message: `storage driver '${binding.assignedDriver}' unavailable during unpublish`,
                retryable: true,
              });
            }
            await driver.unpublish(binding.publishHandle);
          }
          const claim = await options.getClaim(binding.claimRef.name, run.metadata.namespace);
          const volume = claim ? await options.getVolume(claim) : null;
          if (volume) await options.recordUnpublished?.(volume, workload, options.nodeId);
        }
        return {
          status: { ...status, volumePhase: 'Released' } satisfies AgentRunStatus,
          ready: true,
        };
      }
      if (
        status.volumePhase === 'Ready' ||
        status.volumePhase === 'Released' ||
        status.volumePhase === 'Failed'
      ) return { ready: true };

      const resolved: Array<{
        name: string;
        claim: AgentVolumeClaimResource;
        volume: AgentVolumeResource;
        driver: StorageDriver;
        readOnly: boolean;
      }> = [];
      for (const request_ of requested) {
        const claim = await options.getClaim(request_.claimRef, run.metadata.namespace);
        if (!claim) return { requeueAfterMs: 1000 };
        if (claim.status?.phase === 'Failed' || claim.status?.phase === 'Lost') {
          return {
            status: {
              ...status,
              volumePhase: 'Failed',
              volumeError: {
                code: 'UNAVAILABLE',
                message: `volume claim '${request_.claimRef}' is ${claim.status.phase}`,
                retryable: false,
              },
            } satisfies AgentRunStatus,
            ready: true,
          };
        }
        if (
          claim.status?.phase !== 'Bound' ||
          claim.status.assignedNode !== options.nodeId ||
          !claim.status.assignedDriver
        ) return { requeueAfterMs: 1000 };
        const volume = await options.getVolume(claim);
        if (!volume || volume.metadata.uid !== claim.status.volumeRef?.uid) {
          return { requeueAfterMs: 1000 };
        }
        const driver = await options.getDriver(claim.status.assignedDriver);
        if (!driver) return { requeueAfterMs: 1000 };
        resolved.push({
          name: request_.name,
          claim,
          volume,
          driver,
          readOnly: claim.spec.accessMode === 'ReadOnlyMany',
        });
      }

      if (status.volumePhase !== 'Publishing') {
        return {
          status: {
            ...status,
            volumePhase: 'Publishing',
            volumePublishClaim: {
              leaseEpoch: request.leaseEpoch,
              claimedAt: now().toISOString(),
            },
          } satisfies AgentRunStatus,
          requeueAfterMs: 1,
        };
      }
      if (status.volumePublishClaim?.leaseEpoch !== request.leaseEpoch) {
        return {
          status: {
            ...status,
            volumePhase: 'Failed',
            volumeError: {
              code: 'UNKNOWN_EFFECT',
              message: 'controller epoch changed after volume publication was claimed',
              retryable: false,
            },
          } satisfies AgentRunStatus,
          ready: true,
        };
      }

      const bindings = [...(status.volumeBindings ?? [])];
      const next = resolved.find((item) => !bindings.some((binding) => binding.name === item.name));
      if (next) {
        const managedDriver = options.managed
          ? await options.managed.getDriver(next.claim.status!.assignedDriver!)
          : undefined;
        const stage = managedDriver && options.managed
          ? await managedDriver.stage(
            await options.managed.createStageRequest({
              run,
              volume: next.volume,
              nodeId: options.nodeId,
              actor: request.actor,
              leaseEpoch: request.leaseEpoch,
            }),
          )
          : undefined;
        const managedPublication = managedDriver && options.managed && stage
          ? await managedDriver.publish(
            await options.managed.createPublishRequest({
              run,
              stageHandle: stage.stageHandle,
              workloadUid: workload.metadata.uid,
              readOnly: next.readOnly,
              actor: request.actor,
              leaseEpoch: request.leaseEpoch,
            }),
          )
          : undefined;
        const published = managedPublication ?? await next.driver.publish({
          volume: next.volume,
          nodeId: options.nodeId,
          workloadUid: workload.metadata.uid,
          readOnly: next.readOnly,
        });
        await options.recordPublished?.(next.volume, workload, options.nodeId);
        bindings.push({
          name: next.name,
          claimRef: { name: next.claim.metadata.name, uid: next.claim.metadata.uid },
          volumeRef: { name: next.volume.metadata.name, uid: next.volume.metadata.uid },
          assignedDriver: next.claim.status!.assignedDriver!,
          assignedNode: options.nodeId,
          ...(stage ? { stageHandle: stage.stageHandle } : {}),
          publishHandle: published.publishHandle,
          readOnly: next.readOnly,
        });
        return {
          status: {
            ...status,
            volumePhase: 'Publishing',
            volumeBindings: bindings,
          } satisfies AgentRunStatus,
          requeueAfterMs: 1,
        };
      }
      return {
        status: {
          ...status,
          volumePhase: 'Ready',
          volumeBindings: bindings,
        } satisfies AgentRunStatus,
        ready: true,
      };
    },
  };
}
