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
});
