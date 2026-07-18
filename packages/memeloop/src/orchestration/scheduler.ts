import type { Controller, ControllerReconcileResult } from './controllerRunner.js';
import type { ControlStore, ControlStoreActor } from './controlStore.js';
import type { AgentWorkloadResource, AgentWorkloadStatus, NodeTrustClass } from './resources.js';

export interface SchedulerNode {
  name: string;
  trustClass: NodeTrustClass;
  faultDomain: string;
  capacity?: {
    cpuMillicores?: number;
    memoryBytes?: number;
    gpuCount?: number;
  };
  labels?: Record<string, string>;
}

export interface SchedulingDecision {
  nodeName: string;
  score: number;
  reasons: string[];
}

export interface Scheduler {
  schedule(
    workload: AgentWorkloadResource,
    nodes: SchedulerNode[],
  ): SchedulingDecision | null;
}

export interface BindingControllerOptions {
  actor: ControlStoreActor;
  scheduler: Scheduler;
  listNodes: () => Promise<SchedulerNode[]>;
}

/**
 * Create a controller that binds AgentWorkloads to Nodes.
 *
 * The controller watches AgentWorkloads in Pending phase, runs the scheduler
 * to select a node, and updates the workload status with the binding through
 * ControlStore CAS. The lease epoch is included in the status update for
 * fencing.
 */
export function createBindingController(
  _store: ControlStore,
  options: BindingControllerOptions,
): Controller<AgentWorkloadResource['spec']> {
  return {
    async reconcile(request): Promise<ControllerReconcileResult> {
      const workload = request.resource as AgentWorkloadResource;
      const status = workload.status ?? {};

      // Skip workloads that are already bound or completed.
      if (status.phase !== 'Pending' && status.phase !== undefined) {
        return { ready: true };
      }

      const nodes = await options.listNodes();
      const decision = options.scheduler.schedule(workload, nodes);

      if (!decision) {
        return {
          status: {
            ...status,
            phase: 'Failed',
            lastRunResult: 'no suitable node found',
          } as AgentWorkloadStatus,
          ready: true,
        };
      }

      // Verify the selected node is trusted; restricted and quarantine nodes
      // must never run ordinary worker workloads.
      const node = nodes.find((n) => n.name === decision.nodeName);
      if (node && node.trustClass !== 'trusted') {
        return {
          status: {
            ...status,
            phase: 'Failed',
            lastRunResult: `node ${decision.nodeName} trust class ${node.trustClass} not allowed for worker workloads`,
          } as AgentWorkloadStatus,
          ready: true,
        };
      }

      return {
        status: {
          ...status,
          phase: 'Scheduling',
          // In a full implementation, the node binding would be recorded in a
          // dedicated field. For now, we use lastRunResult to track the decision.
          lastRunResult: `bound to ${decision.nodeName} (score: ${decision.score}, lease: ${request.leaseEpoch})`,
        } as AgentWorkloadStatus,
        ready: true,
      };
    },
  };
}

/**
 * Simple scheduler that filters nodes by workload requirements and scores
 * them by available capacity.
 */
export function createCapacityScheduler(): Scheduler {
  return {
    schedule(workload, nodes) {
      const placement = workload.spec.placement ?? {};
      const candidates: Array<{ node: SchedulerNode; score: number; reasons: string[] }> = [];

      for (const node of nodes) {
        const reasons: string[] = [];
        let score = 0;

        // Filter: required node.
        if (placement.requiredNode && node.name !== placement.requiredNode) {
          continue;
        }

        // Filter: node selector labels.
        if (placement.nodeSelector) {
          const matches = Object.entries(placement.nodeSelector).every(
            ([key, value]) => node.labels?.[key] === value,
          );
          if (!matches) continue;
          reasons.push(`matches nodeSelector`);
        }

        // Filter: anti-affinity.
        if (placement.antiAffinity?.includes(node.faultDomain)) {
          continue;
        }

        // Score: available capacity (higher is better).
        const cpu = node.capacity?.cpuMillicores ?? 0;
        const memory = node.capacity?.memoryBytes ?? 0;
        score = cpu + Math.floor(memory / (1024 * 1024));
        reasons.push(`capacity score: ${score}`);

        // Prefer trusted nodes.
        if (node.trustClass === 'trusted') {
          score += 1000;
          reasons.push('trusted node bonus');
        }

        candidates.push({ node, score, reasons });
      }

      if (candidates.length === 0) return null;

      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0];
      return {
        nodeName: best.node.name,
        score: best.score,
        reasons: best.reasons,
      };
    },
  };
}
