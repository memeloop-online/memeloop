import { describe, expect, it, vi } from 'vitest';

import type { ControllerReconcileRequest } from '../controllerRunner.js';
import type { ControlStore } from '../controlStore.js';
import type { AgentWorkloadResource, AgentWorkloadStatus } from '../resources.js';
import { createBindingController, createCapacityScheduler, type SchedulerNode } from '../scheduler.js';

function makeWorkload(
  name: string,
  spec?: Partial<AgentWorkloadResource['spec']>,
  status?: AgentWorkloadStatus,
): AgentWorkloadResource {
  return {
    apiVersion: 'workload.memeloop.io/v1alpha1',
    kind: 'AgentWorkload',
    metadata: {
      name,
      namespace: 'default',
      uid: `uid-${name}`,
      generation: 1,
      resourceVersion: '1',
      creationTimestamp: '2026-07-18T00:00:00.000Z',
    },
    spec: {
      profileId: 'default',
      ...spec,
    },
    status,
  };
}

function makeNode(name: string, overrides?: Partial<SchedulerNode>): SchedulerNode {
  return {
    name,
    trustClass: 'trusted',
    faultDomain: 'zone-1',
    capacity: { cpuMillicores: 1000, memoryBytes: 1024 * 1024 * 1024 },
    labels: {},
    ...overrides,
  };
}

function makeRequest(
  workload: AgentWorkloadResource,
  leaseEpoch = '1',
): ControllerReconcileRequest<AgentWorkloadResource['spec']> {
  return {
    resource: workload,
    actor: { id: 'controller/scheduler', kind: 'controller' },
    leaseEpoch,
    now: new Date('2026-07-18T00:00:00.000Z'),
  };
}

describe('createCapacityScheduler', () => {
  it('selects node with highest capacity score', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1');
    const nodes = [
      makeNode('node-small', { capacity: { cpuMillicores: 500, memoryBytes: 512 * 1024 * 1024 } }),
      makeNode('node-large', { capacity: { cpuMillicores: 2000, memoryBytes: 4 * 1024 * 1024 * 1024 } }),
    ];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision?.nodeName).toBe('node-large');
    expect(decision?.score).toBeGreaterThan(0);
  });

  it('prefers trusted nodes over restricted with same capacity', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1');
    const nodes = [
      makeNode('node-restricted', { trustClass: 'restricted' }),
      makeNode('node-trusted', { trustClass: 'trusted' }),
    ];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision?.nodeName).toBe('node-trusted');
  });

  it('filters by requiredNode', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1', { placement: { requiredNode: 'node-a' } });
    const nodes = [makeNode('node-a'), makeNode('node-b')];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision?.nodeName).toBe('node-a');
  });

  it('filters by nodeSelector labels', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1', { placement: { nodeSelector: { gpu: 'true' } } });
    const nodes = [
      makeNode('node-cpu', { labels: { gpu: 'false' } }),
      makeNode('node-gpu', { labels: { gpu: 'true' } }),
    ];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision?.nodeName).toBe('node-gpu');
  });

  it('filters by anti-affinity fault domains', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1', { placement: { antiAffinity: ['zone-1'] } });
    const nodes = [
      makeNode('node-zone1', { faultDomain: 'zone-1' }),
      makeNode('node-zone2', { faultDomain: 'zone-2' }),
    ];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision?.nodeName).toBe('node-zone2');
  });

  it('returns null when no nodes match', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1', { placement: { requiredNode: 'missing' } });
    const nodes = [makeNode('node-a')];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision).toBeNull();
  });
});

describe('createCapacityScheduler — trust filtering', () => {
  it('allows restricted nodes for ordinary worker workloads (§7.2, §23)', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1');
    const nodes = [makeNode('node-restricted', { trustClass: 'restricted' })];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision?.nodeName).toBe('node-restricted');
    expect(decision?.reasons.some((r) => r.includes('trust:'))).toBe(true);
  });

  it('prefers trusted over restricted when both available', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1');
    const nodes = [
      makeNode('node-restricted', { trustClass: 'restricted' }),
      makeNode('node-trusted', { trustClass: 'trusted' }),
    ];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision?.nodeName).toBe('node-trusted');
  });

  it('rejects quarantine nodes for non-quarantine workloads', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1');
    const nodes = [makeNode('node-quarantine', { trustClass: 'quarantine' })];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision).toBeNull();
  });

  it('schedules quarantine workloads only on quarantine nodes', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1', {
      trust: 'quarantine',
      placement: { dataClassification: 'public' },
    });
    const nodes = [
      makeNode('node-trusted', { trustClass: 'trusted' }),
      makeNode('node-quarantine', { trustClass: 'quarantine' }),
    ];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision?.nodeName).toBe('node-quarantine');
  });

  it('returns null for quarantine workload with no quarantine nodes', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1', { trust: 'quarantine' });
    const nodes = [makeNode('node-trusted', { trustClass: 'trusted' })];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision).toBeNull();
  });

  it('respects explicit trust=trusted requirement', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1', { trust: 'trusted' });
    const nodes = [makeNode('node-restricted', { trustClass: 'restricted' })];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision).toBeNull();
  });
});

