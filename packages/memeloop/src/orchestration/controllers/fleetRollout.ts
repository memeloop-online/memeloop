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
  /** Automatically rollback updated targets when failure threshold is reached. */
  autoRollback?: boolean;
  /** Budget for the rollout. */
  budget?: {
    maxTokens?: number;
    maxCost?: number;
  };
}

/**
 * Process targets with bounded concurrency. Returns evidence for each target.
 */
async function processTargetsBounded(
  targets: RolloutTarget[],
  updateFunction: (target: RolloutTarget) => Promise<void>,
  maxConcurrency: number,
  now: () => Date,
): Promise<Array<{ resourceName: string; outcome: 'success' | 'failure'; message?: string; timestamp: string }>> {
  const results: Array<{ resourceName: string; outcome: 'success' | 'failure'; message?: string; timestamp: string }> = [];
  const queue = [...targets];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const target = queue.shift()!;
      try {
        await updateFunction(target);
        results.push({ resourceName: target.name, outcome: 'success', timestamp: now().toISOString() });
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
  evidence?: Array<{
    resourceName: string;
    outcome: 'success' | 'failure' | 'skipped';
    message?: string;
    timestamp: string;
  }>;
}

export type FleetRolloutResource = OrchestrationResource<FleetRolloutSpec>;

export interface RolloutTarget {
  name: string;
  namespace?: string;
  generation: number;
  available: boolean;
}

export interface FleetRolloutControllerOptions {
  actor: ControlStoreActor;
  listTargets: (rollout: FleetRolloutResource) => Promise<RolloutTarget[]>;
  updateTarget: (rollout: FleetRolloutResource, target: RolloutTarget) => Promise<void>;
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

  return {
    async reconcile(request): Promise<ControllerReconcileResult> {
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
        );
        const newEvidence = [...evidence, ...batchEvidence];

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
      );
      const newEvidence = [...evidence, ...stageEvidence];

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
    },
  };
}
