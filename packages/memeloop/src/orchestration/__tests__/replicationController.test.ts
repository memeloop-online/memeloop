import { describe, expect, it, vi } from 'vitest';
import type { OrchestrationResource, OrchestrationWatchEvent } from '../client.js';
import { createReplicationController } from '../controllers/storageReplication.js';
import type { ControlLeaseGrant, ControlStore } from '../controlStore.js';
import type { AgentVolumeResource, AgentVolumeStatus } from '../resources.js';

function makeLease(name: string, holder: string, epoch = '1'): ControlLeaseGrant {
  return {
    name,
    holder,
    leaseId: `lease-${holder}`,
    epoch,
    acquiredAt: '2026-07-19T00:00:00.000Z',
    renewedAt: '2026-07-19T00:00:00.000Z',
    expiresAt: '2026-07-19T00:00:10.000Z',
    resourceVersion: '1',
  };
}

function makeFakeStore(current?: AgentVolumeResource): ControlStore & { __pushEvent: (e: OrchestrationWatchEvent) => void } {
  const events: OrchestrationWatchEvent[] = [];
  let resolveWatch: ((value: OrchestrationWatchEvent) => void) | null = null;

  return {
    acquireLease: vi.fn(async (_actor, request) => makeLease(request.name, request.holder)),
    renewLease: vi.fn(async (_actor, identity, _ttl) => ({ ...makeLease(identity.name, identity.holder), epoch: identity.epoch })),
    releaseLease: vi.fn(async () => undefined),
    watch: vi.fn((_query) => {
      let done = false;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (done) return { done: true as const, value: undefined };
              if (events.length > 0) return { done: false as const, value: events.shift()! };
              const event = await new Promise<OrchestrationWatchEvent>((resolve) => {
                resolveWatch = resolve;
              });
              return { done: false as const, value: event };
            },
            async return() {
              done = true;
              return { done: true as const, value: undefined };
            },
          };
        },
      };
    }),
    updateStatus: vi.fn(async (_actor, _ref, status, _options) => ({ metadata: { resourceVersion: '2' }, status } as OrchestrationResource)),
    get: vi.fn(async () =>
      current === undefined ? null : ({
        ...current,
        spec: { ...current.spec },
      })
    ),
    list: vi.fn(async () => ({ items: [] })),
    create: vi.fn(async () => ({} as OrchestrationResource)),
    delete: vi.fn(async () => ({ deleted: true })),
    compact: vi.fn(async () => ({ compactedThrough: '0', resourceVersion: '0' })),
    snapshot: vi.fn(async () => ({ resourceVersion: '0', createdAt: '2026-07-19T00:00:00.000Z' })),
    getHealth: vi.fn(async () => ({ healthy: true, resourceVersion: '0' })),
    close: vi.fn(async () => undefined),
    __pushEvent(event: OrchestrationWatchEvent) {
      if (resolveWatch) {
        resolveWatch(event);
        resolveWatch = null;
      } else events.push(event);
    },
  } as unknown as ControlStore & { __pushEvent: (e: OrchestrationWatchEvent) => void };
}

function makeStorageClass() {
  return {
    apiVersion: 'storage.memeloop.io/v1alpha1',
    kind: 'StorageClass',
    metadata: { name: 'default', namespace: 'default', uid: 'sc-1', generation: 1, resourceVersion: '1', creationTimestamp: '2026-07-19T00:00:00.000Z' },
    spec: { driver: 'sqlite', replication: { factor: 2, autoRebuild: true } },
  } as const;
}

function makeWatchEvent(resource: AgentVolumeResource): OrchestrationWatchEvent {
  return {
    type: 'ADDED',
    resourceVersion: resource.metadata.resourceVersion,
    resource: { ...resource, spec: { ...resource.spec } },
  };
}

const volumeSpec: AgentVolumeResource['spec'] = {
  storageClassRef: {
    apiVersion: 'storage.memeloop.io/v1alpha1',
    kind: 'StorageClass',
    name: 'default',
  },
  driverHandle: 'sqlite:volume-data',
};

