import { describe, expect, it, vi } from 'vitest';

import { createControllerRunner } from '../controllerRunner.js';
import {
  createFleetRolloutController,
  FLEET_ROLLOUT_API_VERSION,
  FLEET_ROLLOUT_KIND,
  type FleetRolloutControllerOptions,
  type FleetRolloutResource,
  type FleetRolloutSpec,
  type FleetRolloutStatus,
  type RolloutTarget,
} from '../controllers/fleetRollout.js';
import type { ControlStoreActor } from '../controlStore.js';
import { QuorumControlStore } from '../stores/quorumControlStore.js';

const actor: ControlStoreActor = { id: 'controller/fleet-scale', kind: 'controller' };

/**
 * Plan 24.60 scale acceptance: hundreds of restricted fake workers running
 * local loops/models under bounded concurrency and budget, with automatic
 * pauses on failure/drift/cost/security thresholds (§8.8).
 *
 * A "fake worker" is a simulated restricted node whose update runs a local
 * loop against a local model — an async token stream metered exactly the way
 * a gateway would meter it (§8.2/§8.6: compact usage evidence, no raw logs).
 */

interface FakeWorker {
  name: string;
  tokensPerRun: number;
  fail?: boolean;
}

async function runFakeWorkerLoop(worker: FakeWorker): Promise<{ tokens: number; cost: number }> {
  if (worker.fail) throw new Error(`worker ${worker.name} repair failed`);
  let tokens = 0;
  const localModelStream = (async function*() {
    for (let index = 0; index < worker.tokensPerRun; index += 1) {
      await Promise.resolve();
      yield `tok${index}`;
    }
  })();
  for await (const _chunk of localModelStream) tokens += 1;
  return { tokens, cost: tokens * 0.001 };
}

function makeWorkers(count: number, tokensPerRun = 5, failing: Set<number> = new Set()): FakeWorker[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `worker-${index}`,
    tokensPerRun,
    fail: failing.has(index),
  }));
}

function makeRollout(spec: Partial<FleetRolloutSpec>, status?: FleetRolloutStatus): FleetRolloutResource {
  return {
    apiVersion: FLEET_ROLLOUT_API_VERSION,
    kind: FLEET_ROLLOUT_KIND,
    metadata: { name: 'fleet-scale', namespace: 'fleet', uid: 'uid-fleet-scale', generation: 1, resourceVersion: '1', creationTimestamp: '' },
    spec: { targetKind: 'AgentWorkload', strategy: 'batch', ...spec },
    ...(status ? { status } : {}),
  };
}

/** Deterministic reconcile driver: feeds returned status back until ready. */
async function driveRollout(
  controllerOptions: FleetRolloutControllerOptions,
  spec: Partial<FleetRolloutSpec>,
  maxIterations = 500,
): Promise<FleetRolloutStatus> {
  const controller = createFleetRolloutController({} as never, controllerOptions);
  let rollout = makeRollout(spec);
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const result = await controller.reconcile({ resource: rollout, actor, leaseEpoch: '1', now: new Date() });
    if (result.status) rollout = { ...rollout, status: result.status as FleetRolloutStatus };
    if (result.ready) return rollout.status!;
  }
  throw new Error('rollout did not converge');
}

/** Bounded-concurrency tracker around the fake worker loop. */
function makeConcurrencyTrackingUpdate(workers: FakeWorker[]) {
  let inFlight = 0;
  let maxInFlight = 0;
  const updateTarget = vi.fn(async (_rollout: FleetRolloutResource, target: RolloutTarget) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const usage = await runFakeWorkerLoop(workers.find((worker) => worker.name === target.name)!);
      return { usage };
    } finally {
      inFlight -= 1;
    }
  });
  return { updateTarget, concurrency: () => maxInFlight };
}

const toTargets = (workers: FakeWorker[]): RolloutTarget[] => workers.map((worker) => ({ name: worker.name, namespace: 'fleet', generation: 1, available: true }));

