import { describe, expect, it, vi } from 'vitest';

import { createModelEndpointBindingController } from '../modelEndpointBindingController.js';
import type { AgentRunResource, AgentWorkloadResource, ModelClassResource, ModelEndpointResource } from '../resources.js';

function workload(overrides: Partial<AgentWorkloadResource> = {}): AgentWorkloadResource {
  return {
    apiVersion: 'workload.memeloop.io/v1alpha1',
    kind: 'AgentWorkload',
    metadata: {
      name: 'work',
      namespace: 'default',
      uid: 'work-uid',
      generation: 1,
      resourceVersion: '1',
      creationTimestamp: '2026-07-23T00:00:00.000Z',
    },
    spec: {
      profileId: 'general',
      trust: 'restricted',
      modelPolicy: { modelClass: 'chat', allowedModelNames: ['chat-model'] },
      placement: { dataClassification: 'internal', dataResidency: ['cn'] },
    },
    status: { assignedNode: 'worker-a' },
    ...overrides,
  };
}

function run(status: AgentRunResource['status'] = { phase: 'Pending' }): AgentRunResource {
  return {
    apiVersion: 'run.memeloop.io/v1alpha1',
    kind: 'AgentRun',
    metadata: {
      name: 'run-1',
      namespace: 'default',
      uid: 'run-uid',
      generation: 1,
      resourceVersion: '4',
      creationTimestamp: '2026-07-23T00:00:00.000Z',
    },
    spec: {
      workloadRef: {
        apiVersion: 'workload.memeloop.io/v1alpha1',
        kind: 'AgentWorkload',
        name: 'work',
        namespace: 'default',
        uid: 'work-uid',
      },
    },
    status,
  };
}

function modelClass(overrides: Partial<ModelClassResource['spec']> = {}): ModelClassResource {
  return {
    apiVersion: 'models.memeloop.io/v1alpha1',
    kind: 'ModelClass',
    metadata: {
      name: 'chat',
      uid: 'class-uid',
      generation: 1,
      resourceVersion: '2',
      creationTimestamp: '2026-07-23T00:00:00.000Z',
    },
    spec: {
      provider: 'test',
      model: 'chat-model',
      digest: 'sha256:model',
      dataResidency: 'cn',
      ...overrides,
    },
  };
}

function endpoint(
  name: string,
  overrides: Partial<ModelEndpointResource> = {},
): ModelEndpointResource {
  return {
    apiVersion: 'models.memeloop.io/v1alpha1',
    kind: 'ModelEndpoint',
    metadata: {
      name,
      uid: `${name}-uid`,
      generation: 1,
      resourceVersion: '7',
      creationTimestamp: '2026-07-23T00:00:00.000Z',
    },
    spec: {
      modelClassRef: {
        apiVersion: 'models.memeloop.io/v1alpha1',
        kind: 'ModelClass',
        name: 'chat',
      },
      modelDigest: 'sha256:model',
      nodeId: 'worker-a',
      trust: 'restricted',
      endpoint: `gateway://${name}`,
      capacity: { maxConcurrent: 4 },
      dataPolicy: { classification: 'internal' },
    },
    status: { healthy: true, activeCalls: 0, heartbeat: new Date().toISOString() },
    ...overrides,
  };
}

function request(resource: AgentRunResource) {
  return {
    resource,
    actor: { id: 'controller/model-binding', kind: 'controller' as const },
    leaseEpoch: 'epoch-9',
    now: new Date('2026-07-23T01:00:00.000Z'),
  };
}

