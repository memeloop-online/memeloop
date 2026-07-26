import { describe, expect, it, vi } from 'vitest';

import { DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';
import { createManagedStorageDriverAdapter, type ManagedStorageAdapterStateStore } from '../drivers/managedStorageDriverAdapter.js';
import type { StorageDriver } from '../drivers/storageDriver.js';
import type { AgentVolumeClaimResource, AgentVolumeResource, StorageClassResource } from '../resources.js';

const now = () => new Date('2026-07-27T00:00:00.000Z');

function envelope<T>(
  method: string,
  payload: T,
  resource: { kind: string; uid: string },
  idempotencyKey: string,
  fencingEpoch = 1,
): DriverRequestEnvelope<T> {
  return {
    apiVersion: DRIVER_REQUEST_API_VERSION,
    method,
    resource: {
      apiVersion: 'storage.memeloop.io/v1alpha1',
      kind: resource.kind,
      name: resource.kind === 'AgentRun' ? 'run-1' : 'claim-1',
      uid: resource.uid,
      generation: 1,
    },
    run: { uid: 'run-uid-1', attempt: 1 },
    fencingEpoch,
    requestId: `${method}:${idempotencyKey}`,
    idempotencyKey,
    deadline: '2026-07-27T00:01:00.000Z',
    actor: { id: 'controller/storage', kind: 'controller' },
    session: { id: 'storage-session-1' },
    capabilityHandleRef: 'capability:storage-1',
    trace: { traceId: 'trace-1', spanId: idempotencyKey },
    payloadSchemaDigest: `sha256:${'a'.repeat(64)}`,
    payload,
  };
}

const claim: AgentVolumeClaimResource = {
  apiVersion: 'storage.memeloop.io/v1alpha1',
  kind: 'AgentVolumeClaim',
  metadata: {
    name: 'claim-1',
    uid: 'claim-uid-1',
    generation: 1,
    resourceVersion: '1',
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
};

const storageClass: StorageClassResource = {
  apiVersion: 'storage.memeloop.io/v1alpha1',
  kind: 'StorageClass',
  metadata: {
    name: 'local-data',
    uid: 'class-uid-1',
    generation: 1,
    resourceVersion: '1',
    creationTimestamp: '',
  },
  spec: {
    driver: 'local-directory',
    allowedAccessModes: ['ReadWriteOnce'],
  },
};

const volume: AgentVolumeResource = {
  apiVersion: 'storage.memeloop.io/v1alpha1',
  kind: 'AgentVolume',
  metadata: {
    name: 'volume-1',
    uid: 'volume-uid-1',
    generation: 1,
    resourceVersion: '1',
    creationTimestamp: '',
  },
  spec: {
    storageClassRef: claim.spec.storageClassRef,
    claimRef: {
      apiVersion: claim.apiVersion,
      kind: claim.kind,
      name: claim.metadata.name,
      uid: claim.metadata.uid,
    },
    driverHandle: 'localdir:claim-uid-1',
    capacityBytes: 1024,
    accessModes: ['ReadWriteOnce'],
    topology: { nodeId: 'node-1' },
  },
};

describe('managed production Storage adapter', () => {
  it('adopts provision/stage/publication state and rejects unsupported capabilities', async () => {
    const provision = vi.fn(async () => ({
      driverHandle: volume.spec.driverHandle,
      capacityBytes: 1024,
      topology: { nodeId: 'node-1' },
    }));
    const publish = vi.fn(async () => ({
      publishHandle: 'localpublish:run-1',
      mountPath: '/trusted/volume',
    }));
    const unpublish = vi.fn(async () => {});
    const deleteVolume = vi.fn(async () => {});
    const driver = {
      getCapabilities: async () => ({
        name: 'local-directory',
        accessModes: ['ReadWriteOnce'],
        snapshots: false,
        encryption: false,
      }),
      provision,
      publish,
      unpublish,
      delete: deleteVolume,
    } as unknown as StorageDriver;
    const state = new Map<string, unknown>();
    const stateStore: ManagedStorageAdapterStateStore = {
      get: async (key) => state.get(key),
      put: async (key, value) => {
        state.set(key, structuredClone(value));
      },
      delete: async (key) => {
        state.delete(key);
      },
    };
    const createAdapter = (capability = 'capability:storage-1') =>
      createManagedStorageDriverAdapter(driver, {
        now,
        authorizeRequest: (request) => request.capabilityHandleRef === capability,
        resolveProvisionInput: async () => ({ claim, storageClass }),
        resolveVolume: async (handle) => handle === volume.spec.driverHandle ? volume : undefined,
        stateStore,
        stableStageHandleFor: (request) => `storage-stage:${request.resource.uid}:${request.payload.nodeId}`,
        threatAssumptions: [
          'the host state store and resolved volume resources are trusted',
        ],
      });
    const adapter = createAdapter();
    await expect(adapter.getCapabilities()).resolves.toMatchObject({
      persistence: 'host',
      supportsSnapshots: false,
      supportsExpansion: false,
      supportsReplication: false,
      supportsBackup: false,
    });
    const provisionRequest = envelope(
      'storage.provision',
      {
        capacityBytes: 1024,
        accessMode: 'ReadWriteOnce' as const,
        storageClass: 'local-data',
        replicaCount: 1,
      },
      { kind: 'AgentVolumeClaim', uid: claim.metadata.uid },
      'provision-1',
    );
    expect((await adapter.provision(provisionRequest)).volumeHandle).toBe(
      volume.spec.driverHandle,
    );
    expect(
      (await createAdapter('capability:storage-2').provision({
        ...provisionRequest,
        session: { id: 'storage-session-after-restart' },
        capabilityHandleRef: 'capability:storage-2',
      })).volumeHandle,
    ).toBe(volume.spec.driverHandle);
    expect(provision).toHaveBeenCalledOnce();

    const stageRequest = envelope(
      'storage.stage',
      { volumeHandle: volume.spec.driverHandle, nodeId: 'node-1' },
      { kind: 'AgentRun', uid: 'run-uid-1' },
      'stage-1',
    );
    const stage = await adapter.stage(stageRequest);
    const restarted = createAdapter();
    expect((await restarted.stage(stageRequest)).stageHandle).toBe(
      stage.stageHandle,
    );
    const publishRequest = envelope(
      'storage.publish',
      {
        stageHandle: stage.stageHandle,
        workloadUid: 'workload-uid-1',
        readOnly: false,
      },
      { kind: 'AgentRun', uid: 'run-uid-1' },
      'publish-1',
    );
    const publication = await restarted.publish(publishRequest);
    expect((await createAdapter().publish(publishRequest)).publishHandle).toBe(
      publication.publishHandle,
    );
    expect(publish).toHaveBeenCalledOnce();
    await expect(restarted.unstage(envelope(
      'storage.unstage',
      { stageHandle: stage.stageHandle },
      { kind: 'AgentRun', uid: 'run-uid-1' },
      'unstage-too-early',
    ))).rejects.toMatchObject({ code: 'CONFLICT' });
    await restarted.unpublish(envelope(
      'storage.unpublish',
      { publishHandle: publication.publishHandle },
      { kind: 'AgentRun', uid: 'run-uid-1' },
      'unpublish-1',
    ));
    expect(unpublish).toHaveBeenCalledWith(publication.publishHandle);
    await restarted.unstage(envelope(
      'storage.unstage',
      { stageHandle: stage.stageHandle },
      { kind: 'AgentRun', uid: 'run-uid-1' },
      'unstage-1',
    ));
    await restarted.deleteVolume(envelope(
      'storage.delete',
      { volumeHandle: volume.spec.driverHandle },
      { kind: 'AgentVolumeClaim', uid: claim.metadata.uid },
      'delete-1',
    ));
    expect(deleteVolume).toHaveBeenCalledOnce();

    await expect(adapter.createSnapshot(envelope(
      'storage.snapshot.create',
      { volumeHandle: volume.spec.driverHandle },
      { kind: 'AgentVolumeClaim', uid: claim.metadata.uid },
      'snapshot-1',
    ))).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('fails closed on capability denial, payload extensions, drift, and stale fencing', async () => {
    const driver = {
      getCapabilities: async () => ({
        name: 'local-directory',
        accessModes: ['ReadWriteOnce'],
        snapshots: false,
        encryption: false,
      }),
      provision: vi.fn(async () => ({
        driverHandle: volume.spec.driverHandle,
      })),
    } as unknown as StorageDriver;
    const adapter = createManagedStorageDriverAdapter(driver, {
      now,
      authorizeRequest: (request) => request.capabilityHandleRef === 'capability:storage-1',
      resolveProvisionInput: async () => ({ claim, storageClass }),
      resolveVolume: async () => volume,
      threatAssumptions: ['the resolver is trusted'],
    });
    const request = envelope(
      'storage.provision',
      {
        capacityBytes: 1024,
        accessMode: 'ReadWriteOnce' as const,
        storageClass: 'local-data',
        replicaCount: 1,
      },
      { kind: 'AgentVolumeClaim', uid: claim.metadata.uid },
      'provision-secure',
      5,
    );
    await adapter.provision(request);
    await expect(adapter.provision({
      ...request,
      capabilityHandleRef: 'capability:wrong',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(adapter.provision({
      ...request,
      payload: { ...request.payload, capacityBytes: 2048 },
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(adapter.provision(envelope(
      'storage.provision',
      { ...request.payload, secret: 'must-not-cross' } as never,
      { kind: 'AgentVolumeClaim', uid: claim.metadata.uid },
      'unknown-field',
      5,
    ))).rejects.toMatchObject({ code: 'INVALID' });
    await expect(adapter.deleteVolume(envelope(
      'storage.delete',
      { volumeHandle: volume.spec.driverHandle },
      { kind: 'AgentVolumeClaim', uid: claim.metadata.uid },
      'stale',
      4,
    ))).rejects.toMatchObject({ code: 'STALE_EPOCH' });
  });
});
