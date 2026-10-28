import type { Controller } from './controllerRunner.js';
import type { ControlStoreActor } from './controlStore.js';
import type { AgentRunResource, AgentRunStatus, AgentWorkloadResource, DataClassification, ModelClassResource, ModelEndpointResource, NodeTrustClass } from './resources.js';

export interface ModelEndpointBindingControllerOptions {
  actor: ControlStoreActor;
  getWorkload(run: AgentRunResource): Promise<AgentWorkloadResource | null>;
  listEndpoints(): Promise<ModelEndpointResource[]>;
  getModelClass(endpoint: ModelEndpointResource): Promise<ModelClassResource | null>;
  /** Existing bindings used as conservative live capacity reservations. */
  listRuns?: () => Promise<AgentRunResource[]>;
  /** Maximum endpoint heartbeat age accepted for placement (default 90s). */
  endpointHeartbeatTtlMs?: number;
  /** Clock used only for the persisted binding timestamp. */
  now?: () => Date;
}

const TRUST_RANK: Record<NodeTrustClass, number> = {
  quarantine: 0,
  restricted: 1,
  trusted: 2,
};

const CLASSIFICATION_RANK: Record<DataClassification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

const DEFAULT_ENDPOINT_CLASSIFICATION: Record<NodeTrustClass, DataClassification> = {
  quarantine: 'public',
  restricted: 'internal',
  trusted: 'restricted',
};

interface Candidate {
  endpoint: ModelEndpointResource;
  modelClass: ModelClassResource;
  score: number;
}

function endpointReference(endpoint: ModelEndpointResource): NonNullable<AgentRunStatus['assignedModelEndpoint']> {
  return {
    apiVersion: endpoint.apiVersion,
    kind: endpoint.kind,
    name: endpoint.metadata.name,
    ...(endpoint.metadata.namespace !== undefined ? { namespace: endpoint.metadata.namespace } : {}),
    uid: endpoint.metadata.uid,
  };
}

function schedulingCondition(message: string, lastTransitionTime: string) {
  return {
    type: 'ModelEndpointScheduled',
    status: 'False' as const,
    reason: 'NoEligibleEndpoint',
    message,
    lastTransitionTime,
  };
}

function sameCondition(status: AgentRunStatus, message: string): boolean {
  const condition = status.conditions?.find((item) => item.type === 'ModelEndpointScheduled');
  return condition?.status === 'False' &&
    condition.reason === 'NoEligibleEndpoint' &&
    condition.message === message;
}

async function candidatesFor(
  workload: AgentWorkloadResource,
  endpoints: ModelEndpointResource[],
  getModelClass: ModelEndpointBindingControllerOptions['getModelClass'],
  nowMs: number,
  heartbeatTtlMs: number,
): Promise<Candidate[]> {
  const requiredClass = workload.spec.modelPolicy?.modelClass;
  if (!requiredClass) return [];
  const requiredTrust = workload.spec.trust ?? 'restricted';
  const requiredClassification = workload.spec.placement?.dataClassification ?? 'internal';
  const allowedResidencies = workload.spec.placement?.dataResidency;
  const allowedModelNames = workload.spec.modelPolicy?.allowedModelNames;
  const candidates: Candidate[] = [];

  for (const endpoint of endpoints) {
    if (endpoint.spec.modelClassRef.name !== requiredClass) continue;
    if (endpoint.status?.healthy !== true) continue;
    const heartbeatAt = Date.parse(endpoint.status.heartbeat ?? '');
    if (!Number.isFinite(heartbeatAt) || nowMs - heartbeatAt > heartbeatTtlMs) continue;
    const trust = endpoint.spec.trust ?? 'quarantine';
    if (TRUST_RANK[trust] < TRUST_RANK[requiredTrust]) continue;
    const maxConcurrent = endpoint.spec.capacity?.maxConcurrent ?? 0;
    const spare = maxConcurrent - (endpoint.status.activeCalls ?? 0);
    if (spare < 1) continue;
    const endpointClassification = endpoint.spec.dataPolicy?.classification as DataClassification | undefined ??
      DEFAULT_ENDPOINT_CLASSIFICATION[trust];
    if (
      !(endpointClassification in CLASSIFICATION_RANK) ||
      CLASSIFICATION_RANK[requiredClassification] > CLASSIFICATION_RANK[endpointClassification]
    ) {
      continue;
    }

    const modelClass = await getModelClass(endpoint);
    if (!modelClass) continue;
    if (modelClass.spec.digest && endpoint.spec.modelDigest !== modelClass.spec.digest) continue;
    if (allowedModelNames?.length && !allowedModelNames.includes(modelClass.spec.model)) continue;
    if (
      allowedResidencies?.length &&
      (!modelClass.spec.dataResidency || !allowedResidencies.includes(modelClass.spec.dataResidency))
    ) {
      continue;
    }

    const locality = endpoint.spec.nodeId === workload.status?.assignedNode ? 1000 : 0;
    candidates.push({ endpoint, modelClass, score: locality + spare });
  }

  return candidates.sort((left, right) =>
    right.score - left.score ||
    left.endpoint.metadata.name.localeCompare(right.endpoint.metadata.name)
  );
}