describe('createCapacityScheduler — data classification filtering', () => {
  it('filters out nodes with lower maxDataClassification', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1', {
      placement: { dataClassification: 'confidential' },
    });
    const nodes = [
      makeNode('node-restricted', {
        trustClass: 'restricted',
        maxDataClassification: 'internal',
      }),
    ];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision).toBeNull();
  });

  it('allows nodes with sufficient maxDataClassification', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1', {
      placement: { dataClassification: 'confidential' },
    });
    const nodes = [
      makeNode('node-trusted', {
        trustClass: 'trusted',
        maxDataClassification: 'restricted',
      }),
    ];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision?.nodeName).toBe('node-trusted');
  });

  it('defaults quarantine nodes to public-only classification', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1', { trust: 'quarantine' });
    const nodes = [
      makeNode('node-quarantine', { trustClass: 'quarantine' }),
    ];

    // Quarantine workload with default 'internal' classification should be
    // rejected because quarantine nodes default to public-only.
    const decision = scheduler.schedule(workload, nodes);
    expect(decision).toBeNull();
  });

  it('allows public-classified quarantine workloads on quarantine nodes', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1', {
      trust: 'quarantine',
      placement: { dataClassification: 'public' },
    });
    const nodes = [
      makeNode('node-quarantine', { trustClass: 'quarantine' }),
    ];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision?.nodeName).toBe('node-quarantine');
  });
});

describe('createCapacityScheduler — taints and tolerations', () => {
  it('filters out nodes with untolerated taints', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1');
    const nodes = [makeNode('node-tainted', { taints: ['dedicated-gpu'] })];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision).toBeNull();
  });

  it('allows tainted nodes when workload tolerates the taint', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1', {
      placement: { tolerations: ['dedicated-gpu'] },
    });
    const nodes = [makeNode('node-tainted', { taints: ['dedicated-gpu'] })];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision?.nodeName).toBe('node-tainted');
  });
});

describe('createCapacityScheduler — model class filtering', () => {
  it('filters out nodes without required model class', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1', {
      modelPolicy: { modelClass: 'gpt-4-class' },
    });
    const nodes = [
      makeNode('node-no-model', { availableModelClasses: ['claude-class'] }),
    ];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision).toBeNull();
  });

  it('allows nodes with required model class', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1', {
      modelPolicy: { modelClass: 'gpt-4-class' },
    });
    const nodes = [
      makeNode('node-with-model', { availableModelClasses: ['gpt-4-class', 'claude-class'] }),
    ];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision?.nodeName).toBe('node-with-model');
  });
});

describe('createCapacityScheduler — capacity and scoring', () => {
  it('selects node with highest capacity score', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1');
    const nodes = [
      makeNode('node-small', { capacity: { cpuMillicores: 500, memoryBytes: 512 * 1024 * 1024 } }),
      makeNode('node-large', { capacity: { cpuMillicores: 2000, memoryBytes: 4 * 1024 * 1024 * 1024 } }),
    ];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision?.nodeName).toBe('node-large');
    expect(decision?.score).toBeGreaterThan(0);
  });

  it('filters by requiredNode', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1', { placement: { requiredNode: 'node-a' } });
    const nodes = [makeNode('node-a'), makeNode('node-b')];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision?.nodeName).toBe('node-a');
  });

  it('filters by nodeSelector labels', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1', { placement: { nodeSelector: { gpu: 'true' } } });
    const nodes = [
      makeNode('node-cpu', { labels: { gpu: 'false' } }),
      makeNode('node-gpu', { labels: { gpu: 'true' } }),
    ];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision?.nodeName).toBe('node-gpu');
  });

  it('filters by anti-affinity fault domains', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1', { placement: { antiAffinity: ['zone-1'] } });
    const nodes = [
      makeNode('node-zone1', { faultDomain: 'zone-1' }),
      makeNode('node-zone2', { faultDomain: 'zone-2' }),
    ];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision?.nodeName).toBe('node-zone2');
  });

  it('returns null when no nodes match', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1', { placement: { requiredNode: 'missing' } });
    const nodes = [makeNode('node-a')];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision).toBeNull();
  });

  it('gives spare concurrency bonus to scoring', () => {
    const scheduler = createCapacityScheduler();
    const workload = makeWorkload('w1');
    const nodes = [
      makeNode('node-idle', { spareConcurrency: 0 }),
      makeNode('node-free', { spareConcurrency: 10 }),
    ];

    const decision = scheduler.schedule(workload, nodes);
    expect(decision?.nodeName).toBe('node-free');
  });
});

