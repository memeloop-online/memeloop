import { describe, expect, it, vi } from 'vitest';

import type { StorageDriver } from '../drivers/storageDriver.js';
import type { AgentRunResource, AgentVolumeClaimResource, AgentVolumeResource, AgentWorkloadResource } from '../resources.js';
import { createRunVolumeController } from '../runVolumeController.js';

function workload(): AgentWorkloadResource {
  return {
    apiVersion: 'workload.memeloop.io/v1alpha1',
    kind: 'AgentWorkload',
    metadata: {
      name: 'work',
      uid: 'work-uid',
      generation: 1,
      resourceVersion: '1',
      creationTimestamp: '',
    },
    spec: {
      storagePolicy: {
        volumes: [{ name: 'data', claimRef: 'claim-1' }],
      },
    },
    status: { assignedNode: 'worker-a' },
  };
}

function run(status: AgentRunResource['status'] = { phase: 'Pending' }): AgentRunResource {
  return {
    apiVersion: 'run.memeloop.io/v1alpha1',
    kind: 'AgentRun',
    metadata: {
      name: 'run-1',
      uid: 'run-uid',
      generation: 1,
      resourceVersion: '2',
      creationTimestamp: '',
    },
    spec: {
      workloadRef: {
        apiVersion: workload().apiVersion,
        kind: workload().kind,
        name: workload().metadata.name,
        uid: workload().metadata.uid,
      },
    },
    status,
  };
}

function claim(): AgentVolumeClaimResource {
  return {
    apiVersion: 'storage.memeloop.io/v1alpha1',
    kind: 'AgentVolumeClaim',
    metadata: {
      name: 'claim-1',
      uid: 'claim-uid',
      generation: 1,
      resourceVersion: '3',
      creationTimestamp: '',
    },
    spec: {
      storageClassRef: {
        apiVersion: 'storage.memeloop.io/v1alpha1',
        kind: 'StorageClass',
        name: 'local',
      },
      accessMode: 'ReadWriteOnce',
    },
    status: {
      phase: 'Bound',
      assignedNode: 'worker-a',
      assignedDriver: 'local-directory',
      volumeRef: {
        apiVersion: 'storage.memeloop.io/v1alpha1',
        kind: 'AgentVolume',
        name: 'volume-1',
        uid: 'volume-uid',
      },
    },
  };
}

function volume(): AgentVolumeResource {
  return {
    apiVersion: 'storage.memeloop.io/v1alpha1',
    kind: 'AgentVolume',
    metadata: {
      name: 'volume-1',
      uid: 'volume-uid',
      generation: 1,
      resourceVersion: '4',
      creationTimestamp: '',
    },
    spec: {
      storageClassRef: claim().spec.storageClassRef,
      driverHandle: 'localdir:1',
      topology: { nodeId: 'worker-a' },
    },
  };
}

function request(resource: AgentRunResource, leaseEpoch = 'epoch-1') {
  return {
    resource,
    actor: { id: 'controller/run-volume', kind: 'controller' as const },
    leaseEpoch,
    now: new Date('2026-07-23T00:00:00Z'),
  };
}

