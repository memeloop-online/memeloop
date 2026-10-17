import { describe, expect, it } from 'vitest';

import { runConformanceSuite } from '../drivers/driverConformance.js';
import { DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';
import { createFakeStorageManagementDriver, createFakeStorageManagementState, createStorageManagementConformanceSuite } from '../drivers/storageManagement.js';
import type { OrchestrationError } from '../errors.js';

const now = () => new Date('2026-07-26T12:00:00.000Z');

function createRequest<T>(
  method: string,
  payload: T,
  idempotencyKey: string,
  fencingEpoch = 1,
  resourceUid = 'volume-uid-1',
): DriverRequestEnvelope<T> {
  return {
    apiVersion: DRIVER_REQUEST_API_VERSION,
    method,
    resource: {
      apiVersion: 'storage.memeloop.io/v1alpha1',
      kind: 'AgentVolume',
      name: 'volume-1',
      uid: resourceUid,
      generation: 1,
    },
    fencingEpoch,
    requestId: `${method}:${idempotencyKey}`,
    idempotencyKey,
    deadline: '2026-07-26T12:01:00.000Z',
    actor: { id: 'controller/storage', kind: 'controller' },
    session: { id: 'node-session-1', keyFingerprint: 'ed25519:key-1' },
    capabilityHandleRef: 'capability:storage-1',
    trace: { traceId: 'trace-1', spanId: `${method}:${idempotencyKey}` },
    payloadSchemaDigest: `sha256:${'e'.repeat(64)}`,
    payload,
  };
}

describe('managed Storage driver', () => {
  it('passes the complete controller and node conformance suite', async () => {
    const state = createFakeStorageManagementState();
    const suite = createStorageManagementConformanceSuite({
      createRequest,
      recreate: () => createFakeStorageManagementDriver({ state, now }),
    });
    const result = await runConformanceSuite(
      suite,
      createFakeStorageManagementDriver({ state, now }),
    );

    expect(result).toEqual({ passed: 5, failed: 0, failures: [] });
  });

  it('rejects idempotency-key reuse with a different payload after recreation', async () => {
    const state = createFakeStorageManagementState();
    let driver = createFakeStorageManagementDriver({ state, now });
    await driver.provision(createRequest(
      'storage.provision',
      {
        capacityBytes: 1024,
        accessMode: 'ReadWriteOnce',
        storageClass: 'local',
        replicaCount: 1,
      },
      'payload-bound',
    ));

    driver = createFakeStorageManagementDriver({ state, now });
    await expect(driver.provision(createRequest(
      'storage.provision',
      {
        capacityBytes: 2048,
        accessMode: 'ReadWriteOnce',
        storageClass: 'local',
        replicaCount: 1,
      },
      'payload-bound',
    ))).rejects.toEqual(expect.objectContaining<Partial<OrchestrationError>>({
      code: 'CONFLICT',
      retryable: false,
    }));
  });

  it('binds expansion and deletion idempotency keys to their exact payloads', async () => {
    const state = createFakeStorageManagementState();
    let driver = createFakeStorageManagementDriver({ state, now });
    const first = await driver.provision(createRequest(
      'storage.provision',
      {
        capacityBytes: 1024,
        accessMode: 'ReadWriteOnce',
        storageClass: 'local',
        replicaCount: 1,
      },
      'first-volume',
    ));
    const second = await driver.provision(createRequest(
      'storage.provision',
      {
        capacityBytes: 1024,
        accessMode: 'ReadWriteOnce',
        storageClass: 'local',
        replicaCount: 1,
      },
      'second-volume',
    ));
    await driver.expand(createRequest(
      'storage.expand',
      { volumeHandle: first.volumeHandle, capacityBytes: 2048 },
      'expand-bound',
    ));

    driver = createFakeStorageManagementDriver({ state, now });
    await expect(driver.expand(createRequest(
      'storage.expand',
      { volumeHandle: first.volumeHandle, capacityBytes: 2048 },
      'expand-bound',
    ))).resolves.toMatchObject({ capacityBytes: 2048 });
    await expect(driver.expand(createRequest(
      'storage.expand',
      { volumeHandle: first.volumeHandle, capacityBytes: 4096 },
      'expand-bound',
    ))).rejects.toMatchObject({ code: 'CONFLICT', retryable: false });
    await driver.deleteVolume(createRequest(
      'storage.delete',
      { volumeHandle: first.volumeHandle },
      'delete-bound',
    ));

    driver = createFakeStorageManagementDriver({ state, now });
    await expect(driver.deleteVolume(createRequest(
      'storage.delete',
      { volumeHandle: first.volumeHandle },
      'delete-bound',
    ))).resolves.toBeUndefined();
    await expect(driver.deleteVolume(createRequest(
      'storage.delete',
      { volumeHandle: second.volumeHandle },
      'delete-bound',
    ))).rejects.toMatchObject({ code: 'CONFLICT', retryable: false });
    expect(state.volumes.get(second.volumeHandle)?.volume.phase).toBe('Available');
  });

  it('detects drift for every persisted storage lifecycle operation', async () => {
    const state = createFakeStorageManagementState();
    const driver = createFakeStorageManagementDriver({ state, now });
    const volume = await driver.provision(createRequest(
      'storage.provision',
      { capacityBytes: 1024, accessMode: 'ReadWriteOnce', storageClass: 'local', replicaCount: 1 },
      'drift-volume',
    ));
    const snapshot = await driver.createSnapshot(createRequest(
      'storage.snapshot',
      { volumeHandle: volume.volumeHandle },
      'drift-snapshot',
    ));
    await expect(driver.createSnapshot(createRequest(
      'storage.snapshot',
      { volumeHandle: 'volume:foreign' },
      'drift-snapshot',
    ))).rejects.toMatchObject({ code: 'CONFLICT' });

    await driver.restoreSnapshot(createRequest(
      'storage.restore',
      { snapshotHandle: snapshot.snapshotHandle, capacityBytes: 2048 },
      'drift-restore',
    ));
    await expect(driver.restoreSnapshot(createRequest(
      'storage.restore',
      { snapshotHandle: snapshot.snapshotHandle, capacityBytes: 4096 },
      'drift-restore',
    ))).rejects.toMatchObject({ code: 'CONFLICT' });

    await driver.rebuildReplica(createRequest(
      'storage.rebuild',
      { volumeHandle: volume.volumeHandle, replicaCount: 2 },
      'drift-rebuild',
    ));
    await expect(driver.rebuildReplica(createRequest(
      'storage.rebuild',
      { volumeHandle: volume.volumeHandle, replicaCount: 3 },
      'drift-rebuild',
    ))).rejects.toMatchObject({ code: 'CONFLICT' });

    await driver.createBackup(createRequest(
      'storage.backup',
      { volumeHandle: volume.volumeHandle },
      'drift-backup',
    ));
    await expect(driver.createBackup(createRequest(
      'storage.backup',
      { volumeHandle: 'volume:foreign' },
      'drift-backup',
    ))).rejects.toMatchObject({ code: 'CONFLICT' });

    const stage = await driver.stage(createRequest(
      'storage.stage',
      { volumeHandle: volume.volumeHandle, nodeId: 'node-a' },
      'drift-stage',
    ));
    await expect(driver.stage(createRequest(
      'storage.stage',
      { volumeHandle: volume.volumeHandle, nodeId: 'node-b' },
      'drift-stage',
    ))).rejects.toMatchObject({ code: 'CONFLICT' });

    const publication = await driver.publish(createRequest(
      'storage.publish',
      { stageHandle: stage.stageHandle, workloadUid: 'workload-a', readOnly: false },
      'drift-publish',
    ));
    await expect(driver.publish(createRequest(
      'storage.publish',
      { stageHandle: stage.stageHandle, workloadUid: 'workload-b', readOnly: false },
      'drift-publish',
    ))).rejects.toMatchObject({ code: 'CONFLICT' });

    await driver.unpublish(createRequest(
      'storage.unpublish',
      { publishHandle: publication.publishHandle },
      'drift-unpublish',
    ));
    await expect(driver.unpublish(createRequest(
      'storage.unpublish',
      { publishHandle: 'publication:foreign' },
      'drift-unpublish',
    ))).rejects.toMatchObject({ code: 'CONFLICT' });

    await driver.unstage(createRequest(
      'storage.unstage',
      { stageHandle: stage.stageHandle },
      'drift-unstage',
    ));
    await expect(driver.unstage(createRequest(
      'storage.unstage',
      { stageHandle: 'stage:foreign' },
      'drift-unstage',
    ))).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
