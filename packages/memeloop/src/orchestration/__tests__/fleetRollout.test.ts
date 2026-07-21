import { describe, expect, it, vi } from 'vitest';

import type { ControllerReconcileRequest } from '../controllerRunner.js';
import {
  createFleetRolloutController,
  FLEET_ROLLOUT_KIND,
  type FleetRolloutResource,
  type FleetRolloutSpec,
  type FleetRolloutStatus,
  type RolloutTarget,
} from '../controllers/fleetRollout.js';
import type { ControlStore } from '../controlStore.js';

function makeStore(): ControlStore {
  return {} as ControlStore;
}

function makeRollout(
  name: string,
  spec: Partial<FleetRolloutSpec>,
  status?: FleetRolloutStatus,
): FleetRolloutResource {
  return {
    apiVersion: 'fleet.memeloop.io/v1alpha1',
    kind: FLEET_ROLLOUT_KIND,
    metadata: {
      name,
      namespace: 'default',
      uid: `uid-${name}`,
      generation: 1,
      resourceVersion: '1',
      creationTimestamp: '2026-07-18T00:00:00.000Z',
    },
    spec: {
      targetKind: 'AgentWorkload',
      strategy: 'batch',
      ...spec,
    },
    status,
  };
}

function makeTarget(name: string, available = true): RolloutTarget {
  return {
    name,
    namespace: 'default',
    generation: 1,
    available,
  };
}

function makeRequest(
  rollout: FleetRolloutResource,
): ControllerReconcileRequest<FleetRolloutSpec> {
  return {
    resource: rollout,
    actor: { id: 'controller/fleet', kind: 'controller' },
    leaseEpoch: '1',
    now: new Date('2026-07-18T00:00:00.000Z'),
  };
}

