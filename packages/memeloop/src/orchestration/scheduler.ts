import type { Controller, ControllerReconcileResult } from './controllerRunner.js';
import type { ControlStore, ControlStoreActor } from './controlStore.js';
import type { AgentWorkloadResource, AgentWorkloadStatus, DataClassification, NodeTrustClass } from './resources.js';

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
  /** Taints that repel workloads unless they explicitly tolerate them. */
  taints?: string[];
  /**
   * Maximum data classification this node is allowed to process.
   * Defaults to 'restricted' for trusted, 'internal' for restricted, 'public' for quarantine.
   */
  maxDataClassification?: DataClassification;
  /** Available model endpoints on this node (by model class name). */
  availableModelClasses?: string[];
  /** Spare concurrency slots. */
  spareConcurrency?: number;
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

/** Trust rank: higher = more trusted. */
const TRUST_RANK: Record<NodeTrustClass, number> = {
  quarantine: 0,
  restricted: 1,
  trusted: 2,
};

/** Data classification rank: higher = more sensitive. */
const CLASSIFICATION_RANK: Record<DataClassification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

const DEFAULT_MAX_CLASSIFICATION: Record<NodeTrustClass, DataClassification> = {
  trusted: 'restricted',
  restricted: 'internal',
  quarantine: 'public',
};

/**
 * Determine the minimum node trust class required for a workload.
 *
 * Per §7.2 and §23, restricted nodes are the preferred fleet-worker class.
 * Quarantine workloads (trust='quarantine') must only run on quarantine nodes.
 * Workloads with no trust specified default to 'restricted' (allowed on
 * restricted or trusted nodes).
 */
function resolveMinTrustClass(workload: AgentWorkloadResource): NodeTrustClass {
  return workload.spec.trust ?? 'restricted';
}

/**
 * Upsert the `Scheduled` condition so requesters can watch readiness through
 * the standard condition-wait path (plan 24.14).
 */
function withScheduledCondition(
  status: AgentWorkloadStatus,
  conditionStatus: 'True' | 'False',
  reason: string,
  now: Date,
): AgentWorkloadStatus {
  const conditions = (status.conditions ?? []).filter((condition) => condition.type !== 'Scheduled');
  conditions.push({ type: 'Scheduled', status: conditionStatus, reason, lastTransitionTime: now.toISOString() });
  return { ...status, conditions };
}

/**
 * Create a controller that binds AgentWorkloads to Nodes.
 *
 * The controller watches AgentWorkloads in Pending phase, runs the scheduler
 * to select a node, and updates the workload status with the binding through
 * ControlStore CAS. The lease epoch is included in the status update for
 * fencing.
 *
 * Per §7.2 and §23, restricted nodes are the preferred fleet-worker class and
 * are allowed for ordinary worker workloads. Only quarantine-designated
 * workloads may run on quarantine nodes.
 */
export function createBindingController(
  _store: ControlStore,
  options: BindingControllerOptions,
): Controller<AgentWorkloadResource['spec']> {
  return {
    async reconcile(request): Promise<ControllerReconcileResult> {
      const workload = request.resource as AgentWorkloadResource;
      const status = workload.status ?? {};

      // External placement is explicit and owned by the external
      // orchestration controller. Never race it with the local node binder.
      if (workload.spec.placement?.orchestrator) {
        return { ready: true };
      }

      // Skip workloads that are already bound or completed.
      if (status.phase !== 'Pending' && status.phase !== undefined) {
        return { ready: true };
      }

      const nodes = await options.listNodes();
      const decision = options.scheduler.schedule(workload, nodes);

      if (!decision) {
        return {
          status: withScheduledCondition(
            {
              ...status,
              phase: 'Failed',
              lastRunResult: 'no suitable node found',
            } as AgentWorkloadStatus,
            'False',
            'NoSuitableNode',
            request.now,
          ),
          ready: true,
        };
      }

      // Verify the selected node meets the workload's trust requirement.
      // The scheduler already enforces this, but we double-check as defense
      // in depth. Quarantine workloads require quarantine nodes; all other
      // workloads require restricted or trusted nodes.
      const node = nodes.find((n) => n.name === decision.nodeName);
      if (node) {
        const minTrust = resolveMinTrustClass(workload);
        if (TRUST_RANK[node.trustClass] < TRUST_RANK[minTrust]) {
          return {
            status: withScheduledCondition(
              {
                ...status,
                phase: 'Failed',
                lastRunResult: `node ${decision.nodeName} trust class ${node.trustClass} below required ${minTrust}`,
              } as AgentWorkloadStatus,
              'False',
              'TrustBelowRequired',
              request.now,
            ),
            ready: true,
          };
        }
        // Quarantine workloads must only run on quarantine nodes (isolation).
        if (minTrust === 'quarantine' && node.trustClass !== 'quarantine') {
          return {
            status: withScheduledCondition(
              {
                ...status,
                phase: 'Failed',
                lastRunResult: `quarantine workload must run on quarantine node, not ${node.trustClass}`,
              } as AgentWorkloadStatus,
              'False',
              'QuarantineIsolation',
              request.now,
            ),
            ready: true,
          };
        }
      }

      return {
        status: withScheduledCondition(
          {
            ...status,
            phase: 'Scheduling',
            assignedNode: decision.nodeName,
            lastRunResult: `bound to ${decision.nodeName} (score: ${decision.score}, lease: ${request.leaseEpoch})`,
          } as AgentWorkloadStatus,
          'True',
          `BoundTo ${decision.nodeName}`,
          request.now,
        ),
        ready: true,
      };
    },
  };
}

