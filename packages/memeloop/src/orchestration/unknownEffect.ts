import type { OrchestrationCondition } from './client.js';
import type { ToolOperationResource, ToolOperationStatus } from './resources.js';

/**
 * Condition type raised on a ToolOperation whose executor crashed or
 * disconnected after a side effect may have occurred. While this condition is
 * `True`, controllers must follow the recorded reconciliation decision instead
 * of blindly repeating the operation.
 */
export const TOOL_OPERATION_CONDITION_EFFECT_UNKNOWN = 'EffectUnknown';

/**
 * Evidence gathered by driver/controller inspection after an executor crash or
 * disconnect. Evidence is produced by the trusted side (driver checkpoints,
 * verifier probes, artifact records), never by the possibly-failed executor's
 * own claim alone.
 */
export interface UnknownEffectEvidence {
  /**
   * The executor produced a result before the disconnect and only the
   * completion acknowledgement was lost. The caller is responsible for
   * attaching the observed result when applying the decision.
   */
  resultObserved?: boolean;
  /** Reference to independent verification evidence (artifact, verifier run). */
  evidenceRef?: string;
  /** ISO timestamp of the observed disconnect/crash. */
  disconnectedAt?: string;
}

export type UnknownEffectAction = 'retry' | 'succeeded' | 'verification-required' | 'manual-intervention';

export interface UnknownEffectDecision {
  action: UnknownEffectAction;
  reason: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;

function attemptsOf(operation: ToolOperationResource): number {
  return operation.status?.attempts ?? 0;
}

function maxAttemptsOf(operation: ToolOperationResource): number {
  return operation.spec.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
}

/**
 * Decide how to reconcile an operation whose effect is unknown. The decision
 * never blindly repeats destructive work:
 *
 * 1. An observed result means only the ack was lost → `succeeded`.
 * 2. `read` effects have no side effects → `retry` (within attempt budget).
 * 3. `retry.nonRetryable` operations are never repeated → `manual-intervention`.
 * 4. Operations with an `idempotencyKey` dedupe at the executor/store, so a
 *    repeated delivery is safe → `retry` (within attempt budget).
 * 5. Everything else requires independent verification before any retry →
 *    `verification-required`.
 */
export function reconcileUnknownEffect(
  operation: ToolOperationResource,
  evidence: UnknownEffectEvidence,
): UnknownEffectDecision {
  if (evidence.resultObserved) {
    return { action: 'succeeded', reason: 'result was observed before the disconnect; only the ack was lost' };
  }

  if (operation.spec.retry?.nonRetryable) {
    return { action: 'manual-intervention', reason: 'operation is marked nonRetryable and its effect is unknown' };
  }

  const attempts = attemptsOf(operation);
  const maxAttempts = maxAttemptsOf(operation);
  const withinBudget = attempts < maxAttempts;

  if (operation.spec.effect === 'read') {
    if (withinBudget) {
      return { action: 'retry', reason: `read effect has no side effects (attempt ${attempts + 1}/${maxAttempts})` };
    }
    return { action: 'verification-required', reason: `read retry budget exhausted (${attempts}/${maxAttempts})` };
  }

  if (operation.spec.idempotencyKey) {
    if (withinBudget) {
      return {
        action: 'retry',
        reason: `idempotencyKey deduplicates repeated delivery (attempt ${attempts + 1}/${maxAttempts})`,
      };
    }
    return {
      action: 'verification-required',
      reason: `idempotent retry budget exhausted (${attempts}/${maxAttempts}); verify before further attempts`,
    };
  }

  return {
    action: 'verification-required',
    reason: `effect '${operation.spec.effect}' without idempotencyKey must be verified before any retry`,
  };
}

function effectUnknownCondition(decision: UnknownEffectDecision, at: string): OrchestrationCondition {
  return {
    type: TOOL_OPERATION_CONDITION_EFFECT_UNKNOWN,
    status: 'True',
    reason: decision.action,
    message: decision.reason,
    lastTransitionTime: at,
  };
}

/**
 * Apply a reconciliation decision to an operation, producing the next status:
 *
 * - `retry` → back to `Pending` (requeue) with the EffectUnknown condition.
 * - `succeeded` → `Completed` (caller attaches the observed result separately).
 * - `verification-required` / `manual-intervention` → stays `Running` with the
 *   EffectUnknown condition; the operation is not repeated until a verifier or
 *   operator clears the condition.
 */
export function applyUnknownEffectDecision(
  operation: ToolOperationResource,
  decision: UnknownEffectDecision,
  at: string = new Date().toISOString(),
): ToolOperationResource {
  const conditions = [
    ...(operation.status?.conditions ?? []).filter((c) => c.type !== TOOL_OPERATION_CONDITION_EFFECT_UNKNOWN),
    effectUnknownCondition(decision, at),
  ];

  const base: ToolOperationStatus = {
    ...operation.status,
    conditions,
  };

  if (decision.action === 'retry') {
    return { ...operation, status: { ...base, phase: 'Pending' } };
  }
  if (decision.action === 'succeeded') {
    return {
      ...operation,
      status: { ...base, phase: 'Completed', completedAt: at },
    };
  }
  return { ...operation, status: { ...base, phase: 'Running' } };
}