describe('createFleetRolloutController', () => {
  it('initializes rollout on first reconcile', async () => {
    const store = makeStore();
    const listTargets = vi.fn(async () => [makeTarget('target-1')]);
    const updateTarget = vi.fn();
    const rollbackTarget = vi.fn();

    const controller = createFleetRolloutController(store, {
      actor: { id: 'controller/fleet', kind: 'controller' },
      listTargets,
      updateTarget,
      rollbackTarget,
    });

    const rollout = makeRollout('rollout-1', { batchSize: 1 });
    const result = await controller.reconcile(makeRequest(rollout));

    expect(result.status?.phase).toBe('Rolling');
    expect(result.status?.currentBatch).toBe(0);
    expect(result.status?.startedAt).toBeDefined();
  });

  it('processes batch rollout', async () => {
    const store = makeStore();
    const listTargets = vi.fn(async () => [
      makeTarget('target-1'),
      makeTarget('target-2'),
      makeTarget('target-3'),
    ]);
    const updateTarget = vi.fn(async () => {});
    const rollbackTarget = vi.fn();

    const controller = createFleetRolloutController(store, {
      actor: { id: 'controller/fleet', kind: 'controller' },
      listTargets,
      updateTarget,
      rollbackTarget,
    });

    const rollout = makeRollout('rollout-1', { batchSize: 2 }, { phase: 'Rolling', currentBatch: 0, evidence: [] });
    const result = await controller.reconcile(makeRequest(rollout));

    expect(result.status?.phase).toBe('Rolling');
    expect(result.status?.currentBatch).toBe(1);
    expect(updateTarget).toHaveBeenCalledTimes(2);
    expect(result.status?.evidence?.filter((e) => e.outcome === 'success')).toHaveLength(2);
  });

  it('completes batch rollout when all targets processed', async () => {
    const store = makeStore();
    const listTargets = vi.fn(async () => [makeTarget('target-1')]);
    const updateTarget = vi.fn(async () => {});
    const rollbackTarget = vi.fn();

    const controller = createFleetRolloutController(store, {
      actor: { id: 'controller/fleet', kind: 'controller' },
      listTargets,
      updateTarget,
      rollbackTarget,
    });

    const rollout = makeRollout('rollout-1', { batchSize: 1 }, {
      phase: 'Rolling',
      currentBatch: 1,
      evidence: [{ resourceName: 'target-1', outcome: 'success', timestamp: '2026-07-18T00:00:00.000Z' }],
    });
    const result = await controller.reconcile(makeRequest(rollout));

    expect(result.status?.phase).toBe('Completed');
    expect(result.status?.completedAt).toBeDefined();
  });

  it('pauses rollout on failure threshold', async () => {
    const store = makeStore();
    const listTargets = vi.fn(async () => [makeTarget('target-1'), makeTarget('target-2')]);
    const updateTarget = vi.fn(async (_rollout, target) => {
      if (target.name === 'target-2') throw new Error('update failed');
    });
    const rollbackTarget = vi.fn();

    const controller = createFleetRolloutController(store, {
      actor: { id: 'controller/fleet', kind: 'controller' },
      listTargets,
      updateTarget,
      rollbackTarget,
    });

    const rollout = makeRollout('rollout-1', { batchSize: 2, pauseOnFailureThreshold: 1 }, {
      phase: 'Rolling',
      currentBatch: 0,
      evidence: [],
    });
    const result = await controller.reconcile(makeRequest(rollout));

    expect(result.status?.phase).toBe('Paused');
    expect(result.status?.pauseReason).toContain('failure threshold reached');
  });

  it('handles canary rollout with stages', async () => {
    const store = makeStore();
    const listTargets = vi.fn(async () => [
      makeTarget('target-1'),
      makeTarget('target-2'),
      makeTarget('target-3'),
      makeTarget('target-4'),
    ]);
    const updateTarget = vi.fn(async () => {});
    const rollbackTarget = vi.fn();

    const controller = createFleetRolloutController(store, {
      actor: { id: 'controller/fleet', kind: 'controller' },
      listTargets,
      updateTarget,
      rollbackTarget,
    });

    const rollout = makeRollout('rollout-1', {
      strategy: 'canary',
      canaryStages: [
        { weight: 50, pauseDurationMs: 5000 },
        { weight: 100 },
      ],
    }, { phase: 'Rolling', currentCanaryStage: 0, evidence: [] });

    const result = await controller.reconcile(makeRequest(rollout));

    expect(result.status?.phase).toBe('Rolling');
    expect(result.status?.currentCanaryStage).toBe(1);
    expect(result.requeueAfterMs).toBe(5000);
    expect(updateTarget).toHaveBeenCalledTimes(2); // 50% of 4 targets
  });

  it('fails rollout on deadline exceeded', async () => {
    const store = makeStore();
    const listTargets = vi.fn(async () => [makeTarget('target-1')]);
    const updateTarget = vi.fn();
    const rollbackTarget = vi.fn();
    const now = () => new Date('2026-07-18T00:10:00.000Z');

    const controller = createFleetRolloutController(store, {
      actor: { id: 'controller/fleet', kind: 'controller' },
      listTargets,
      updateTarget,
      rollbackTarget,
      now,
    });

    const rollout = makeRollout('rollout-1', { deadlineMs: 300000 }, {
      phase: 'Rolling',
      startedAt: '2026-07-18T00:00:00.000Z',
      evidence: [],
    });
    const result = await controller.reconcile(makeRequest(rollout));

    expect(result.status?.phase).toBe('Failed');
    expect(result.status?.failureReason).toBe('rollout deadline exceeded');
    expect(result.status?.deadlineExceeded).toBe(true);
  });

  it('skips completed rollouts', async () => {
    const store = makeStore();
    const listTargets = vi.fn();
    const updateTarget = vi.fn();
    const rollbackTarget = vi.fn();

    const controller = createFleetRolloutController(store, {
      actor: { id: 'controller/fleet', kind: 'controller' },
      listTargets,
      updateTarget,
      rollbackTarget,
    });

    const rollout = makeRollout('rollout-1', {}, { phase: 'Completed' });
    const result = await controller.reconcile(makeRequest(rollout));

    expect(result.ready).toBe(true);
    expect(result.status).toBeUndefined();
  });
});
