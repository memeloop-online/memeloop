import type { Controller, ControllerReconcileResult } from './controllerRunner.js';
import type { ControlStoreActor } from './controlStore.js';
import type { ToolExecutionDriver } from './drivers/toolExecutionDriver.js';
import { toOrchestrationErrorData } from './errors.js';
import {
  type NodeTrustClass,
  TOOL_EXECUTOR_API_VERSION,
  TOOL_EXECUTOR_KIND,
  type ToolExecutorResource,
  type ToolOperationResource,
  type ToolOperationStatus,
} from './resources.js';
import { redactSecrets } from './security/secretRedaction.js';

const TRUST_RANK: Record<NodeTrustClass, number> = {
  quarantine: 0,
  restricted: 1,
  trusted: 2,
};

const TERMINAL_PHASES = new Set(['Completed', 'Failed', 'Cancelled']);

export interface ToolExecutorSelection {
  executor: ToolExecutorResource;
  nodeId: string;
  score: number;
  reasons: string[];
}

/** Select a healthy, schema-compatible executor without loading its implementation. */
export function selectToolExecutor(
  operation: ToolOperationResource,
  executors: ToolExecutorResource[],
): ToolExecutorSelection | null {
  const placement = operation.spec.placement ?? {};
  const minimumTrust = placement.minimumTrust ?? 'restricted';
  const candidates: ToolExecutorSelection[] = [];

  for (const executor of executors) {
    const nodeId = executor.spec.nodeId;
    if (!nodeId || executor.status?.healthy === false) continue;
    if (placement.requiredNode && placement.requiredNode !== nodeId) continue;
    if (
      placement.nodeSelector && !Object.entries(placement.nodeSelector).every(
        ([key, value]) => executor.spec.selectors?.[key] === value,
      )
    ) continue;
    const trust = executor.spec.trust ?? 'quarantine';
    if (TRUST_RANK[trust] < TRUST_RANK[minimumTrust]) continue;

    const capability = executor.spec.capabilities.find((candidate) =>
      candidate.toolClassRef.name === operation.spec.toolRef.name &&
      (!operation.spec.toolRef.schemaDigest ||
        candidate.schemaDigest === operation.spec.toolRef.schemaDigest) &&
      candidate.health?.healthy !== false
    );
    if (!capability) continue;

    const maximum = capability.capacity?.maxConcurrent ?? 1;
    const queued = capability.capacity?.queueDepth ?? 0;
    const spare = maximum - queued;
    if (spare <= 0) continue;
    let score = spare * 100 + TRUST_RANK[trust] * 10;
    const reasons = [`schema ${capability.schemaDigest}`, `spare capacity ${spare}`];
    if (placement.preferredNode === nodeId) {
      score += 1000;
      reasons.push('preferred node');
    }
    candidates.push({ executor, nodeId, score, reasons });
  }

  candidates.sort((left, right) =>
    right.score - left.score ||
    (left.executor.metadata.name ?? '').localeCompare(right.executor.metadata.name ?? '')
  );
  return candidates[0] ?? null;
}

export interface ToolOperationBindingControllerOptions {
  actor: ControlStoreActor;
  listExecutors: () => Promise<ToolExecutorResource[]>;
  retryAfterMs?: number;
}

function withScheduledCondition(
  status: ToolOperationStatus,
  conditionStatus: 'True' | 'False',
  reason: string,
  now: Date,
): ToolOperationStatus {
  const conditions = (status.conditions ?? []).filter((condition) => condition.type !== 'Scheduled');
  conditions.push({
    type: 'Scheduled',
    status: conditionStatus,
    reason,
    lastTransitionTime: now.toISOString(),
  });
  return { ...status, conditions };
}

/**
 * Independently bind pending ToolOperations to declarative ToolExecutors.
 * Explicit external-orchestrator operations remain owned by that controller.
 */
