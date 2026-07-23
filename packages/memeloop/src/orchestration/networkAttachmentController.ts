import type { Controller } from './controllerRunner.js';
import type { NetworkDriver, NetworkDriverCapabilities } from './drivers/networkDriver.js';
import { canDriverSatisfyClass } from './drivers/networkDriver.js';
import type { AgentWorkloadResource, NetworkAttachmentResource, NetworkClassResource } from './resources.js';

export interface NetworkAttachmentNode {
  nodeId: string;
  healthy: boolean;
  capabilities: NetworkDriverCapabilities[];
  /** Conservative number of attachments not yet reflected by the driver. */
  activeAttachments?: number;
  maxAttachments?: number;
}

export interface NetworkAttachmentBindingControllerOptions {
  getNetworkClass(attachment: NetworkAttachmentResource): Promise<NetworkClassResource | null>;
  getWorkload?(attachment: NetworkAttachmentResource): Promise<AgentWorkloadResource | null>;
  listNodes(): Promise<NetworkAttachmentNode[]>;
  now?: () => Date;
}

function falseCondition(message: string, time: string) {
  return {
    type: 'NetworkScheduled',
    status: 'False' as const,
    reason: 'NoEligibleNetworkDriver',
    message,
    lastTransitionTime: time,
  };
}

/**
 * Selects the node-local NetworkDriver independently from workload execution.
 * NetworkClass capability checks are hard filters; best-effort degradation is
 * allowed only when the class itself explicitly opts into it.
 */
export function createNetworkAttachmentBindingController(
  options: NetworkAttachmentBindingControllerOptions,
): Controller<NetworkAttachmentResource['spec']> {
  const now = options.now ?? (() => new Date());
  return {
    async reconcile(request) {
      const attachment = request.resource as NetworkAttachmentResource;
      const status = attachment.status ?? {};
      if (status.phase && status.phase !== 'Pending') return { ready: true };
      const reconciledAt = now().toISOString();
      const networkClass = await options.getNetworkClass(attachment);
      if (!networkClass) {
        return {
          status: {
            ...status,
            phase: 'Pending',
            conditions: [falseCondition('referenced NetworkClass is unavailable', reconciledAt)],
          },
          requeueAfterMs: 1000,
        };
      }

      const workload = await options.getWorkload?.(attachment);
      const requiredNode = attachment.spec.nodeId ?? workload?.status?.assignedNode;
      const candidates = (await options.listNodes()).flatMap((node) => {
        if (!node.healthy || (requiredNode && node.nodeId !== requiredNode)) return [];
        if (
          node.maxAttachments !== undefined &&
          (node.activeAttachments ?? 0) >= node.maxAttachments
        ) return [];
        const capability = node.capabilities.find(
          (candidate) => candidate.name === networkClass.spec.driver,
        );
        if (!capability || !canDriverSatisfyClass(capability, networkClass).satisfied) return [];
        return [{ node, capability }];
      }).sort((left, right) =>
        (left.node.activeAttachments ?? 0) - (right.node.activeAttachments ?? 0) ||
        left.node.nodeId.localeCompare(right.node.nodeId)
      );

      const selected = candidates[0];
      if (!selected) {
        const message = `no healthy driver satisfies NetworkClass '${networkClass.metadata.name}'`;
        const { assignedNode: _node, assignedDriver: _driver, binding: _binding, ...unbound } = status;
        return {
          status: {
            ...unbound,
            phase: 'Pending',
            conditions: [falseCondition(message, reconciledAt)],
          },
          requeueAfterMs: 1000,
        };
      }
      if (
        status.assignedNode === selected.node.nodeId &&
        status.assignedDriver === selected.capability.name &&
        status.binding?.leaseEpoch === request.leaseEpoch &&
        status.binding.networkClassResourceVersion === networkClass.metadata.resourceVersion
      ) {
        return { ready: true };
      }
      return {
        status: {
          ...status,
          phase: 'Pending',
          assignedNode: selected.node.nodeId,
          assignedDriver: selected.capability.name,
          binding: {
            leaseEpoch: request.leaseEpoch,
            networkClassResourceVersion: networkClass.metadata.resourceVersion,
            boundAt: reconciledAt,
          },
          conditions: [{
            type: 'NetworkScheduled',
            status: 'True',
            reason: 'DriverSelected',
            message: `bound to driver '${selected.capability.name}' on node '${selected.node.nodeId}'`,
            lastTransitionTime: reconciledAt,
          }],
        },
        ready: true,
      };
    },
  };
}

