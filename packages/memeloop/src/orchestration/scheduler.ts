import type { Controller, ControllerReconcileResult } from './controllerRunner.js';
import type { ControlStore, ControlStoreActor } from './controlStore.js';
import type { AgentWorkloadResource, AgentWorkloadStatus, DataClassification, NodeTrustClass } from './resources.js';

export interface SchedulerNode {
  name: string;
  trustClass: NodeTrustClass;
  faultDomain: string;
  /** Explicit false removes the node from scheduling immediately. */
  healthy?: boolean;
  /** When reported, the node must include `worker` to accept workloads. */
  roles?: string[];
  /** Trusted verifier assessment, never a worker self-report. */
  attested?: boolean;
  /** Host registry confirms every selected driver has passing conformance evidence. */
  driverConformancePassed?: boolean;
  capacity?: {
    cpuMillicores?: number;
    memoryBytes?: number;
    gpuCount?: number;
    diskBytes?: number;
    bandwidthKbps?: number;
  };
  labels?: Record<string, string>;
  /** Taints that repel workloads unless they explicitly tolerate them. */
  taints?: string[];
  /**
   * Maximum data classification this node is allowed to process.
   * Defaults to 'restricted' for trusted, 'internal' for restricted, 'public' for quarantine.
   */
  maxDataClassification?: DataClassification;
  /** Residency labels in which this node may process data. */
  dataResidency?: string[];
  /** Runtime classes backed by an admitted runtime driver on this node. */
  availableRuntimeClasses?: string[];
  /** Healthy tool executor classes available on this node. */
  availableToolClasses?: string[];
  /** Available model endpoints on this node (by model class name). */
  availableModelClasses?: string[];
  /** Network classes and the boundary/egress modes they can enforce. */
  networkCapabilities?: Array<{
    networkClass: string;
    enforcementLevel: 'none' | 'process' | 'namespace' | 'host' | 'external';
    egress?: Array<'none' | 'same-node' | 'restricted' | 'open'>;
  }>;
  /** Storage classes provisionable or publishable on this node. */
  availableStorageClasses?: string[];
  /** Existing claims local/publishable to this node. */
  availableVolumeClaims?: string[];
  /** Credential broker capabilities; these are policy metadata, never handles. */
  credentialCapabilities?: Array<{
    brokerClass: string;
    audiences?: string[];
    targets?: string[];
  }>;
  /** Content-addressed data already present on this node, used only for scoring. */
  localArtifactReferences?: string[];
  localCheckpointReferences?: string[];
  /** Active target count for each rollout batch on this fault domain. */
  rolloutLoad?: Record<string, number>;
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
  authorizePlacement?(input: {
    workload: AgentWorkloadResource;
    node: SchedulerNode;
    actor: ControlStoreActor;
    leaseEpoch: string;
  }): Promise<{
    outcome: 'allow' | 'deny';
    decisionHandle: string;
    policyDigest: string;
    reasons: string[];
  }>;
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

const NETWORK_ENFORCEMENT_RANK = {
  none: 0,
  process: 1,
  namespace: 2,
  host: 3,
  external: 4,
} as const;

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

interface NodeEligibility {
  eligible: boolean;
  reasons: string[];
  rejection?: string;
}

function reject(rejection: string): NodeEligibility {
  return { eligible: false, reasons: [], rejection };
}

/**
 * Evaluate every hard placement requirement in one place. The binding
 * controller calls this again after a Scheduler decision, so a custom
 * scheduler cannot bypass security/capability admission.
 */
function evaluateNodeEligibility(
  workload: AgentWorkloadResource,
  node: SchedulerNode,
): NodeEligibility {
  const placement = workload.spec.placement ?? {};
  const reasons: string[] = [];
  const minTrust = resolveMinTrustClass(workload);
  const workloadClassification = placement.dataClassification ?? 'internal';

  if (node.healthy === false) return reject('node is unhealthy');
  if (node.roles && !node.roles.includes('worker')) return reject('node does not advertise the worker role');
  if (placement.requireAttestation && node.attested !== true) {
    return reject('verified node attestation is required');
  }
  if (placement.requiredNode && node.name !== placement.requiredNode) return reject('requiredNode does not match');
  if (placement.nodeSelector) {
    const matches = Object.entries(placement.nodeSelector).every(
      ([key, value]) => node.labels?.[key] === value,
    );
    if (!matches) return reject('nodeSelector does not match');
    reasons.push('matches nodeSelector');
  }
  if (placement.antiAffinity?.includes(node.faultDomain)) {
    return reject(`fault domain ${node.faultDomain} is excluded by anti-affinity`);
  }

  if (minTrust === 'quarantine') {
    if (node.trustClass !== 'quarantine') return reject('quarantine isolation requires a quarantine node');
    reasons.push('quarantine isolation match');
  } else {
    if (node.trustClass === 'quarantine') return reject('non-quarantine workload cannot use quarantine node');
    if (TRUST_RANK[node.trustClass] < TRUST_RANK[minTrust]) {
      return reject(`trust class ${node.trustClass} is below ${minTrust}`);
    }
    reasons.push(`trust: ${node.trustClass} ≥ ${minTrust}`);
  }

  const nodeMaxClass = node.maxDataClassification ?? DEFAULT_MAX_CLASSIFICATION[node.trustClass];
  if (CLASSIFICATION_RANK[workloadClassification] > CLASSIFICATION_RANK[nodeMaxClass]) {
    return reject(`data classification ${workloadClassification} exceeds ${nodeMaxClass}`);
  }
  reasons.push(`data: ${workloadClassification} ≤ ${nodeMaxClass}`);
  if (placement.dataResidency?.length) {
    if (!node.dataResidency?.some((residency) => placement.dataResidency?.includes(residency))) {
      return reject('data residency does not match');
    }
    reasons.push('data residency match');
  }

  if (node.taints?.length) {
    const tolerations = placement.tolerations ?? [];
    const untolerated = node.taints.filter((taint) => !tolerations.includes(taint));
    if (untolerated.length) return reject(`untolerated taints: ${untolerated.join(', ')}`);
    reasons.push('taints tolerated');
  }

  if (workload.spec.runtimeClass) {
    if (!node.availableRuntimeClasses?.includes(workload.spec.runtimeClass)) {
      return reject(`runtime class ${workload.spec.runtimeClass} is unavailable`);
    }
    reasons.push(`runtime class ${workload.spec.runtimeClass} available`);
  }
  const requiredToolClasses = workload.spec.toolPolicy?.requiredToolClasses ?? [];
  const missingToolClass = requiredToolClasses.find(
    (toolClass) => !node.availableToolClasses?.includes(toolClass),
  );
  if (missingToolClass) return reject(`tool class ${missingToolClass} is unavailable`);
  if (requiredToolClasses.length) reasons.push('required tool classes available');

  const requiredModelClass = workload.spec.modelPolicy?.modelClass;
  if (requiredModelClass) {
    if (!node.availableModelClasses?.includes(requiredModelClass)) {
      return reject(`model class ${requiredModelClass} is unavailable`);
    }
    reasons.push(`model class ${requiredModelClass} available`);
  }

  const networkPolicy = workload.spec.networkPolicy;
  if (networkPolicy?.networkClass) {
    const capability = node.networkCapabilities?.find(
      (candidate) => candidate.networkClass === networkPolicy.networkClass,
    );
    if (!capability) return reject(`network class ${networkPolicy.networkClass} is unavailable`);
    const minimum = networkPolicy.minimumEnforcement ?? 'none';
    if (NETWORK_ENFORCEMENT_RANK[capability.enforcementLevel] < NETWORK_ENFORCEMENT_RANK[minimum]) {
      return reject(`network enforcement ${capability.enforcementLevel} is below ${minimum}`);
    }
    if (networkPolicy.egress && !capability.egress?.includes(networkPolicy.egress)) {
      return reject(`network egress mode ${networkPolicy.egress} is unavailable`);
    }
    reasons.push(`network class ${networkPolicy.networkClass} enforceable`);
  }

  const storagePolicy = workload.spec.storagePolicy;
  if (
    storagePolicy?.storageClass &&
    !node.availableStorageClasses?.includes(storagePolicy.storageClass)
  ) {
    return reject(`storage class ${storagePolicy.storageClass} is unavailable`);
  }
  const missingClaim = storagePolicy?.volumes?.find(
    (volume) => !node.availableVolumeClaims?.includes(volume.claimRef),
  );
  if (missingClaim) return reject(`volume claim ${missingClaim.claimRef} is unavailable`);
  if (storagePolicy?.storageClass || storagePolicy?.volumes?.length) {
    reasons.push('storage requirements available');
  }

  const credentialPolicy = workload.spec.credentialPolicy;
  if (credentialPolicy) {
    const capability = node.credentialCapabilities?.find(
      (candidate) =>
        !credentialPolicy.brokerClass ||
        candidate.brokerClass === credentialPolicy.brokerClass,
    );
    if (!capability) return reject('required credential broker is unavailable');
    const missingAudience = credentialPolicy.audiences?.find(
      (audience) => !capability.audiences?.includes(audience),
    );
    if (missingAudience) return reject(`credential audience ${missingAudience} is unavailable`);
    const missingTarget = credentialPolicy.targets?.find(
      (target) => !capability.targets?.includes(target),
    );
    if (missingTarget) return reject(`credential target ${missingTarget} is unavailable`);
    reasons.push('credential broker requirements available');
  }

  const requirements = workload.spec.resources;
  if (requirements) {
    const dimensions: Array<[keyof NonNullable<typeof requirements>, string]> = [
      ['cpuMillicores', 'CPU'],
      ['memoryBytes', 'memory'],
      ['gpuCount', 'GPU'],
      ['diskBytes', 'disk'],
      ['bandwidthKbps', 'bandwidth'],
    ];
    for (const [key, label] of dimensions) {
      const requested = requirements[key];
      if (requested === undefined) continue;
      if (!Number.isFinite(requested) || requested < 0) return reject(`${label} request is invalid`);
      if ((node.capacity?.[key] ?? 0) < requested) return reject(`insufficient ${label} capacity`);
    }
    reasons.push('resource requests fit');
  }

  const rollout = placement.rollout;
  if (rollout) {
    if (rollout.excludedFaultDomains?.includes(node.faultDomain)) {
      return reject(`fault domain ${node.faultDomain} is excluded from rollout batch`);
    }
    const current = node.rolloutLoad?.[rollout.batchId] ?? 0;
    if (
      rollout.maxConcurrentPerFaultDomain !== undefined &&
      current >= rollout.maxConcurrentPerFaultDomain
    ) {
      return reject(`rollout batch ${rollout.batchId} reached its fault-domain limit`);
    }
    reasons.push(`rollout batch ${rollout.batchId} admitted`);
  }

  return { eligible: true, reasons };
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

      const node = nodes.find((n) => n.name === decision.nodeName);
      const eligibility = node ? evaluateNodeEligibility(workload, node) : reject('selected node does not exist');
      if (!eligibility.eligible) {
        return {
          status: withScheduledCondition(
            {
              ...status,
              phase: 'Failed',
              lastRunResult: `node ${decision.nodeName} rejected before bind: ${eligibility.rejection}`,
            } as AgentWorkloadStatus,
            'False',
            'BindingAdmissionRejected',
            request.now,
          ),
          ready: true,
        };
      }

      const policyDecision = options.authorizePlacement
        ? await options.authorizePlacement({
          workload,
          node: node as SchedulerNode,
          actor: request.actor,
          leaseEpoch: request.leaseEpoch,
        })
        : undefined;
      if (policyDecision?.outcome === 'deny') {
        return {
          status: withScheduledCondition(
            {
              ...status,
              phase: 'Failed',
              placementDecisionRef: policyDecision.decisionHandle,
              placementPolicyDigest: policyDecision.policyDigest,
              lastRunResult: `node ${decision.nodeName} denied by trusted placement policy: ${policyDecision.reasons.join('; ')}`,
            } as AgentWorkloadStatus,
            'False',
            'PlacementPolicyDenied',
            request.now,
          ),
          ready: true,
        };
      }

      return {
        status: withScheduledCondition(
          {
            ...status,
            phase: 'Scheduling',
            assignedNode: decision.nodeName,
            ...(policyDecision
              ? {
                placementDecisionRef: policyDecision.decisionHandle,
                placementPolicyDigest: policyDecision.policyDigest,
              }
              : {}),
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
      const candidates: Array<{ node: SchedulerNode; score: number; reasons: string[] }> = [];

      for (const node of nodes) {
        const eligibility = evaluateNodeEligibility(workload, node);
        if (!eligibility.eligible) continue;
        const reasons = eligibility.reasons;

        // ── Score: available capacity (higher is better) ──
        const cpu = node.capacity?.cpuMillicores ?? 0;
        const memory = node.capacity?.memoryBytes ?? 0;
        let score = cpu + Math.floor(memory / (1024 * 1024));
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

        if (placement.preferredNode === node.name) {
          score += 300;
          reasons.push('preferred node locality');
        }
        const localArtifacts = workload.spec.artifactReferences?.filter(
          (reference) => node.localArtifactReferences?.includes(reference),
        ).length ?? 0;
        if (localArtifacts) {
          score += localArtifacts * 100;
          reasons.push(`${localArtifacts} local artifact(s)`);
        }
        if (
          workload.spec.checkpointReference &&
          node.localCheckpointReferences?.includes(workload.spec.checkpointReference)
        ) {
          score += 200;
          reasons.push('checkpoint local');
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