export function createToolOperationBindingController(
  options: ToolOperationBindingControllerOptions,
): Controller<ToolOperationResource['spec']> {
  return {
    async reconcile(request): Promise<ControllerReconcileResult> {
      const operation = request.resource as ToolOperationResource;
      const status = operation.status ?? {};
      if (
        operation.spec.placement?.orchestrator ||
        TERMINAL_PHASES.has(status.phase ?? '') ||
        status.phase === 'Running' ||
        status.assignedExecutor
      ) {
        return { ready: true };
      }

      const selected = selectToolExecutor(operation, await options.listExecutors());
      if (!selected) {
        return {
          status: withScheduledCondition(
            { ...status, phase: 'Pending' },
            'False',
            'NoSuitableExecutor',
            request.now,
          ),
          ready: false,
          requeueAfterMs: options.retryAfterMs ?? 1000,
        };
      }

      const executor = selected.executor;
      return {
        status: withScheduledCondition(
          {
            ...status,
            phase: 'Pending',
            assignedNode: selected.nodeId,
            assignedDriver: executor.metadata.name,
            assignedExecutor: {
              apiVersion: TOOL_EXECUTOR_API_VERSION,
              kind: TOOL_EXECUTOR_KIND,
              name: executor.metadata.name,
              namespace: executor.metadata.namespace,
              uid: executor.metadata.uid,
            },
          },
          'True',
          `BoundTo ${executor.metadata.name}`,
          request.now,
        ),
        ready: true,
      };
    },
  };
}

export interface ToolOperationExecutionControllerOptions {
  actor: ControlStoreActor;
  nodeId: string;
  driver: ToolExecutionDriver;
}

function unknownEffectStatus(
  status: ToolOperationStatus,
  now: Date,
): ToolOperationStatus {
  const action = status.phase === 'Running' ? 'verification-required' : 'manual-intervention';
  const conditions = (status.conditions ?? []).filter((condition) => condition.type !== 'EffectUnknown');
  conditions.push({
    type: 'EffectUnknown',
    status: 'True',
    reason: action,
    lastTransitionTime: now.toISOString(),
  });
  return {
    ...status,
    phase: 'Failed',
    completedAt: now.toISOString(),
    result: {
      error: {
        code: 'UNKNOWN_EFFECT',
        message: 'tool executor fencing epoch changed after execution was claimed; effect requires external verification',
        retryable: false,
        reason: action,
      },
    },
    conditions,
  };
}

/**
 * Execute operations assigned to one node. Claiming and effect execution are
 * deliberately separate reconciles so the claim is durable before any side
 * effect starts.
 */
export function createToolOperationExecutionController(
  options: ToolOperationExecutionControllerOptions,
): Controller<ToolOperationResource['spec']> {
  return {
    async reconcile(request): Promise<ControllerReconcileResult> {
      const operation = request.resource as ToolOperationResource;
      const status = operation.status ?? {};
      if (
        operation.spec.placement?.orchestrator ||
        TERMINAL_PHASES.has(status.phase ?? '') ||
        status.assignedNode !== options.nodeId
      ) {
        return { ready: true };
      }

      if ((status.phase ?? 'Pending') === 'Pending') {
        return {
          status: {
            ...status,
            phase: 'Running',
            startedAt: status.startedAt ?? request.now.toISOString(),
            executionClaim: {
              leaseEpoch: request.leaseEpoch,
              claimedAt: request.now.toISOString(),
            },
          } as ToolOperationStatus,
          ready: false,
        };
      }

      if (status.phase !== 'Running' || !status.executionClaim) return { ready: true };
      if (status.executionClaim.leaseEpoch !== request.leaseEpoch) {
        if (operation.spec.effect === 'read') {
          return {
            status: {
              ...status,
              phase: 'Pending',
              executionClaim: undefined,
            } as ToolOperationStatus,
            ready: false,
          };
        }
        return { status: unknownEffectStatus(status, request.now), ready: true };
      }

      try {
        const executed = await options.driver.execute(operation);
        return {
          status: {
            ...executed.status,
            assignedDriver: status.assignedDriver,
            assignedNode: status.assignedNode,
            assignedExecutor: status.assignedExecutor,
            executionClaim: status.executionClaim,
          } as ToolOperationStatus,
          ready: true,
        };
      } catch (error) {
        return {
          status: {
            ...status,
            phase: 'Failed',
            completedAt: request.now.toISOString(),
            result: {
              error: redactSecrets(toOrchestrationErrorData(error)),
            },
          } as ToolOperationStatus,
          ready: true,
        };
      }
    },
  };
}