export interface NetworkAttachmentExecutionControllerOptions {
  nodeId: string;
  getNetworkClass(attachment: NetworkAttachmentResource): Promise<NetworkClassResource | null>;
  getDriver(name: string): Promise<NetworkDriver | undefined>;
  sandboxRef?(attachment: NetworkAttachmentResource): Promise<string>;
  now?: () => Date;
}

/**
 * Executes a bound attachment on its selected node. prepare() implementations
 * must be idempotent for an attachment UID. The persisted Preparing claim
 * prevents a new controller epoch from repeating a possibly completed effect.
 */
export function createNetworkAttachmentExecutionController(
  options: NetworkAttachmentExecutionControllerOptions,
): Controller<NetworkAttachmentResource['spec']> {
  const now = options.now ?? (() => new Date());
  return {
    async reconcile(request) {
      const attachment = request.resource as NetworkAttachmentResource;
      const status = attachment.status ?? {};
      if (status.assignedNode !== options.nodeId || !status.assignedDriver || !status.binding) {
        return { ready: true };
      }
      if (status.phase === 'Failed' || status.phase === 'Detached') {
        return { ready: true };
      }
      if (status.phase === 'Attached' && !status.releaseRequestedAt) return { ready: true };
      const driver = await options.getDriver(status.assignedDriver);
      if (!driver) {
        return {
          status: {
            ...status,
            phase: 'Failed',
            error: {
              code: 'UNAVAILABLE',
              message: `bound network driver '${status.assignedDriver}' is unavailable`,
              retryable: true,
            },
          },
          ready: true,
        };
      }
      if (status.phase === 'Attached' && status.releaseRequestedAt) {
        if (!status.handle) {
          return {
            status: {
              ...status,
              phase: 'Failed',
              error: {
                code: 'INVALID',
                message: 'attached network resource has no driver handle to release',
                retryable: false,
              },
            },
            ready: true,
          };
        }
        await driver.release(status.handle);
        return {
          status: {
            ...status,
            phase: 'Detached',
            detachedAt: now().toISOString(),
          },
          ready: true,
        };
      }
      const networkClass = await options.getNetworkClass(attachment);
      if (
        !networkClass ||
        networkClass.metadata.resourceVersion !== status.binding.networkClassResourceVersion
      ) {
        return {
          status: {
            ...status,
            phase: 'Failed',
            error: {
              code: 'CONFLICT',
              message: 'NetworkClass changed after attachment binding; a fresh attachment is required',
              retryable: false,
            },
          },
          ready: true,
        };
      }
      const capabilities = await driver.getCapabilities();
      const health = await driver.getHealth();
      const satisfaction = canDriverSatisfyClass(capabilities, networkClass);
      if (
        !health.healthy ||
        capabilities.name !== status.assignedDriver ||
        !satisfaction.satisfied
      ) {
        return {
          status: {
            ...status,
            phase: 'Failed',
            error: {
              code: 'UNAVAILABLE',
              message: satisfaction.reason ?? health.detail ?? 'network driver is unhealthy',
              retryable: true,
            },
          },
          ready: true,
        };
      }

      const claimedAt = now().toISOString();
      if (status.phase !== 'Preparing') {
        return {
          status: {
            ...status,
            phase: 'Preparing',
            executionClaim: { leaseEpoch: request.leaseEpoch, claimedAt },
          },
          requeueAfterMs: 1,
        };
      }
      if (status.executionClaim?.leaseEpoch !== request.leaseEpoch) {
        return {
          status: {
            ...status,
            phase: 'Failed',
            error: {
              code: 'UNKNOWN_EFFECT',
              message: 'controller epoch changed after network prepare was claimed; refusing duplicate attachment',
              retryable: false,
            },
          },
          ready: true,
        };
      }

      const prepared = await driver.prepare({
        attachment,
        networkClass,
        sandboxRef: await options.sandboxRef?.(attachment) ?? `workload:${attachment.spec.workloadRef?.uid ?? attachment.metadata.uid}`,
      });
      return {
        status: {
          ...status,
          ...prepared,
          assignedNode: status.assignedNode,
          assignedDriver: status.assignedDriver,
          binding: status.binding,
          executionClaim: status.executionClaim,
        },
        ready: prepared.phase === 'Attached' || prepared.phase === 'Failed',
        ...(prepared.phase === 'Pending' ? { requeueAfterMs: 1000 } : {}),
      };
    },
  };
}
