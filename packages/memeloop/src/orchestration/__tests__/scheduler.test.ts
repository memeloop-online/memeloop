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

describe('createCapacityScheduler — infrastructure and rollout admission', () => {
  const constrainedSpec: Partial<AgentWorkloadResource['spec']> = {
    runtimeClass: 'isolated-process',
    toolPolicy: { requiredToolClasses: ['filesystem'] },
    modelPolicy: { modelClass: 'local-qwen' },
    networkPolicy: {
      networkClass: 'restricted-egress',
      egress: 'restricted',
      minimumEnforcement: 'namespace',
    },
    storagePolicy: {
      storageClass: 'replicated',
      volumes: [{ name: 'workspace', claimRef: 'claim-workspace' }],
    },
    credentialPolicy: {
      brokerClass: 'jit',
      audiences: ['tool-gateway'],
      targets: ['git'],
    },
    resources: {
      cpuMillicores: 500,
      memoryBytes: 512 * 1024 * 1024,
      gpuCount: 1,
      diskBytes: 1024,
      bandwidthKbps: 100,
    },
    placement: {
      dataResidency: ['cn'],
      requireAttestation: true,
      rollout: {
        batchId: 'batch-1',
        excludedFaultDomains: ['zone-blocked'],
        maxConcurrentPerFaultDomain: 2,
      },
    },
  };

  function capableNode(overrides?: Partial<SchedulerNode>): SchedulerNode {
    return makeNode('capable', {
      attested: true,
      dataResidency: ['cn'],
      availableRuntimeClasses: ['isolated-process'],
      availableToolClasses: ['filesystem'],
      availableModelClasses: ['local-qwen'],
      networkCapabilities: [{
        networkClass: 'restricted-egress',
        enforcementLevel: 'namespace',
        egress: ['restricted'],
      }],
      availableStorageClasses: ['replicated'],
      availableVolumeClaims: ['claim-workspace'],
      credentialCapabilities: [{
        brokerClass: 'jit',
        audiences: ['tool-gateway'],
        targets: ['git'],
      }],
      capacity: {
        cpuMillicores: 1000,
        memoryBytes: 1024 * 1024 * 1024,
        gpuCount: 1,
        diskBytes: 2048,
        bandwidthKbps: 1000,
      },
      rolloutLoad: { 'batch-1': 1 },
      ...overrides,
    });
  }

  it('binds only when every declared infrastructure requirement is available', () => {
    const decision = createCapacityScheduler().schedule(
      makeWorkload('all-requirements', constrainedSpec),
      [capableNode()],
    );

    expect(decision?.nodeName).toBe('capable');
    expect(decision?.reasons).toContain('credential broker requirements available');
    expect(decision?.reasons).toContain('resource requests fit');
  });

  it.each(
    [
      ['runtime', { availableRuntimeClasses: [] }],
      ['tool', { availableToolClasses: [] }],
      ['model', { availableModelClasses: undefined }],
      ['network', { networkCapabilities: [] }],
      ['storage', { availableStorageClasses: [] }],
      ['volume', { availableVolumeClaims: [] }],
      ['credential', { credentialCapabilities: [] }],
      ['attestation', { attested: false }],
      ['residency', { dataResidency: ['eu'] }],
      ['capacity', { capacity: { cpuMillicores: 100 } }],
      ['rollout limit', { rolloutLoad: { 'batch-1': 2 } }],
      ['health', { healthy: false }],
      ['role', { roles: ['controller'] }],
    ] satisfies Array<[string, Partial<SchedulerNode>]>,
  )('fails closed when %s capability is absent', (_name, override) => {
    const decision = createCapacityScheduler().schedule(
      makeWorkload('missing-capability', constrainedSpec),
      [capableNode(override)],
    );
    expect(decision).toBeNull();
  });

  it('uses artifact, checkpoint, and preferred-node locality only as soft scoring', () => {
    const workload = makeWorkload('locality', {
      artifactReferences: ['sha256:a'],
      checkpointReference: 'checkpoint:7',
      placement: { preferredNode: 'local' },
    });
    const decision = createCapacityScheduler().schedule(workload, [
      makeNode('large', { capacity: { cpuMillicores: 1100, memoryBytes: 1024 * 1024 * 1024 } }),
      makeNode('local', {
        localArtifactReferences: ['sha256:a'],
        localCheckpointReferences: ['checkpoint:7'],
      }),
    ]);

    expect(decision?.nodeName).toBe('local');
    expect(decision?.reasons).toContain('checkpoint local');
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

  it('persists the trusted managed placement decision and fails closed on denial', async () => {
    const store = {} as ControlStore;
    const node = makeNode('node-a');
    const workload = makeWorkload('w1', {}, { phase: 'Pending' });
    const authorizePlacement = vi.fn(async () => ({
      outcome: 'allow' as const,
      decisionHandle: 'policy-decision:allow-placement',
      policyDigest: `sha256:${'a'.repeat(64)}`,
      reasons: ['host placement policy allows the selected node'],
    }));
    const allowedController = createBindingController(store, {
      actor: { id: 'controller/scheduler', kind: 'controller' },
      scheduler: createCapacityScheduler(),
      listNodes: async () => [node],
      authorizePlacement,
    });
    const allowed = await allowedController.reconcile(
      makeRequest(workload, 'lease-42'),
    );

    expect(authorizePlacement).toHaveBeenCalledWith({
      workload,
      node,
      actor: { id: 'controller/scheduler', kind: 'controller' },
      leaseEpoch: 'lease-42',
    });
    expect(allowed.status).toMatchObject({
      phase: 'Scheduling',
      assignedNode: 'node-a',
      placementDecisionRef: 'policy-decision:allow-placement',
      placementPolicyDigest: `sha256:${'a'.repeat(64)}`,
    });

    const deniedController = createBindingController(store, {
      actor: { id: 'controller/scheduler', kind: 'controller' },
      scheduler: createCapacityScheduler(),
      listNodes: async () => [node],
      authorizePlacement: async () => ({
        outcome: 'deny',
        decisionHandle: 'policy-decision:deny-placement',
        policyDigest: `sha256:${'b'.repeat(64)}`,
        reasons: ['attestation is stale'],
      }),
    });
    const denied = await deniedController.reconcile(
      makeRequest(workload, 'lease-43'),
    );
    expect(denied.status).toMatchObject({
      phase: 'Failed',
      placementDecisionRef: 'policy-decision:deny-placement',
      placementPolicyDigest: `sha256:${'b'.repeat(64)}`,
    });
    expect(denied.status?.lastRunResult).toContain('attestation is stale');
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
    expect(result.status?.lastRunResult).toContain('cannot use quarantine node');
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
    expect(result.status?.lastRunResult).toContain('quarantine isolation requires a quarantine node');
  });

  it('rejects a custom scheduler decision for a node that does not exist', async () => {
    const controller = createBindingController({} as ControlStore, {
      actor: { id: 'controller/scheduler', kind: 'controller' },
      scheduler: {
        schedule: () => ({ nodeName: 'fabricated-node', score: 999, reasons: [] }),
      },
      listNodes: async () => [makeNode('real-node')],
    });

    const result = await controller.reconcile(
      makeRequest(makeWorkload('w1', {}, { phase: 'Pending' })),
    );

    expect(result.status?.phase).toBe('Failed');
    expect(result.status?.lastRunResult).toContain('selected node does not exist');
    expect(result.status?.conditions?.at(-1)?.reason).toBe('BindingAdmissionRejected');
  });

  it('rechecks all capabilities after a custom scheduler decision', async () => {
    const controller = createBindingController({} as ControlStore, {
      actor: { id: 'controller/scheduler', kind: 'controller' },
      scheduler: {
        schedule: () => ({ nodeName: 'weak-network', score: 999, reasons: [] }),
      },
      listNodes: async () => [makeNode('weak-network', {
        networkCapabilities: [{
          networkClass: 'isolated',
          enforcementLevel: 'process',
          egress: ['restricted'],
        }],
      })],
    });

    const workload = makeWorkload('w1', {
      networkPolicy: {
        networkClass: 'isolated',
        egress: 'restricted',
        minimumEnforcement: 'namespace',
      },
    }, { phase: 'Pending' });
    const result = await controller.reconcile(makeRequest(workload));

    expect(result.status?.phase).toBe('Failed');
    expect(result.status?.lastRunResult).toContain('network enforcement process is below namespace');
  });
});
