import { describe, expect, it } from 'vitest';

import { runConformanceSuite } from '../drivers/driverConformance.js';
import { DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';
import { createFakeLoopRuntimeManagementDriver, createFakeLoopRuntimeState, createLoopRuntimeManagementConformanceSuite } from '../drivers/loopRuntimeManagement.js';

const now = () => new Date('2026-07-26T12:00:00.000Z');

function createRequest<T>(
  method: string,
  payload: T,
  idempotencyKey: string,
  fencingEpoch = 1,
  resourceUid = 'run-uid-1',
): DriverRequestEnvelope<T> {
  return {
    apiVersion: DRIVER_REQUEST_API_VERSION,
    method,
    resource: {
      apiVersion: 'execution.memeloop.io/v1alpha1',
      kind: 'AgentLoopRun',
      name: 'run-1',
      uid: resourceUid,
      generation: 1,
    },
    run: { uid: resourceUid, attempt: 1 },
    fencingEpoch,
    requestId: `${method}:${idempotencyKey}`,
    idempotencyKey,
    deadline: '2026-07-26T12:01:00.000Z',
    actor: { id: 'controller/runtime', kind: 'controller' },
    session: { id: 'worker-session-1', keyFingerprint: 'ed25519:key-1' },
    capabilityHandleRef: 'capability:runtime-1',
    trace: { traceId: 'trace-1', spanId: `${method}:${idempotencyKey}` },
    payloadSchemaDigest: `sha256:${'d'.repeat(64)}`,
    payload,
  };
}

describe('managed Loop Runtime driver', () => {
  it('passes the complete lifecycle conformance suite', async () => {
    const state = createFakeLoopRuntimeState();
    const suite = createLoopRuntimeManagementConformanceSuite({
      createRequest,
      recreate: () => createFakeLoopRuntimeManagementDriver({ state, now }),
    });
    const result = await runConformanceSuite(
      suite,
      createFakeLoopRuntimeManagementDriver({ state, now }),
    );

    expect(result).toEqual({ passed: 5, failed: 0, failures: [] });
  });
});
