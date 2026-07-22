import type { OrchestrationResource } from '../client.js';
import type { Controller, ControllerReconcileResult } from '../controllerRunner.js';
import type { ControlStore, ControlStoreActor } from '../controlStore.js';

export const FLEET_ROLLOUT_API_VERSION = 'fleet.memeloop.io/v1alpha1';
export const FLEET_ROLLOUT_KIND = 'FleetRollout';

export type RolloutStrategy = 'batch' | 'canary';

export interface FleetRolloutSpec {
  /** Target resource kind to roll out (e.g. AgentWorkload). */
  targetKind: string;
  /** Target namespace. */
  targetNamespace?: string;
  /** Label selector for target resources. */
  selector?: Record<string, string>;
  /** Rollout strategy. */
  strategy: RolloutStrategy;
  /** Batch size for batch strategy. */
  batchSize?: number;
  /** Canary stages for canary strategy. */
  canaryStages?: Array<{
    weight: number;
    pauseDurationMs?: number;
  }>;
  /** Maximum unavailable resources during rollout. */
  maxUnavailable?: number;
  /** Maximum surge resources during rollout. */
  maxSurge?: number;
  /** Maximum concurrent target updates (default: 1 = sequential). */
  maxConcurrency?: number;
  /** Rollout deadline in milliseconds. */
  deadlineMs?: number;
  /** Pause rollout on failure threshold. */
  pauseOnFailureThreshold?: number;
  /**
   * Pause when at least this many targets report drift — the host observed
   * their actual state diverging from the desired template (§8.4/§8.8).
   */
  pauseOnDriftThreshold?: number;
  /**
   * Pause when at least this many targets carry host-reported security
   * findings (§8.8). Fail-safe recommendation: 1 (any finding pauses).
   */
  pauseOnSecurityThreshold?: number;
  /** Automatically rollback updated targets when failure threshold is reached. */
  autoRollback?: boolean;
  /**
   * Aggregate budget for the whole rollout (§8.8 cost threshold). Usage is
   * metered from per-target update results; the rollout pauses between
   * batches/stages once a limit is reached (overshoot is bounded by the
   * in-flight batch).
   */
  budget?: {
    maxTokens?: number;
    maxCost?: number;
  };
  /**
   * Per-run budget cap for a single target (§8: bounded per-run model
   * budget). A target whose reported usage exceeds the cap counts as a
   * failure with a budget reason.
   */
  perTargetBudget?: {
    maxTokens?: number;
    maxCost?: number;
  };
}

/** Metered model usage reported by a target update (tokens/cost). */
export interface TargetUsage {
  tokens?: number;
  cost?: number;
}

/** Result of updating one target; usage feeds rollout budget accounting. */
export interface TargetUpdateResult {
  usage?: TargetUsage;
}

export interface RolloutEvidenceEntry {
  resourceName: string;
  outcome: 'success' | 'failure' | 'skipped';
  message?: string;
  timestamp: string;
  /** Metered model usage for this target's run. */
  usage?: TargetUsage;
}

/** Sum metered usage across evidence entries (idempotent accounting). */
export function sumEvidenceUsage(evidence: readonly RolloutEvidenceEntry[] | undefined): { tokens: number; cost: number } {
  let tokens = 0;
  let cost = 0;
  for (const event of evidence ?? []) {
    tokens += event.usage?.tokens ?? 0;
    cost += event.usage?.cost ?? 0;
  }
  // Round float noise from per-target cost accumulation (deterministic status).
  return { tokens: Math.round(tokens * 1e6) / 1e6, cost: Math.round(cost * 1e6) / 1e6 };
}

function budgetExceeded(budget: FleetRolloutSpec['budget'], consumed: { tokens: number; cost: number }): string | undefined {
  if (!budget) return undefined;
  if (budget.maxTokens !== undefined && consumed.tokens >= budget.maxTokens) {
    return `tokens ${consumed.tokens} >= ${budget.maxTokens}`;
  }
  if (budget.maxCost !== undefined && consumed.cost >= budget.maxCost) {
    return `cost ${consumed.cost} >= ${budget.maxCost}`;
  }
  return undefined;
}