/**
 * Independently binds a Pending AgentRun to a live ModelEndpoint. The
 * controller re-evaluates every hard policy requirement itself and persists
 * the lease epoch before workload execution may consume the endpoint.
 */
export function createModelEndpointBindingController(
  options: ModelEndpointBindingControllerOptions,
): Controller<AgentRunResource['spec']> {
  const now = options.now ?? (() => new Date());
  const endpointHeartbeatTtlMs = options.endpointHeartbeatTtlMs ?? 90_000;
  return {
    async reconcile(request) {
      const run = request.resource as AgentRunResource;
      const status = run.status ?? {};
      const reconciledAtDate = now();
      const reconciledAt = reconciledAtDate.toISOString();
      if (status.phase && status.phase !== 'Pending') return { ready: true };

      const workload = await options.getWorkload(run);
      if (!workload) {
        const message = 'referenced AgentWorkload is unavailable';
        return {
          ...(sameCondition(status, message)
            ? {}
            : {
              status: {
                ...status,
                conditions: [
                  ...(status.conditions ?? []).filter((item) => item.type !== 'ModelEndpointScheduled'),
                  schedulingCondition(message, reconciledAt),
                ],
              } satisfies AgentRunStatus,
            }),
          requeueAfterMs: 1000,
        };
      }
      if (!workload.spec.modelPolicy?.modelClass) return { ready: true };

      const reservations = new Map<string, number>();
      for (const other of await options.listRuns?.() ?? []) {
        if (other.metadata.uid === run.metadata.uid) continue;
        if (
          other.status?.phase === 'Completed' ||
          other.status?.phase === 'Failed' ||
          other.status?.phase === 'Cancelled'
        ) continue;
        const endpointUid = other.status?.assignedModelEndpoint?.uid;
        if (endpointUid) reservations.set(endpointUid, (reservations.get(endpointUid) ?? 0) + 1);
      }
      const endpoints = (await options.listEndpoints()).map((endpoint) => ({
        ...endpoint,
        status: {
          ...endpoint.status,
          activeCalls: (endpoint.status?.activeCalls ?? 0) +
            (reservations.get(endpoint.metadata.uid) ?? 0),
        },
      }));
      const candidates = await candidatesFor(
        workload,
        endpoints,
        (endpoint) => options.getModelClass(endpoint),
        reconciledAtDate.getTime(),
        endpointHeartbeatTtlMs,
      );
      const selected = candidates[0]?.endpoint;
      if (!selected) {
        const message = `no healthy endpoint satisfies model class '${workload.spec.modelPolicy.modelClass}'`;
        const {
          assignedModelEndpoint: _assignedModelEndpoint,
          modelBinding: _modelBinding,
          ...unboundStatus
        } = status;
        return {
          ...(sameCondition(status, message) && !status.assignedModelEndpoint
            ? {}
            : {
              status: {
                ...unboundStatus,
                phase: 'Pending',
                conditions: [
                  ...(status.conditions ?? []).filter((item) => item.type !== 'ModelEndpointScheduled'),
                  schedulingCondition(message, reconciledAt),
                ],
              } satisfies AgentRunStatus,
            }),
          requeueAfterMs: 1000,
        };
      }

      if (
        status.assignedModelEndpoint?.uid === selected.metadata.uid &&
        status.modelBinding?.endpointResourceVersion === selected.metadata.resourceVersion &&
        status.modelBinding.leaseEpoch === request.leaseEpoch
      ) {
        return { ready: true };
      }
      return {
        status: {
          ...status,
          phase: 'Pending',
          assignedModelEndpoint: endpointReference(selected),
          modelBinding: {
            leaseEpoch: request.leaseEpoch,
            endpointResourceVersion: selected.metadata.resourceVersion,
            boundAt: reconciledAt,
          },
          conditions: [
            ...(status.conditions ?? []).filter((item) => item.type !== 'ModelEndpointScheduled'),
            {
              type: 'ModelEndpointScheduled',
              status: 'True',
              reason: 'EndpointSelected',
              message: `bound to ModelEndpoint '${selected.metadata.name}'`,
              lastTransitionTime: reconciledAt,
            },
          ],
        } satisfies AgentRunStatus,
        ready: true,
      };
    },
  };
}
