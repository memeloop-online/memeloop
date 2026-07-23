import { describe, expect, it, vi } from 'vitest';

import { createNetworkAttachmentBindingController, createNetworkAttachmentExecutionController } from '../networkAttachmentController.js';
import type { NetworkAttachmentResource, NetworkClassResource } from '../resources.js';

const actor = { id: 'controller/network', kind: 'controller' as const };

function networkClass(enforcement: 'required' | 'best-effort' = 'best-effort'): NetworkClassResource {
  return {
    apiVersion: 'network.memeloop.io/v1alpha1',
    kind: 'NetworkClass',
    metadata: {
      name: 'restricted-net',
      uid: 'class-uid',
      generation: 1,
      resourceVersion: '5',
      creationTimestamp: '',
    },
    spec: {
      driver: 'process-env',
      proxy: { mandatory: true },
      egress: { defaultAction: 'deny' },
      enforcement,
    },
  };
}

function attachment(status: NetworkAttachmentResource['status'] = { phase: 'Pending' }): NetworkAttachmentResource {
  return {
    apiVersion: 'network.memeloop.io/v1alpha1',
    kind: 'NetworkAttachment',
    metadata: {
      name: 'run-network',
      namespace: 'default',
      uid: 'attachment-uid',
      generation: 1,
      resourceVersion: '8',
      creationTimestamp: '',
    },
    spec: {
      networkClassRef: {
        apiVersion: 'network.memeloop.io/v1alpha1',
        kind: 'NetworkClass',
        name: 'restricted-net',
      },
      workloadRef: {
        apiVersion: 'workload.memeloop.io/v1alpha1',
        kind: 'AgentWorkload',
        name: 'work',
        uid: 'work-uid',
      },
    },
    status,
  };
}

function request(resource: NetworkAttachmentResource, leaseEpoch = 'epoch-1') {
  return { resource, actor, leaseEpoch, now: new Date('2026-07-23T00:00:00Z') };
}