describe('createReplicationController', () => {
  it('reconciles volume and runner commits status through CAS', async () => {
    const volume: AgentVolumeResource = {
      apiVersion: 'storage.memeloop.io/v1alpha1',
      kind: 'AgentVolume',
      metadata: { name: 'data', namespace: 'default', uid: 'vol-1', generation: 1, resourceVersion: '1', creationTimestamp: '2026-07-19T00:00:00.000Z' },
      spec: volumeSpec,
      status: {
        replicas: [{ nodeId: 'n1', state: 'healthy', contentHash: 'sha256:abc', updatedAt: '2026-07-19T00:00:00.000Z' }],
        primaryEpoch: 0,
        contentHash: 'sha256:abc',
        health: 'healthy',
      },
    };
    const store = makeFakeStore(volume);
    const getStorageClass = vi.fn(async () => makeStorageClass());
    const listNodes = vi.fn(async () => [{ nodeId: 'n1', trust: 'trusted' as const, faultDomain: 'rack1' }, { nodeId: 'n2', trust: 'trusted' as const, faultDomain: 'rack2' }]);
    const readReplicaHash = vi.fn(async () => 'sha256:abc');
    let committedEpoch = 0;
    const commitPrimaryFence = vi.fn(async (
      _volume: AgentVolumeResource,
      previous: { nodeId?: string; epoch: number },
      next: { nodeId: string; epoch: number },
    ) => {
      if (previous.epoch !== committedEpoch) throw new Error('stale primary fence');
      committedEpoch = next.epoch;
    });
    const transferReplica = vi.fn(async (
      _volume: AgentVolumeResource,
      _snapshot: { snapshotHandle: string; contentHash: string },
      _from: string,
      _to: string,
      epoch: number,
    ) => {
      if (epoch !== committedEpoch) throw new Error('uncommitted primary epoch');
    });
    const capturePrimarySnapshot = vi.fn(async () => ({
      snapshotHandle: 'snapshot:n1:1',
      contentHash: 'sha256:abc',
    }));
    const releaseSnapshot = vi.fn(async () => {});

    const runner = await createReplicationController({
      store: store as unknown as ControlStore,
      getStorageClass,
      listNodes,
      transport: {
        readReplicaHash,
        commitPrimaryFence,
        capturePrimarySnapshot,
        transferReplica,
        releaseSnapshot,
      },
      actor: { id: 'rep-ctrl', kind: 'controller' },
    });

    store.__pushEvent(makeWatchEvent(volume));
    await vi.waitFor(() => {
      expect(transferReplica).toHaveBeenCalled();
    });

    expect(getStorageClass).toHaveBeenCalled();
    expect(listNodes).toHaveBeenCalled();
    expect(commitPrimaryFence).toHaveBeenCalledWith(
      volume,
      { epoch: 0 },
      { nodeId: 'n1', epoch: 1 },
    );
    expect(commitPrimaryFence.mock.invocationCallOrder[0]).toBeLessThan(
      transferReplica.mock.invocationCallOrder[0],
    );
    expect(capturePrimarySnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      transferReplica.mock.invocationCallOrder[0],
    );
    expect(releaseSnapshot).toHaveBeenCalledOnce();
    expect(store.updateStatus).toHaveBeenCalled();

    const call = (store.updateStatus as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    const status = call[2] as AgentVolumeStatus;
    expect(status.replicas?.length).toBeGreaterThanOrEqual(2);
    await runner.stop();
  });

  it('skips when storage class is missing', async () => {
    const volume: AgentVolumeResource = {
      apiVersion: 'storage.memeloop.io/v1alpha1',
      kind: 'AgentVolume',
      metadata: { name: 'data', namespace: 'default', uid: 'vol-1', generation: 1, resourceVersion: '1', creationTimestamp: '2026-07-19T00:00:00.000Z' },
      spec: volumeSpec,
    };
    const store = makeFakeStore(volume);

    const runner = await createReplicationController({
      store: store as unknown as ControlStore,
      getStorageClass: vi.fn(async () => null),
      listNodes: vi.fn(async () => []),
      transport: {
        readReplicaHash: vi.fn(),
        commitPrimaryFence: vi.fn(),
        capturePrimarySnapshot: vi.fn(),
        transferReplica: vi.fn(),
        releaseSnapshot: vi.fn(),
      },
      actor: { id: 'rep-ctrl', kind: 'controller' },
    });

    store.__pushEvent(makeWatchEvent(volume));
    // updateStatus must NOT be called (reconcile returns {ready:true} with no status)
    await new Promise((r) => setTimeout(r, 100));
    expect(store.updateStatus).not.toHaveBeenCalled();
    await runner.stop();
  });

  it('rebuilds degraded replica from primary', async () => {
    const volume: AgentVolumeResource = {
      apiVersion: 'storage.memeloop.io/v1alpha1',
      kind: 'AgentVolume',
      metadata: { name: 'data', namespace: 'default', uid: 'vol-1', generation: 1, resourceVersion: '1', creationTimestamp: '2026-07-19T00:00:00.000Z' },
      spec: volumeSpec,
      status: {
        replicas: [
          { nodeId: 'n1', state: 'degraded', updatedAt: '2026-07-19T00:00:00.000Z' },
          { nodeId: 'n2', state: 'healthy', contentHash: 'sha256:abc', updatedAt: '2026-07-19T00:00:00.000Z' },
        ],
        primaryNodeId: 'n2',
        primaryEpoch: 1,
        contentHash: 'sha256:abc',
        health: 'degraded',
      },
    };
    const store = makeFakeStore(volume);
    let n1Hash = 'sha256:bad';
    const readReplicaHash = vi.fn(async (_v: AgentVolumeResource, nodeId: string) => nodeId === 'n1' ? n1Hash : 'sha256:abc');
    const transferReplica = vi.fn(async () => {
      n1Hash = 'sha256:abc';
    });

    const runner = await createReplicationController({
      store: store as unknown as ControlStore,
      getStorageClass: vi.fn(async () => makeStorageClass()),
      listNodes: vi.fn(async () => [{ nodeId: 'n1', trust: 'trusted' as const }, { nodeId: 'n2', trust: 'trusted' as const }]),
      transport: {
        readReplicaHash,
        commitPrimaryFence: vi.fn(),
        capturePrimarySnapshot: vi.fn(async () => ({
          snapshotHandle: 'snapshot:n2:1',
          contentHash: 'sha256:abc',
        })),
        transferReplica,
        releaseSnapshot: vi.fn(),
      },
      actor: { id: 'rep-ctrl', kind: 'controller' },
    });

    store.__pushEvent(makeWatchEvent(volume));
    await vi.waitFor(() => {
      expect(transferReplica).toHaveBeenCalled();
    });

    const call = (store.updateStatus as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    const status = call[2] as AgentVolumeStatus;
    const n1 = status.replicas?.find((r) => r.nodeId === 'n1');
    expect(n1?.state).toBe('healthy');
    expect(n1?.contentHash).toBe('sha256:abc');
    await runner.stop();
  });

  it('elects new primary when current primary is lost', async () => {
    const volume: AgentVolumeResource = {
      apiVersion: 'storage.memeloop.io/v1alpha1',
      kind: 'AgentVolume',
      metadata: { name: 'data', namespace: 'default', uid: 'vol-1', generation: 1, resourceVersion: '1', creationTimestamp: '2026-07-19T00:00:00.000Z' },
      spec: volumeSpec,
      status: {
        replicas: [
          { nodeId: 'n1', state: 'offline', updatedAt: '2026-07-19T00:00:00.000Z' },
          { nodeId: 'n2', state: 'healthy', contentHash: 'sha256:abc', updatedAt: '2026-07-19T00:00:00.000Z' },
        ],
        primaryNodeId: 'n1',
        primaryEpoch: 1,
        contentHash: 'sha256:abc',
        health: 'degraded',
      },
    };
    const store = makeFakeStore(volume);
    const readReplicaHash = vi.fn(async (_v: AgentVolumeResource, nodeId: string) => nodeId === 'n1' ? null : 'sha256:abc');
    const commitPrimaryFence = vi.fn(async () => {});

    const runner = await createReplicationController({
      store: store as unknown as ControlStore,
      getStorageClass: vi.fn(async () => makeStorageClass()),
      listNodes: vi.fn(async () => [{ nodeId: 'n1', trust: 'trusted' as const }, { nodeId: 'n2', trust: 'trusted' as const }]),
      transport: {
        readReplicaHash,
        commitPrimaryFence,
        capturePrimarySnapshot: vi.fn(async () => ({
          snapshotHandle: 'snapshot:n2:2',
          contentHash: 'sha256:abc',
        })),
        transferReplica: vi.fn(async () => {}),
        releaseSnapshot: vi.fn(),
      },
      actor: { id: 'rep-ctrl', kind: 'controller' },
    });

    store.__pushEvent(makeWatchEvent(volume));
    await vi.waitFor(() => {
      expect(store.updateStatus).toHaveBeenCalled();
    });

    const call = (store.updateStatus as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    const status = call[2] as AgentVolumeStatus;
    expect(status.primaryNodeId).toBe('n2');
    expect(status.primaryEpoch ?? 0).toBe(2);
    expect(commitPrimaryFence).toHaveBeenCalledWith(
      volume,
      { nodeId: 'n1', epoch: 1 },
      { nodeId: 'n2', epoch: 2 },
    );
    await runner.stop();
  });
});
