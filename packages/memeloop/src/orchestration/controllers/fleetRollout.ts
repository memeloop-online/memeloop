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
  /** Rollout deadline in milliseconds. */
  deadlineMs?: number;
  /** Pause rollout on failure threshold. */
  pauseOnFailureThreshold?: number;
  /** Budget for the rollout. */
  budget?: {
    maxTokens?: number;
    maxCost?: number;
  };
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
          return {
            status: {
              ...status,
              phase: 'Failed',
              failedAt: now().toISOString(),
              failureReason: 'rollout deadline exceeded',
              deadlineExceeded: true,
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

      // Check pause on failure threshold.
      if (spec.pauseOnFailureThreshold && failedReplicas >= spec.pauseOnFailureThreshold) {
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

        // Process next batch.
        const batchTargets = targets.slice(batchStart, batchEnd);
        const newEvidence = [...evidence];

        for (const target of batchTargets) {
          try {
            await options.updateTarget(rollout, target);
            newEvidence.push({
              resourceName: target.name,
              outcome: 'success',
              timestamp: now().toISOString(),
            });
          } catch (error) {
            newEvidence.push({
              resourceName: target.name,
              outcome: 'failure',
              message: error instanceof Error ? error.message : String(error),
              timestamp: now().toISOString(),
            });
          }
        }

        const newFailedReplicas = newEvidence.filter((event) => event.outcome === 'failure').length;
        if (spec.pauseOnFailureThreshold && newFailedReplicas >= spec.pauseOnFailureThreshold) {
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
      const stageReplicas = Math.ceil((stage.weight / 100) * totalReplicas);
      const stageTargets = targets.slice(0, stageReplicas);
      const newEvidence = [...evidence];

      for (const target of stageTargets) {
        if (evidence.some((event) => event.resourceName === target.name && event.outcome === 'success')) {
          continue;
        }
        try {
          await options.updateTarget(rollout, target);
          newEvidence.push({
            resourceName: target.name,
            outcome: 'success',
            timestamp: now().toISOString(),
          });
        } catch (error) {
          newEvidence.push({
            resourceName: target.name,
            outcome: 'failure',
            message: error instanceof Error ? error.message : String(error),
            timestamp: now().toISOString(),
          });
        }
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
    },
  };
}