describe('createModelEndpointBindingController', () => {
  it('persists a fenced endpoint binding and prefers workload locality', async () => {
    const local = endpoint('local');
    const remote = endpoint('remote', {
      spec: {
        ...endpoint('remote').spec,
        nodeId: 'worker-b',
        capacity: { maxConcurrent: 100 },
      },
    });
    const controller = createModelEndpointBindingController({
      actor: { id: 'controller/model-binding', kind: 'controller' },
      getWorkload: vi.fn(async () => workload()),
      listEndpoints: vi.fn(async () => [remote, local]),
      getModelClass: vi.fn(async () => modelClass()),
      now: () => new Date('2026-07-23T02:00:00.000Z'),
    });

    const result = await controller.reconcile(request(run()));

    expect(result.status).toMatchObject({
      phase: 'Pending',
      assignedModelEndpoint: { name: 'local', uid: 'local-uid' },
      modelBinding: {
        leaseEpoch: 'epoch-9',
        endpointResourceVersion: '7',
        boundAt: '2026-07-23T02:00:00.000Z',
      },
      conditions: [{ type: 'ModelEndpointScheduled', status: 'True' }],
    });
  });

  it('fails closed on unknown health, exhausted capacity, digest mismatch, and weak trust', async () => {
    const endpoints = [
      endpoint('unknown-health', { status: {} }),
      endpoint('full', { status: { healthy: true, activeCalls: 4 } }),
      endpoint('wrong-digest', { spec: { ...endpoint('x').spec, modelDigest: 'sha256:other' } }),
      endpoint('weak', { spec: { ...endpoint('x').spec, trust: 'quarantine' } }),
    ];
    const controller = createModelEndpointBindingController({
      actor: { id: 'controller/model-binding', kind: 'controller' },
      getWorkload: async () => workload(),
      listEndpoints: async () => endpoints,
      getModelClass: async () => modelClass(),
    });

    const result = await controller.reconcile(request(run()));

    expect(result.status).toMatchObject({
      phase: 'Pending',
      conditions: [{
        type: 'ModelEndpointScheduled',
        status: 'False',
        reason: 'NoEligibleEndpoint',
      }],
    });
    expect(result.requeueAfterMs).toBe(1000);
  });

  it('enforces model name, residency, and input classification policy', async () => {
    const controller = createModelEndpointBindingController({
      actor: { id: 'controller/model-binding', kind: 'controller' },
      getWorkload: async () => workload(),
      listEndpoints: async () => [endpoint('candidate')],
      getModelClass: async () =>
        modelClass({
          model: 'different-model',
          dataResidency: 'eu',
        }),
    });

    const result = await controller.reconcile(request(run()));
    expect(result.status?.assignedModelEndpoint).toBeUndefined();

    const classificationController = createModelEndpointBindingController({
      actor: { id: 'controller/model-binding', kind: 'controller' },
      getWorkload: async () =>
        workload({
          spec: {
            ...workload().spec,
            placement: { dataClassification: 'confidential', dataResidency: ['cn'] },
          },
        }),
      listEndpoints: async () => [endpoint('candidate')],
      getModelClass: async () => modelClass(),
    });
    expect(
      (await classificationController.reconcile(request(run()))).status?.assignedModelEndpoint,
    ).toBeUndefined();
  });

  it('reserves endpoint capacity for other non-terminal AgentRuns', async () => {
    const only = endpoint('only', {
      spec: {
        ...endpoint('only').spec,
        capacity: { maxConcurrent: 1 },
      },
    });
    const other = run({
      phase: 'Running',
      assignedModelEndpoint: {
        apiVersion: only.apiVersion,
        kind: only.kind,
        name: only.metadata.name,
        uid: only.metadata.uid,
      },
    });
    other.metadata.uid = 'other-run';
    const controller = createModelEndpointBindingController({
      actor: { id: 'controller/model-binding', kind: 'controller' },
      getWorkload: async () => workload(),
      listEndpoints: async () => [only],
      listRuns: async () => [other],
      getModelClass: async () => modelClass(),
    });

    const result = await controller.reconcile(request(run()));
    expect(result.status?.assignedModelEndpoint).toBeUndefined();
    expect(result.requeueAfterMs).toBe(1000);
  });

  it('removes an existing binding when its endpoint heartbeat is stale', async () => {
    const stale = endpoint('stale', {
      status: {
        healthy: true,
        activeCalls: 0,
        heartbeat: '2026-07-23T00:00:00.000Z',
      },
    });
    const controller = createModelEndpointBindingController({
      actor: { id: 'controller/model-binding', kind: 'controller' },
      getWorkload: async () => workload(),
      listEndpoints: async () => [stale],
      getModelClass: async () => modelClass(),
      now: () => new Date('2026-07-23T01:00:00.000Z'),
      endpointHeartbeatTtlMs: 1000,
    });
    const bound = run({
      phase: 'Pending',
      assignedModelEndpoint: {
        apiVersion: stale.apiVersion,
        kind: stale.kind,
        name: stale.metadata.name,
        uid: stale.metadata.uid,
      },
      modelBinding: {
        leaseEpoch: 'epoch-9',
        endpointResourceVersion: stale.metadata.resourceVersion,
        boundAt: '2026-07-23T00:00:00.000Z',
      },
    });

    const result = await controller.reconcile(request(bound));
    expect(result.status).not.toHaveProperty('assignedModelEndpoint');
    expect(result.status).not.toHaveProperty('modelBinding');
    expect(result.requeueAfterMs).toBe(1000);
  });

  it('does not rewrite a current binding or spin on an unchanged scheduling failure', async () => {
    const selected = endpoint('selected');
    const options = {
      actor: { id: 'controller/model-binding', kind: 'controller' as const },
      getWorkload: async () => workload(),
      listEndpoints: async () => [selected],
      getModelClass: async () => modelClass(),
    };
    const controller = createModelEndpointBindingController(options);
    const current = run({
      phase: 'Pending',
      assignedModelEndpoint: {
        apiVersion: selected.apiVersion,
        kind: selected.kind,
        name: selected.metadata.name,
        uid: selected.metadata.uid,
      },
      modelBinding: {
        leaseEpoch: 'epoch-9',
        endpointResourceVersion: selected.metadata.resourceVersion,
        boundAt: '2026-07-23T00:00:00.000Z',
      },
    });
    expect(await controller.reconcile(request(current))).toEqual({ ready: true });
    current.status!.modelBinding!.leaseEpoch = 'stale-epoch';
    expect(await controller.reconcile(request(current))).toMatchObject({
      status: { modelBinding: { leaseEpoch: 'epoch-9' } },
    });

    const empty = createModelEndpointBindingController({
      ...options,
      listEndpoints: async () => [],
    });
    const message = "no healthy endpoint satisfies model class 'chat'";
    const failed = run({
      phase: 'Pending',
      conditions: [{
        type: 'ModelEndpointScheduled',
        status: 'False',
        reason: 'NoEligibleEndpoint',
        message,
        lastTransitionTime: '2026-07-23T00:00:00.000Z',
      }],
    });
    expect(await empty.reconcile(request(failed))).toEqual({ requeueAfterMs: 1000 });
  });

  it('does not require a model endpoint for workloads without a model policy', async () => {
    const controller = createModelEndpointBindingController({
      actor: { id: 'controller/model-binding', kind: 'controller' },
      getWorkload: async () =>
        workload({
          spec: { profileId: 'general' },
        }),
      listEndpoints: vi.fn(),
      getModelClass: vi.fn(),
    });
    expect(await controller.reconcile(request(run()))).toEqual({ ready: true });
  });
});
