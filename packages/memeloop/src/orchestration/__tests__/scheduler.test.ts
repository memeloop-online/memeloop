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

  it('rejects restricted node for worker role', async () => {
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

    // The scheduler may select the restricted node (capacity scheduler doesn't
    // filter by trust for worker role), but the binding controller rejects it.
    expect(result.ready).toBe(true);
    expect(result.status?.phase).toBe('Failed');
    expect(result.status?.lastRunResult).toContain('not allowed for worker workloads');
  });
});