function perTargetBudgetExceeded(cap: FleetRolloutSpec['perTargetBudget'], usage: TargetUsage | undefined): string | undefined {
  if (!cap || !usage) return undefined;
  if (cap.maxTokens !== undefined && (usage.tokens ?? 0) > cap.maxTokens) {
    return `tokens ${usage.tokens} > per-run cap ${cap.maxTokens}`;
  }
  if (cap.maxCost !== undefined && (usage.cost ?? 0) > cap.maxCost) {
    return `cost ${usage.cost} > per-run cap ${cap.maxCost}`;
  }
  return undefined;
}

/**
 * Process targets with bounded concurrency. Returns evidence for each target.
 * Targets exceeding the per-run budget cap are converted to failures (§8).
 */
async function processTargetsBounded(
  targets: RolloutTarget[],
  updateFunction: (target: RolloutTarget) => Promise<TargetUpdateResult | undefined>,
  maxConcurrency: number,
  now: () => Date,
  perTargetBudget?: FleetRolloutSpec['perTargetBudget'],
): Promise<RolloutEvidenceEntry[]> {
  const results: RolloutEvidenceEntry[] = [];
  const queue = [...targets];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const target = queue.shift()!;
      try {
        const result = await updateFunction(target);
        const budgetViolation = perTargetBudgetExceeded(perTargetBudget, result?.usage);
        if (budgetViolation) {
          results.push({
            resourceName: target.name,
            outcome: 'failure',
            message: `per-target budget exceeded: ${budgetViolation}`,
            timestamp: now().toISOString(),
            ...(result?.usage ? { usage: result.usage } : {}),
          });
        } else {
          results.push({
            resourceName: target.name,
            outcome: 'success',
            timestamp: now().toISOString(),
            ...(result?.usage ? { usage: result.usage } : {}),
          });
        }
      } catch (error) {
        results.push({
          resourceName: target.name,
          outcome: 'failure',
          message: error instanceof Error ? error.message : String(error),
          timestamp: now().toISOString(),
        });
      }
    }
  }

  const concurrency = Math.min(maxConcurrency, targets.length);
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

export interface FleetRolloutStatus {
  phase?: 'Pending' | 'Rolling' | 'Paused' | 'Completed' | 'Failed' | 'RolledBack';
  currentBatch?: number;
  currentCanaryStage?: number;
  updatedReplicas?: number;
  readyReplicas?: number;
  availableReplicas?: number;
  unavailableReplicas?: number;
  observedGeneration?: number;
  startedAt?: string;
  completedAt?: string;
  pausedAt?: string;
  pauseReason?: string;
  failedAt?: string;
  failureReason?: string;
  deadlineExceeded?: boolean;
  rollbackReason?: string;
  /** Aggregate metered usage across all processed targets (§8 cost). */
  consumedBudget?: { tokens: number; cost: number };
  evidence?: RolloutEvidenceEntry[];
}

export type FleetRolloutResource = OrchestrationResource<FleetRolloutSpec>;

export interface RolloutTarget {
  name: string;
  namespace?: string;
  generation: number;
  available: boolean;
  /** Host observation: actual state diverged from the desired template (§8.4). */
  drifted?: boolean;
  /** Host-reported security finding on this target (§8.8). */
  securityFlagged?: boolean;
}

export interface FleetRolloutControllerOptions {
  actor: ControlStoreActor;
  listTargets: (rollout: FleetRolloutResource) => Promise<RolloutTarget[]>;
  updateTarget: (rollout: FleetRolloutResource, target: RolloutTarget) => Promise<TargetUpdateResult | undefined>;
  rollbackTarget: (rollout: FleetRolloutResource, target: RolloutTarget) => Promise<void>;
  now?: () => Date;
}

/**
 * Create a controller that manages FleetRollout resources.
 *
 * The controller implements batch and canary rollout strategies with
 * maxUnavailable, pause on failure, deadline, and rollback support.
 */