describe('createBindingController', () => {
  it('binds Pending workload to selected node', async () => {
    const store = {} as ControlStore;
    const listNodes = vi.fn(async () => [makeNode('node-a')]);
    const scheduler = createCapacityScheduler();
    const controller = createBindingController(store, {
      actor: { id: 'controller/scheduler', kind: 'controller' },
      scheduler,
      listNodes,
    });

    const workload = makeWorkload('w1', {}, { phase: 'Pending' });
    const result = await controller.reconcile(makeRequest(workload, 'lease-42'));

    expect(result.ready).toBe(true);
    expect(result.status?.phase).toBe('Scheduling');
    expect(result.status?.lastRunResult).toContain('node-a');
    expect(result.status?.lastRunResult).toContain('lease-42');
  });

  it('skips already bound workloads', async () => {
    const store = {} as ControlStore;
    const listNodes = vi.fn(async () => [makeNode('node-a')]);
    const scheduler = createCapacityScheduler();
    const controller = createBindingController(store, {
      actor: { id: 'controller/scheduler', kind: 'controller' },
      scheduler,
      listNodes,
    });

    const workload = makeWorkload('w1', {}, { phase: 'Running' });
    const result = await controller.reconcile(makeRequest(workload));

    expect(result.ready).toBe(true);
    expect(result.status).toBeUndefined();
    expect(listNodes).not.toHaveBeenCalled();
  });

  it('leaves explicitly external workloads to the external controller', async () => {
    const store = {} as ControlStore;
    const listNodes = vi.fn(async () => [makeNode('node-a')]);
    const scheduler = createCapacityScheduler();
    const controller = createBindingController(store, {
      actor: { id: 'controller/scheduler', kind: 'controller' },
      scheduler,
      listNodes,
    });

    const workload = makeWorkload(
      'external-w1',
      { placement: { orchestrator: 'memeloop-k8s' } },
      { phase: 'Pending' },
    );
    const result = await controller.reconcile(makeRequest(workload));

    expect(result).toEqual({ ready: true });
    expect(listNodes).not.toHaveBeenCalled();
  });

  it('marks workload Failed when no node matches', async () => {
    const store = {} as ControlStore;
    const listNodes = vi.fn(async () => []);
    const scheduler = createCapacityScheduler();
    const controller = createBindingController(store, {
      actor: { id: 'controller/scheduler', kind: 'controller' },
      scheduler,
      listNodes,
    });

    const workload = makeWorkload('w1', {}, { phase: 'Pending' });
    const result = await controller.reconcile(makeRequest(workload));

    expect(result.ready).toBe(true);
    expect(result.status?.phase).toBe('Failed');
    expect(result.status?.lastRunResult).toBe('no suitable node found');
  });

  it('allows restricted node for ordinary worker workload (§7.2)', async () => {
    const store = {} as ControlStore;
    const listNodes = vi.fn(async () => [makeNode('node-restricted', { trustClass: 'restricted' })]);
    const scheduler = createCapacityScheduler();
    const controller = createBindingController(store, {
      actor: { id: 'controller/scheduler', kind: 'controller' },
      scheduler,
      listNodes,
    });

    const workload = makeWorkload('w1', {}, { phase: 'Pending' });
    const result = await controller.reconcile(makeRequest(workload));

    expect(result.ready).toBe(true);
    expect(result.status?.phase).toBe('Scheduling');
    expect(result.status?.lastRunResult).toContain('node-restricted');
  });

  it('rejects quarantine node for non-quarantine workload (defense in depth)', async () => {
    const store = {} as ControlStore;
    // The scheduler already filters quarantine nodes, but if somehow a
    // quarantine node is selected, the binding controller must reject it.
    const listNodes = vi.fn(async () => [makeNode('node-quarantine', { trustClass: 'quarantine' })]);
    const fakeScheduler: { schedule: () => { nodeName: string; score: number; reasons: string[] } } = {
      schedule: () => ({ nodeName: 'node-quarantine', score: 0, reasons: [] }),
    };
    const controller = createBindingController(store, {
      actor: { id: 'controller/scheduler', kind: 'controller' },
      scheduler: fakeScheduler,
      listNodes,
    });

    const workload = makeWorkload('w1', {}, { phase: 'Pending' });
    const result = await controller.reconcile(makeRequest(workload));

    expect(result.ready).toBe(true);
    expect(result.status?.phase).toBe('Failed');
    expect(result.status?.lastRunResult).toContain('below required');
  });

  it('rejects non-quarantine node for quarantine workload (isolation)', async () => {
    const store = {} as ControlStore;
    const listNodes = vi.fn(async () => [makeNode('node-trusted', { trustClass: 'trusted' })]);
    const fakeScheduler: { schedule: () => { nodeName: string; score: number; reasons: string[] } } = {
      schedule: () => ({ nodeName: 'node-trusted', score: 100, reasons: [] }),
    };
    const controller = createBindingController(store, {
      actor: { id: 'controller/scheduler', kind: 'controller' },
      scheduler: fakeScheduler,
      listNodes,
    });

    const workload = makeWorkload('w1', { trust: 'quarantine' }, { phase: 'Pending' });
    const result = await controller.reconcile(makeRequest(workload));

    expect(result.ready).toBe(true);
    expect(result.status?.phase).toBe('Failed');
    expect(result.status?.lastRunResult).toContain('quarantine workload must run on quarantine node');
  });
});
