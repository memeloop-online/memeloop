import { describe, expect, it, vi } from 'vitest';

import type { StorageDriver } from '../drivers/storageDriver.js';
import type { AgentVolumeClaimResource, AgentVolumeResource, StorageClassResource } from '../resources.js';
import { createVolumeClaimBindingController, createVolumeClaimExecutionController } from '../volumeClaimController.js';

function storageClass(overrides: Partial<StorageClassResource['spec']> = {}): StorageClassResource {
  return {
    apiVersion: 'storage.memeloop.io/v1alpha1',
    kind: 'StorageClass',
    metadata: {
      name: 'local-data',
      uid: 'class-uid',
      generation: 1,
      resourceVersion: '5',
      creationTimestamp: '',
    },
    spec: {
      driver: 'local-directory',
      allowedAccessModes: ['ReadWriteOnce'],
      ...overrides,
    },
  };
}

function claim(status: AgentVolumeClaimResource['status'] = { phase: 'Pending' }): AgentVolumeClaimResource {
  return {
    apiVersion: 'storage.memeloop.io/v1alpha1',
    kind: 'AgentVolumeClaim',
    metadata: {
      name: 'data',
      namespace: 'default',
      uid: 'claim-uid',
      generation: 1,
      resourceVersion: '8',
      creationTimestamp: '',
    },
    spec: {
      storageClassRef: {
        apiVersion: 'storage.memeloop.io/v1alpha1',
        kind: 'StorageClass',
        name: 'local-data',
      },
      accessMode: 'ReadWriteOnce',
      sizeBytes: 1024,
    },
    status,
  };
}

function request(resource: AgentVolumeClaimResource, leaseEpoch = 'epoch-1') {
  return {
    resource,
    actor: { id: 'controller/volume', kind: 'controller' as const },
    leaseEpoch,
    now: new Date('2026-07-23T00:00:00Z'),
  };
}

const capabilities = {
  name: 'local-directory',
  accessModes: ['ReadWriteOnce' as const],
  snapshots: false,
  encryption: false,
  maxVolumeBytes: 4096,
};