describe('network attachment controllers', () => {
  it('binds to the workload node only after validating driver capabilities', async () => {
    const controller = createNetworkAttachmentBindingController({
      getNetworkClass: async () => networkClass(),
      getWorkload: async () => ({
        apiVersion: 'workload.memeloop.io/v1alpha1',
        kind: 'AgentWorkload',
        metadata: { name: 'work', uid: 'work-uid', generation: 1, resourceVersion: '1', creationTimestamp: '' },
        spec: {},
        status: { assignedNode: 'worker-b' },
      }),
      listNodes: async () => [
        {
          nodeId: 'worker-a',
          healthy: true,
          capabilities: [{ name: 'process-env', enforcedFeatures: ['proxy'], enforcementLevel: 'process' }],
        },
        {
          nodeId: 'worker-b',
          healthy: true,
          capabilities: [{ name: 'process-env', enforcedFeatures: ['proxy'], enforcementLevel: 'process' }],
        },
      ],
      now: () => new Date('2026-07-23T01:00:00Z'),
    });

    const result = await controller.reconcile(request(attachment()));
    expect(result.status).toMatchObject({
      assignedNode: 'worker-b',
      assignedDriver: 'process-env',
      binding: {
        leaseEpoch: 'epoch-1',
        networkClassResourceVersion: '5',
      },
    });
  });

  it('rejects a process boundary for enforcement-required classes', async () => {
    const controller = createNetworkAttachmentBindingController({
      getNetworkClass: async () => networkClass('required'),
      listNodes: async () => [{
        nodeId: 'worker-a',
        healthy: true,
        capabilities: [{ name: 'process-env', enforcedFeatures: ['proxy', 'egress'], enforcementLevel: 'process' }],
      }],
    });
    const result = await controller.reconcile(request(attachment()));
    expect(result.status?.assignedNode).toBeUndefined();
    expect(result.status?.conditions?.[0]).toMatchObject({ status: 'False' });
  });

  it('writes a fenced claim before invoking prepare and preserves binding status', async () => {
    const prepare = vi.fn(async () => ({
      phase: 'Attached' as const,
      handle: 'procnet:1',
      attachedAt: '2026-07-23T02:00:00Z',
    }));
    const driver = {
      getCapabilities: async () => ({ name: 'process-env', enforcedFeatures: ['proxy' as const], enforcementLevel: 'process' as const }),
      getHealth: async () => ({ healthy: true, checkedAt: '' }),
      prepare,
      check: vi.fn(),
      update: vi.fn(),
      resolveService: vi.fn(),
      release: vi.fn(),
    };
    const binding = {
      assignedNode: 'worker-a',
      assignedDriver: 'process-env',
      binding: { leaseEpoch: 'bind-1', networkClassResourceVersion: '5', boundAt: '' },
    };
    const controller = createNetworkAttachmentExecutionController({
      nodeId: 'worker-a',
      getNetworkClass: async () => networkClass(),
      getDriver: async () => driver,
    });

    const claim = await controller.reconcile(request(attachment({ phase: 'Pending', ...binding }), 'exec-1'));
    expect(claim.status).toMatchObject({
      phase: 'Preparing',
      executionClaim: { leaseEpoch: 'exec-1' },
    });
    expect(prepare).not.toHaveBeenCalled();

    const prepared = await controller.reconcile(request(attachment(claim.status), 'exec-1'));
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepared.status).toMatchObject({
      phase: 'Attached',
      handle: 'procnet:1',
      assignedNode: 'worker-a',
      assignedDriver: 'process-env',
      binding: binding.binding,
      executionClaim: { leaseEpoch: 'exec-1' },
    });
  });

  it('fails closed instead of repeating a prepare claimed by an older epoch', async () => {
    const prepare = vi.fn();
    const controller = createNetworkAttachmentExecutionController({
      nodeId: 'worker-a',
      getNetworkClass: async () => networkClass(),
      getDriver: async () => ({
        getCapabilities: async () => ({ name: 'process-env', enforcedFeatures: ['proxy'], enforcementLevel: 'process' }),
        getHealth: async () => ({ healthy: true, checkedAt: '' }),
        prepare,
        check: vi.fn(),
        update: vi.fn(),
        resolveService: vi.fn(),
        release: vi.fn(),
      }),
    });
    const result = await controller.reconcile(request(
      attachment({
        phase: 'Preparing',
        assignedNode: 'worker-a',
        assignedDriver: 'process-env',
        binding: { leaseEpoch: 'bind-1', networkClassResourceVersion: '5', boundAt: '' },
        executionClaim: { leaseEpoch: 'old', claimedAt: '' },
      }),
      'new',
    ));
    expect(result.status?.error?.code).toBe('UNKNOWN_EFFECT');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('releases the driver handle before marking an attachment Detached', async () => {
    const release = vi.fn(async () => {});
    const controller = createNetworkAttachmentExecutionController({
      nodeId: 'worker-a',
      getNetworkClass: async () => networkClass(),
      getDriver: async () => ({
        getCapabilities: vi.fn(),
        getHealth: vi.fn(),
        prepare: vi.fn(),
        check: vi.fn(),
        update: vi.fn(),
        resolveService: vi.fn(),
        release,
      }),
      now: () => new Date('2026-07-23T03:00:00Z'),
    });
    const result = await controller.reconcile(request(attachment({
      phase: 'Attached',
      assignedNode: 'worker-a',
      assignedDriver: 'process-env',
      binding: { leaseEpoch: 'bind-1', networkClassResourceVersion: '5', boundAt: '' },
      handle: 'procnet:1',
      releaseRequestedAt: '2026-07-23T02:59:00Z',
    })));
    expect(release).toHaveBeenCalledWith('procnet:1');
    expect(result.status).toMatchObject({
      phase: 'Detached',
      detachedAt: '2026-07-23T03:00:00.000Z',
    });
  });
});