describe('createRunVolumeController', () => {
  it('fences before publish, persists opaque handles, and releases explicitly', async () => {
    const publish = vi.fn(async () => ({
      publishHandle: 'publish:1',
      mountPath: '/host/private/path',
    }));
    const unpublish = vi.fn(async () => {});
    const driver = { publish, unpublish } as unknown as StorageDriver;
    const recordPublished = vi.fn(async () => {});
    const recordUnpublished = vi.fn(async () => {});
    const controller = createRunVolumeController({
      nodeId: 'worker-a',
      getWorkload: async () => workload(),
      getClaim: async () => claim(),
      getVolume: async () => volume(),
      getDriver: async () => driver,
      recordPublished,
      recordUnpublished,
    });
    const fenced = await controller.reconcile(request(run(), 'publish-1'));
    expect(fenced.status).toMatchObject({
      volumePhase: 'Publishing',
      volumePublishClaim: { leaseEpoch: 'publish-1' },
    });
    expect(publish).not.toHaveBeenCalled();

    const published = await controller.reconcile(request(run(fenced.status), 'publish-1'));
    expect(published.status).toMatchObject({
      volumePhase: 'Publishing',
      volumeBindings: [{
        name: 'data',
        publishHandle: 'publish:1',
        assignedNode: 'worker-a',
      }],
    });
    const ready = await controller.reconcile(request(run(published.status), 'publish-1'));
    expect(ready.status).toMatchObject({
      volumePhase: 'Ready',
      volumeBindings: [{
        name: 'data',
        publishHandle: 'publish:1',
        assignedNode: 'worker-a',
      }],
    });
    expect(JSON.stringify(ready.status)).not.toContain('/host/private/path');
    expect(recordPublished).toHaveBeenCalledOnce();

    const releasing = await controller.reconcile(request(
      run({
        ...ready.status,
        volumeReleaseRequestedAt: '2026-07-23T01:00:00Z',
      }),
      'publish-1',
    ));
    expect(releasing.status).toMatchObject({ volumePhase: 'Releasing' });
    const released = await controller.reconcile(request(run(releasing.status), 'publish-1'));
    expect(unpublish).toHaveBeenCalledWith('publish:1');
    expect(recordUnpublished).toHaveBeenCalledOnce();
    expect(released.status).toMatchObject({ volumePhase: 'Released' });
  });

  it('fails unknown-effect rather than republishing after an epoch change', async () => {
    const publish = vi.fn();
    const controller = createRunVolumeController({
      nodeId: 'worker-a',
      getWorkload: async () => workload(),
      getClaim: async () => claim(),
      getVolume: async () => volume(),
      getDriver: async () => ({ publish } as unknown as StorageDriver),
    });
    const result = await controller.reconcile(request(
      run({
        phase: 'Pending',
        volumePhase: 'Publishing',
        volumePublishClaim: { leaseEpoch: 'old', claimedAt: '' },
      }),
      'new',
    ));
    expect(result.status).toMatchObject({ volumeError: { code: 'UNKNOWN_EFFECT' } });
    expect(publish).not.toHaveBeenCalled();
  });

  it('routes stage, publish, unpublish, and unstage through managed storage', async () => {
    const narrowPublish = vi.fn();
    const stage = vi.fn(async () => ({
      stageHandle: 'stage:run-1',
      volumeHandle: 'driver:volume-1',
      resourceUid: 'run-uid',
      nodeId: 'worker-a',
    }));
    const publish = vi.fn(async () => ({
      publishHandle: 'publish:managed',
      stageHandle: 'stage:run-1',
      resourceUid: 'run-uid',
      workloadUid: 'workload-uid',
      readOnly: false,
    }));
    const unpublish = vi.fn(async () => {});
    const unstage = vi.fn(async () => {});
    const controller = createRunVolumeController({
      nodeId: 'worker-a',
      getWorkload: async () => workload(),
      getClaim: async () => claim(),
      getVolume: async () => volume(),
      getDriver: async () => ({ publish: narrowPublish } as unknown as StorageDriver),
      managed: {
        getDriver: async () => ({
          stage,
          publish,
          unpublish,
          unstage,
        } as never),
        createStageRequest: async () => ({} as never),
        createPublishRequest: async () => ({} as never),
        createUnpublishRequest: async () => ({} as never),
        createUnstageRequest: async () => ({} as never),
      },
    });
    const published = await controller.reconcile(request(
      run({
        phase: 'Pending',
        volumePhase: 'Publishing',
        volumePublishClaim: { leaseEpoch: 'managed-1', claimedAt: '' },
      }),
      'managed-1',
    ));
    expect(published.status).toMatchObject({
      volumeBindings: [{
        stageHandle: 'stage:run-1',
        publishHandle: 'publish:managed',
      }],
    });
    expect(narrowPublish).not.toHaveBeenCalled();

    const released = await controller.reconcile(request(
      run({
        ...published.status,
        volumePhase: 'Releasing',
      }),
      'managed-1',
    ));
    expect(unpublish).toHaveBeenCalledOnce();
    expect(unstage).toHaveBeenCalledOnce();
    expect(released.status).toMatchObject({ volumePhase: 'Released' });
  });
});