export function createFleetRolloutController(
  _store: ControlStore,
  options: FleetRolloutControllerOptions,
): Controller<FleetRolloutSpec> {
  const now = options.now ?? (() => new Date());

  async function reconcileRollout(request: Parameters<Controller<FleetRolloutSpec>['reconcile']>[0]): Promise<ControllerReconcileResult> {
    const rollout = request.resource as FleetRolloutResource;
    const status: FleetRolloutStatus = rollout.status ?? {};
    const spec = rollout.spec;

    // Skip completed or failed rollouts.
    if (status.phase === 'Completed' || status.phase === 'Failed' || status.phase === 'RolledBack') {
      return { ready: true };
    }

    // Initialize rollout on first reconcile.
    if (!status.phase) {
      return {
        status: {
          ...status,
          phase: 'Rolling',
          currentBatch: 0,
          currentCanaryStage: 0,
          updatedReplicas: 0,
          readyReplicas: 0,
          availableReplicas: 0,
          unavailableReplicas: 0,
          startedAt: now().toISOString(),
          evidence: [],
        } as FleetRolloutStatus,
        ready: false,
      };
    }

    // Check deadline.
    const deadlineMs: number | undefined = spec.deadlineMs;
    const startedAt: string | undefined = status.startedAt;
    if (deadlineMs && startedAt) {
      const elapsed = now().getTime() - new Date(startedAt).getTime();
      if (elapsed > deadlineMs) {
        if (spec.autoRollback) {
          const targets = await options.listTargets(rollout);
          const updatedTargets = (status.evidence ?? [])
            .filter((event) => event.outcome === 'success')
            .map((event) => targets.find((t) => t.name === event.resourceName))
            .filter((t): t is RolloutTarget => t !== undefined);
          for (const target of updatedTargets) {
            try {
              await options.rollbackTarget(rollout, target);
            } catch { /* best-effort */ }
          }
        }
        return {
          status: {
            ...status,
            phase: spec.autoRollback ? 'RolledBack' : 'Failed',
            failedAt: now().toISOString(),
            failureReason: 'rollout deadline exceeded',
            deadlineExceeded: true,
            rollbackReason: spec.autoRollback ? 'deadline exceeded' : undefined,
          } as FleetRolloutStatus,
          ready: true,
        };
      }
    }

    // Check pause.
    if (status.phase === 'Paused') {
      return { ready: true };
    }

    const targets = await options.listTargets(rollout);
    const evidence: NonNullable<FleetRolloutStatus['evidence']> = status.evidence ?? [];

    // Count current state.
    const totalReplicas = targets.length;
    const updatedReplicas = evidence.filter((event) => event.outcome === 'success').length;
    const failedReplicas = evidence.filter((event) => event.outcome === 'failure').length;
    const availableReplicas = targets.filter((t) => t.available).length;
    const unavailableReplicas = totalReplicas - availableReplicas;

    // §8.8 automatic pause thresholds: security first (fail-safe), then
    // drift, then aggregate cost. These pause for human/verifier decision;
    // autoRollback remains scoped to failure threshold and deadline.
    const securityFlagged = targets.filter((t) => t.securityFlagged).length;
    if (spec.pauseOnSecurityThreshold !== undefined && securityFlagged >= spec.pauseOnSecurityThreshold) {
      return {
        status: {
          ...status,
          phase: 'Paused',
          pausedAt: now().toISOString(),
          pauseReason: `security threshold exceeded: ${securityFlagged} flagged >= ${spec.pauseOnSecurityThreshold}`,
          updatedReplicas,
          readyReplicas: updatedReplicas,
          availableReplicas,
          unavailableReplicas,
          evidence,
        } as FleetRolloutStatus,
        ready: true,
      };
    }

    const driftedCount = targets.filter((t) => t.drifted).length;
    if (spec.pauseOnDriftThreshold !== undefined && driftedCount >= spec.pauseOnDriftThreshold) {
      return {
        status: {
          ...status,
          phase: 'Paused',
          pausedAt: now().toISOString(),
          pauseReason: `drift threshold exceeded: ${driftedCount} drifted >= ${spec.pauseOnDriftThreshold}`,
          updatedReplicas,
          readyReplicas: updatedReplicas,
          availableReplicas,
          unavailableReplicas,
          evidence,
        } as FleetRolloutStatus,
        ready: true,
      };
    }

    const budgetViolation = budgetExceeded(spec.budget, sumEvidenceUsage(evidence));
    if (budgetViolation) {
      return {
        status: {
          ...status,
          phase: 'Paused',
          pausedAt: now().toISOString(),
          pauseReason: `rollout budget exceeded: ${budgetViolation}`,
          updatedReplicas,
          readyReplicas: updatedReplicas,
          availableReplicas,
          unavailableReplicas,
          evidence,
        } as FleetRolloutStatus,
        ready: true,
      };
    }

    // Enforce maxUnavailable: pause if too many targets are unavailable.
    if (spec.maxUnavailable !== undefined && unavailableReplicas > spec.maxUnavailable) {
      return {
        status: {
          ...status,
          phase: 'Paused',
          pausedAt: now().toISOString(),
          pauseReason: `maxUnavailable exceeded: ${unavailableReplicas} unavailable > ${spec.maxUnavailable} max`,
          updatedReplicas,
          readyReplicas: updatedReplicas,
          availableReplicas,
          unavailableReplicas,
          evidence,
        } as FleetRolloutStatus,
        ready: true,
      };
    }

    // Check pause on failure threshold.
    if (spec.pauseOnFailureThreshold && failedReplicas >= spec.pauseOnFailureThreshold) {
      if (spec.autoRollback) {
        const updatedTargets = evidence
          .filter((event) => event.outcome === 'success')
          .map((event) => targets.find((t) => t.name === event.resourceName))
          .filter((t): t is RolloutTarget => t !== undefined);
        for (const target of updatedTargets) {
          try {
            await options.rollbackTarget(rollout, target);
          } catch { /* best-effort */ }
        }
        return {
          status: {
            ...status,
            phase: 'RolledBack',
            pausedAt: now().toISOString(),
            pauseReason: `failure threshold reached: ${failedReplicas} failures`,
            rollbackReason: `auto-rollback: ${failedReplicas} failures`,
            updatedReplicas: 0,
            readyReplicas: 0,
            availableReplicas,
            unavailableReplicas,
            evidence,
          } as FleetRolloutStatus,
          ready: true,
        };
      }
      return {
        status: {
          ...status,
          phase: 'Paused',
          pausedAt: now().toISOString(),
          pauseReason: `failure threshold reached: ${failedReplicas} failures`,
          updatedReplicas,
          readyReplicas: updatedReplicas,
          availableReplicas,
          unavailableReplicas,
          evidence,
        } as FleetRolloutStatus,
        ready: true,
      };
    }

    // Determine next batch or canary stage.
    if (spec.strategy === 'batch') {
      const batchSize = spec.batchSize ?? 1;
      const maxConcurrency = spec.maxConcurrency ?? 1;
      const currentBatch: number = status.currentBatch ?? 0;
      const batchStart = currentBatch * batchSize;
      const batchEnd = Math.min(batchStart + batchSize, totalReplicas);

      if (batchStart >= totalReplicas) {
        // Rollout complete.
        return {
          status: {
            ...status,
            phase: 'Completed',
            completedAt: now().toISOString(),
            updatedReplicas,
            readyReplicas: updatedReplicas,
            availableReplicas,
            unavailableReplicas,
            evidence,
          } as FleetRolloutStatus,
          ready: true,
        };
      }

      // Process next batch with bounded concurrency.
      const batchTargets = targets.slice(batchStart, batchEnd);
      const batchEvidence = await processTargetsBounded(
        batchTargets,
        (target) => options.updateTarget(rollout, target),
        maxConcurrency,
        now,
        spec.perTargetBudget,
      );
      const newEvidence = [...evidence, ...batchEvidence];

      const batchBudgetViolation = budgetExceeded(spec.budget, sumEvidenceUsage(newEvidence));
      if (batchBudgetViolation) {
        return {
          status: {
            ...status,
            phase: 'Paused',
            pausedAt: now().toISOString(),
            pauseReason: `rollout budget exceeded: ${batchBudgetViolation}`,
            updatedReplicas: newEvidence.filter((event) => event.outcome === 'success').length,
            readyReplicas: newEvidence.filter((event) => event.outcome === 'success').length,
            availableReplicas,
            unavailableReplicas,
            evidence: newEvidence,
          } as FleetRolloutStatus,
          ready: true,
        };
      }

      const newFailedReplicas = newEvidence.filter((event) => event.outcome === 'failure').length;
      if (spec.pauseOnFailureThreshold && newFailedReplicas >= spec.pauseOnFailureThreshold) {
        if (spec.autoRollback) {
          const updatedTargets = newEvidence
            .filter((event) => event.outcome === 'success')
            .map((event) => targets.find((t) => t.name === event.resourceName))
            .filter((t): t is RolloutTarget => t !== undefined);
          for (const target of updatedTargets) {
            try {
              await options.rollbackTarget(rollout, target);
            } catch { /* best-effort */ }
          }
          return {
            status: {
              ...status,
              phase: 'RolledBack',
              pausedAt: now().toISOString(),
              pauseReason: `failure threshold reached: ${newFailedReplicas} failures`,
              rollbackReason: `auto-rollback: ${newFailedReplicas} failures`,
              updatedReplicas: 0,
              readyReplicas: 0,
              availableReplicas,
              unavailableReplicas,
              evidence: newEvidence,
            } as FleetRolloutStatus,
            ready: true,
          };
        }
        return {
          status: {
            ...status,
            phase: 'Paused',
            pausedAt: now().toISOString(),
            pauseReason: `failure threshold reached: ${newFailedReplicas} failures`,
            updatedReplicas: newEvidence.filter((event) => event.outcome === 'success').length,
            readyReplicas: newEvidence.filter((event) => event.outcome === 'success').length,
            availableReplicas,
            unavailableReplicas,
            evidence: newEvidence,
          } as FleetRolloutStatus,
          ready: true,
        };
      }

      return {
        status: {
          ...status,
          phase: 'Rolling',
          currentBatch: currentBatch + 1,
          updatedReplicas: newEvidence.filter((event) => event.outcome === 'success').length,
          readyReplicas: newEvidence.filter((event) => event.outcome === 'success').length,
          availableReplicas,
          unavailableReplicas,
          evidence: newEvidence,
        } as FleetRolloutStatus,
        ready: false,
        requeueAfterMs: 1000,
      };
    }

    // Canary strategy.
    const stages = spec.canaryStages ?? [{ weight: 100 }];
    const currentStage = status.currentCanaryStage ?? 0;

    if (currentStage >= stages.length) {
      return {
        status: {
          ...status,
          phase: 'Completed',
          completedAt: now().toISOString(),
          updatedReplicas,
          readyReplicas: updatedReplicas,
          availableReplicas,
          unavailableReplicas,
          evidence,
        } as FleetRolloutStatus,
        ready: true,
      };
    }

    const stage = stages[currentStage];
    const maxConcurrency = spec.maxConcurrency ?? 1;
    const stageReplicas = Math.ceil((stage.weight / 100) * totalReplicas);
    const stageTargets = targets.slice(0, stageReplicas).filter(
      (t) => !evidence.some((event) => event.resourceName === t.name && event.outcome === 'success'),
    );
    const stageEvidence = await processTargetsBounded(
      stageTargets,
      (target) => options.updateTarget(rollout, target),
      maxConcurrency,
      now,
      spec.perTargetBudget,
    );
    const newEvidence = [...evidence, ...stageEvidence];

    const stageBudgetViolation = budgetExceeded(spec.budget, sumEvidenceUsage(newEvidence));
    if (stageBudgetViolation) {
      return {
        status: {
          ...status,
          phase: 'Paused',
          pausedAt: now().toISOString(),
          pauseReason: `rollout budget exceeded: ${stageBudgetViolation}`,
          updatedReplicas: newEvidence.filter((event) => event.outcome === 'success').length,
          readyReplicas: newEvidence.filter((event) => event.outcome === 'success').length,
          availableReplicas,
          unavailableReplicas,
          evidence: newEvidence,
        } as FleetRolloutStatus,
        ready: true,
      };
    }

    const stagePauseMs = stage.pauseDurationMs ?? 0;
    return {
      status: {
        ...status,
        phase: 'Rolling',
        currentCanaryStage: currentStage + 1,
        updatedReplicas: newEvidence.filter((event) => event.outcome === 'success').length,
        readyReplicas: newEvidence.filter((event) => event.outcome === 'success').length,
        availableReplicas,
        unavailableReplicas,
        evidence: newEvidence,
      } as FleetRolloutStatus,
      ready: false,
      requeueAfterMs: stagePauseMs > 0 ? stagePauseMs : 1000,
    };
  }

  return {
    async reconcile(request): Promise<ControllerReconcileResult> {
      const result = await reconcileRollout(request);
      // Aggregate budget accounting is derived from evidence on every path so
      // no return site can forget it (idempotent: recomputed, not accumulated).
      if (result.status) {
        result.status = {
          ...result.status,
          consumedBudget: sumEvidenceUsage((result.status as FleetRolloutStatus).evidence),
        } as FleetRolloutStatus;
      }
      return result;
    },
  };
}