/**
 * Capacity scheduler with trust, data-classification, taint/toleration,
 * model-capability, and anti-affinity filters.
 *
 * Trust filtering (§7.2, §23):
 * - Restricted nodes are allowed for ordinary/restricted workloads.
 * - Quarantine nodes are only candidates for quarantine-designated workloads.
 * - Trusted nodes are always eligible (unless filtered by other criteria).
 *
 * Data classification filtering:
 * - Workloads with sensitive data are not scheduled on nodes whose
 *   `maxDataClassification` is lower than the workload's classification.
 * - Quarantine nodes default to `public`-only.
 *
 * Scoring favors trusted nodes, higher capacity, and data locality.
 */
export function createCapacityScheduler(): Scheduler {
  return {
    schedule(workload, nodes) {
      const placement = workload.spec.placement ?? {};
      const minTrust = resolveMinTrustClass(workload);
      const workloadClassification = placement.dataClassification ?? 'internal';
      const candidates: Array<{ node: SchedulerNode; score: number; reasons: string[] }> = [];

      for (const node of nodes) {
        const reasons: string[] = [];
        let score = 0;

        // ── Filter: required node ──
        if (placement.requiredNode && node.name !== placement.requiredNode) {
          continue;
        }

        // ── Filter: node selector labels ──
        if (placement.nodeSelector) {
          const matches = Object.entries(placement.nodeSelector).every(
            ([key, value]) => node.labels?.[key] === value,
          );
          if (!matches) continue;
          reasons.push('matches nodeSelector');
        }

        // ── Filter: anti-affinity fault domains ──
        if (placement.antiAffinity?.includes(node.faultDomain)) {
          continue;
        }

        // ── Filter: trust compatibility ──
        // Quarantine workloads must only run on quarantine nodes.
        // Non-quarantine workloads must not run on quarantine nodes.
        if (minTrust === 'quarantine') {
          if (node.trustClass !== 'quarantine') continue;
          reasons.push('quarantine isolation match');
        } else {
          if (node.trustClass === 'quarantine') continue;
          if (TRUST_RANK[node.trustClass] < TRUST_RANK[minTrust]) continue;
          reasons.push(`trust: ${node.trustClass} ≥ ${minTrust}`);
        }

        // ── Filter: data classification ──
        const nodeMaxClass = node.maxDataClassification ?? DEFAULT_MAX_CLASSIFICATION[node.trustClass];
        if (CLASSIFICATION_RANK[workloadClassification] > CLASSIFICATION_RANK[nodeMaxClass]) {
          continue;
        }
        reasons.push(`data: ${workloadClassification} ≤ ${nodeMaxClass}`);

        // ── Filter: taints/tolerations ──
        if (node.taints && node.taints.length > 0) {
          const tolerations = placement.tolerations ?? [];
          const untolerated = node.taints.filter((t) => !tolerations.includes(t));
          if (untolerated.length > 0) continue;
          reasons.push('taints tolerated');
        }

        // ── Filter: model class availability ──
        const requiredModelClass = workload.spec.modelPolicy?.modelClass;
        if (requiredModelClass && node.availableModelClasses) {
          if (!node.availableModelClasses.includes(requiredModelClass)) continue;
          reasons.push(`model class ${requiredModelClass} available`);
        }

        // ── Score: available capacity (higher is better) ──
        const cpu = node.capacity?.cpuMillicores ?? 0;
        const memory = node.capacity?.memoryBytes ?? 0;
        score = cpu + Math.floor(memory / (1024 * 1024));
        reasons.push(`capacity score: ${score}`);

        // ── Score: trust bonus (prefer higher trust) ──
        score += TRUST_RANK[node.trustClass] * 500;
        if (node.trustClass === 'trusted') {
          reasons.push('trusted node bonus');
        } else if (node.trustClass === 'restricted') {
          reasons.push('restricted node eligible');
        }

        // ── Score: spare concurrency bonus ──
        if (node.spareConcurrency && node.spareConcurrency > 0) {
          score += Math.min(node.spareConcurrency * 10, 200);
          reasons.push(`spare concurrency: ${node.spareConcurrency}`);
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