describe('fleet rollout at scale (plan 24.60, §8)', () => {
  it('completes a 200-worker rollout under bounded concurrency with metered budget', async () => {
    const workers = makeWorkers(200);
    const { updateTarget, concurrency } = makeConcurrencyTrackingUpdate(workers);
    const status = await driveRollout(
      {
        actor,
        listTargets: async () => toTargets(workers),
        updateTarget,
        rollbackTarget: async () => {},
      },
      { batchSize: 25, maxConcurrency: 16, budget: { maxTokens: 1500 } },
    );

    expect(status.phase).toBe('Completed');
    expect(status.evidence).toHaveLength(200);
    expect(status.evidence!.every((event) => event.outcome === 'success')).toBe(true);
    // Every worker ran its local loop: 200 × 5 tokens metered from the streams.
    expect(status.consumedBudget).toEqual({ tokens: 1000, cost: 1 });
    expect(updateTarget).toHaveBeenCalledTimes(200);
    // Bounded concurrency: parallel but never above the cap.
    expect(concurrency()).toBeGreaterThan(1);
    expect(concurrency()).toBeLessThanOrEqual(16);
  });

  it('pauses when the aggregate rollout budget is exceeded, with bounded overshoot', async () => {
    const workers = makeWorkers(200);
    const { updateTarget } = makeConcurrencyTrackingUpdate(workers);
    const status = await driveRollout(
      {
        actor,
        listTargets: async () => toTargets(workers),
        updateTarget,
        rollbackTarget: async () => {},
      },
      { batchSize: 10, maxConcurrency: 10, budget: { maxTokens: 100 } },
    );

    expect(status.phase).toBe('Paused');
    expect(status.pauseReason).toContain('budget exceeded');
    expect(status.consumedBudget!.tokens).toBeGreaterThanOrEqual(100);
    // Overshoot is bounded by the in-flight batch, not the whole fleet.
    expect(status.evidence!.length).toBeLessThanOrEqual(30);
    expect(updateTarget.mock.calls.length).toBeLessThanOrEqual(30);
  });

  it('converts a worker exceeding its per-run budget into a failure and pauses', async () => {
    const workers = makeWorkers(20);
    workers[3] = { name: 'worker-3', tokensPerRun: 1000 }; // greedy runaway loop
    const { updateTarget } = makeConcurrencyTrackingUpdate(workers);
    const status = await driveRollout(
      {
        actor,
        listTargets: async () => toTargets(workers),
        updateTarget,
        rollbackTarget: async () => {},
      },
      { batchSize: 20, maxConcurrency: 4, perTargetBudget: { maxTokens: 100 }, pauseOnFailureThreshold: 1 },
    );

    expect(status.phase).toBe('Paused');
    expect(status.pauseReason).toContain('failure threshold');
    const failure = status.evidence!.find((event) => event.outcome === 'failure');
    expect(failure?.resourceName).toBe('worker-3');
    expect(failure?.message).toContain('per-target budget exceeded');
  });

  it('pauses on the drift threshold before touching any worker', async () => {
    const workers = makeWorkers(200);
    const updateTarget = vi.fn();
    const drifted = new Set([7, 42, 133]);
    const status = await driveRollout(
      {
        actor,
        listTargets: async () => toTargets(workers).map((target, index) => ({ ...target, drifted: drifted.has(index) })),
        updateTarget,
        rollbackTarget: async () => {},
      },
      { batchSize: 25, maxConcurrency: 8, pauseOnDriftThreshold: 3 },
    );

    expect(status.phase).toBe('Paused');
    expect(status.pauseReason).toContain('drift threshold exceeded');
    expect(updateTarget).not.toHaveBeenCalled();
  });

  it('pauses on the security threshold (fail-safe: a single finding stops the fleet)', async () => {
    const workers = makeWorkers(200);
    const updateTarget = vi.fn();
    const status = await driveRollout(
      {
        actor,
        listTargets: async () => toTargets(workers).map((target, index) => ({ ...target, securityFlagged: index === 99 })),
        updateTarget,
        rollbackTarget: async () => {},
      },
      { batchSize: 25, maxConcurrency: 8, pauseOnSecurityThreshold: 1 },
    );

    expect(status.phase).toBe('Paused');
    expect(status.pauseReason).toContain('security threshold exceeded');
    expect(updateTarget).not.toHaveBeenCalled();
  });

  it('runs end-to-end through the controller runner and quorum ControlStore at scale', async () => {
    const store = new QuorumControlStore({ memberId: 'fleet-voter', voters: ['fleet-voter'] });
    const workers = makeWorkers(150);
    const { updateTarget, concurrency } = makeConcurrencyTrackingUpdate(workers);

    const runner = await createControllerRunner(
      store,
      createFleetRolloutController(store, {
        actor,
        listTargets: async () => toTargets(workers),
        updateTarget,
        rollbackTarget: async () => {},
      }),
      {
        actor,
        leaseName: 'fleet-rollout-scale',
        watchKind: FLEET_ROLLOUT_KIND,
        leaseTtlMs: 10_000,
      },
    );

    try {
      await store.create(actor, {
        apiVersion: FLEET_ROLLOUT_API_VERSION,
        kind: FLEET_ROLLOUT_KIND,
        metadata: { name: 'fleet-scale', namespace: 'fleet' },
        spec: { targetKind: 'AgentWorkload', strategy: 'batch', batchSize: 50, maxConcurrency: 25 },
      });

      const reference = { apiVersion: FLEET_ROLLOUT_API_VERSION, kind: FLEET_ROLLOUT_KIND, name: 'fleet-scale', namespace: 'fleet' };
      let status: FleetRolloutStatus | undefined;
      await vi.waitFor(async () => {
        const resource = await store.get(reference);
        status = (resource?.status ?? undefined) as FleetRolloutStatus | undefined;
        expect(status?.phase).toBe('Completed');
      }, { timeout: 30_000, interval: 100 });

      expect(status!.evidence).toHaveLength(150);
      expect(status!.consumedBudget).toEqual({ tokens: 750, cost: 0.75 });
      expect(concurrency()).toBeLessThanOrEqual(25);
    } finally {
      await runner.stop();
      await store.close();
    }
  }, 45_000);
});