describe('volume claim controllers', () => {
  it('binds to the required node only after complete capability validation', async () => {
    const controller = createVolumeClaimBindingController({
      getStorageClass: async () => storageClass(),
      requiredNodeForClaim: async () => 'worker-b',
      listDrivers: async () => [
        { nodeId: 'worker-a', healthy: true, trust: 'trusted', capabilities: [capabilities] },
        { nodeId: 'worker-b', healthy: true, trust: 'trusted', capabilities: [capabilities] },
      ],
      now: () => new Date('2026-07-23T01:00:00Z'),
    });
    expect((await controller.reconcile(request(claim()))).status).toMatchObject({
      assignedNode: 'worker-b',
      assignedDriver: 'local-directory',
      binding: {
        leaseEpoch: 'epoch-1',
        storageClassResourceVersion: '5',
      },
    });
  });

  it('rejects missing snapshot, encryption, access-mode, and size capabilities', async () => {
    const controller = createVolumeClaimBindingController({
      getStorageClass: async () => storageClass({ encryption: { enabled: true } }),
      listDrivers: async () => [{
        nodeId: 'worker-a',
        healthy: true,
        trust: 'trusted',
        capabilities: [{ ...capabilities, maxVolumeBytes: 512 }],
      }],
    });
    const result = await controller.reconcile(request(claim()));
    expect(result.status?.assignedDriver).toBeUndefined();
    expect(result.status?.conditions?.[0]).toMatchObject({
      status: 'False',
      reason: 'NoEligibleStorageDriver',
    });
  });

  it('requires wired replication, snapshot, and backup capabilities promised by the class', async () => {
    const replicatedClass = storageClass({
      replication: { factor: 3, faultDomains: ['rack'], autoRebuild: true },
    });
    const withoutReplication = createVolumeClaimBindingController({
      getStorageClass: async () => replicatedClass,
      listDrivers: async () => [{
        nodeId: 'worker-a',
        healthy: true,
        trust: 'trusted',
        capabilities: [capabilities],
      }],
    });
    expect((await withoutReplication.reconcile(request(claim()))).status)
      .not.toHaveProperty('assignedDriver');

    const withReplication = createVolumeClaimBindingController({
      getStorageClass: async () => replicatedClass,
      listDrivers: async () => [{
        nodeId: 'worker-a',
        healthy: true,
        trust: 'trusted',
        capabilities: [{ ...capabilities, replication: true }],
      }],
    });
    expect((await withReplication.reconcile(request(claim()))).status)
      .toMatchObject({ assignedDriver: 'local-directory' });

    for (
      const promisedClass of [
        storageClass({ snapshotSupport: true }),
        storageClass({ backup: { schedule: '0 2 * * *', retentionCount: 7 } }),
      ]
    ) {
      const controller = createVolumeClaimBindingController({
        getStorageClass: async () => promisedClass,
        listDrivers: async () => [{
          nodeId: 'worker-a',
          healthy: true,
          trust: 'trusted',
          capabilities: [capabilities],
        }],
      });
      expect((await controller.reconcile(request(claim()))).status)
        .not.toHaveProperty('assignedDriver');
    }
  });

  it('never places authoritative volumes on restricted or quarantine nodes', async () => {
    const controller = createVolumeClaimBindingController({
      getStorageClass: async () => storageClass(),
      listDrivers: async () => [
        { nodeId: 'restricted', healthy: true, trust: 'restricted', capabilities: [capabilities] },
        { nodeId: 'quarantine', healthy: true, trust: 'quarantine', capabilities: [capabilities] },
      ],
    });
    expect((await controller.reconcile(request(claim()))).status?.assignedNode).toBeUndefined();
  });

  it('persists a fencing claim before idempotent provision and volume creation', async () => {
    const provision = vi.fn(async () => ({
      driverHandle: 'localdir:claim-uid',
      capacityBytes: 1024,
      topology: { nodeId: 'worker-a' },
    }));
    const driver = {
      getHealth: async () => ({ healthy: true, checkedAt: '' }),
      getCapabilities: async () => capabilities,
      provision,
    } as unknown as StorageDriver;
    const volume: AgentVolumeResource = {
      apiVersion: 'storage.memeloop.io/v1alpha1',
      kind: 'AgentVolume',
      metadata: {
        name: 'claim-uid-volume',
        uid: 'volume-uid',
        generation: 1,
        resourceVersion: '9',
        creationTimestamp: '',
      },
      spec: {
        storageClassRef: claim().spec.storageClassRef,
        driverHandle: 'localdir:claim-uid',
      },
    };
    const ensureVolume = vi.fn(async () => volume);
    const controller = createVolumeClaimExecutionController({
      nodeId: 'worker-a',
      getStorageClass: async () => storageClass(),
      getDriver: async () => driver,
      ensureVolume,
    });
    const bound = {
      phase: 'Pending' as const,
      assignedNode: 'worker-a',
      assignedDriver: 'local-directory',
      binding: { leaseEpoch: 'bind-1', storageClassResourceVersion: '5', boundAt: '' },
    };
    const fenced = await controller.reconcile(request(claim(bound), 'exec-1'));
    expect(fenced.status).toMatchObject({
      phase: 'Provisioning',
      provisionClaim: { leaseEpoch: 'exec-1' },
    });
    expect(provision).not.toHaveBeenCalled();

    const provisioned = await controller.reconcile(request(claim(fenced.status), 'exec-1'));
    expect(provision).toHaveBeenCalledOnce();
    expect(ensureVolume).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ uid: 'claim-uid' }) }),
      expect.objectContaining({ metadata: expect.objectContaining({ name: 'local-data' }) }),
      expect.objectContaining({ driverHandle: 'localdir:claim-uid' }),
    );
    expect(provisioned.status).toMatchObject({
      phase: 'Bound',
      volumeRef: { name: 'claim-uid-volume', uid: 'volume-uid' },
    });
  });

  it('routes the claimed provision effect through the managed storage driver', async () => {
    const narrowProvision = vi.fn();
    const managedProvision = vi.fn(async () => ({
      volumeHandle: 'managed:claim-uid',
      resourceUid: 'claim-uid',
      capacityBytes: 1024,
      accessMode: 'ReadWriteOnce' as const,
      fencingEpoch: 1,
      phase: 'Available' as const,
    }));
    const ensureVolume = vi.fn(async (_claim, _class, provisioned) => ({
      apiVersion: 'storage.memeloop.io/v1alpha1',
      kind: 'AgentVolume',
      metadata: {
        name: 'managed-volume',
        uid: 'managed-volume-uid',
        generation: 1,
        resourceVersion: '1',
        creationTimestamp: '',
      },
      spec: {
        storageClassRef: claim().spec.storageClassRef,
        driverHandle: provisioned.driverHandle,
      },
    } satisfies AgentVolumeResource));
    const controller = createVolumeClaimExecutionController({
      nodeId: 'worker-a',
      getStorageClass: async () => storageClass(),
      getDriver: async () => ({
        getHealth: async () => ({ healthy: true, checkedAt: '' }),
        getCapabilities: async () => capabilities,
        provision: narrowProvision,
      } as unknown as StorageDriver),
      managed: {
        getDriver: async () => ({
          provision: managedProvision,
        } as never),
        createProvisionRequest: async () => ({} as never),
      },
      ensureVolume,
    });
    const result = await controller.reconcile(request(
      claim({
        phase: 'Provisioning',
        assignedNode: 'worker-a',
        assignedDriver: 'local-directory',
        binding: {
          leaseEpoch: 'bind-1',
          storageClassResourceVersion: '5',
          boundAt: '',
        },
        provisionClaim: { leaseEpoch: 'exec-1', claimedAt: '' },
      }),
      'exec-1',
    ));

    expect(managedProvision).toHaveBeenCalledOnce();
    expect(narrowProvision).not.toHaveBeenCalled();
    expect(ensureVolume).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ driverHandle: 'managed:claim-uid' }),
    );
    expect(result.status).toMatchObject({
      phase: 'Bound',
      volumeRef: { uid: 'managed-volume-uid' },
    });
  });

  it('fails unknown-effect instead of reprovisioning after an epoch change', async () => {
    const provision = vi.fn();
    const controller = createVolumeClaimExecutionController({
      nodeId: 'worker-a',
      getStorageClass: async () => storageClass(),
      getDriver: async () => ({
        getHealth: async () => ({ healthy: true, checkedAt: '' }),
      } as unknown as StorageDriver),
      ensureVolume: vi.fn(),
    });
    const result = await controller.reconcile(request(
      claim({
        phase: 'Provisioning',
        assignedNode: 'worker-a',
        assignedDriver: 'local-directory',
        binding: { leaseEpoch: 'bind-1', storageClassResourceVersion: '5', boundAt: '' },
        provisionClaim: { leaseEpoch: 'old', claimedAt: '' },
      }),
      'new',
    ));
    expect(result.status?.error?.code).toBe('UNKNOWN_EFFECT');
    expect(provision).not.toHaveBeenCalled();
  });
});
