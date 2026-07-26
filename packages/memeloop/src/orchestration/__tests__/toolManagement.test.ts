import { describe, expect, it } from 'vitest';

import { runConformanceSuite } from '../drivers/driverConformance.js';
import { DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';
import { createFakeToolManagementDriver, createFakeToolManagementState, createToolManagementConformanceSuite } from '../drivers/toolManagement.js';

const now = () => new Date('2026-07-26T12:00:00.000Z');

function createRequest<T>(
  method: string,
  payload: T,
  idempotencyKey: string,
  fencingEpoch = 1,
  resourceUid = 'tool-uid-1',
  actorKind: 'controller' | 'verifier' | 'admin' = 'controller',
): DriverRequestEnvelope<T> {
  return {
    apiVersion: DRIVER_REQUEST_API_VERSION,
    method,
    resource: {
      apiVersion: 'execution.memeloop.io/v1alpha1',
      kind: 'ToolOperation',
      name: resourceUid,
      uid: resourceUid,
      generation: 1,
    },
    fencingEpoch,
    requestId: `${method}:${idempotencyKey}`,
    idempotencyKey,
    deadline: '2026-07-26T12:01:00.000Z',
    actor: { id: `${actorKind}/tool`, kind: actorKind },
    session: { id: 'gateway-session-1', keyFingerprint: 'gateway:key-1' },
    capabilityHandleRef: 'capability:tool-1',
    trace: { traceId: 'trace-1', spanId: `${method}:${idempotencyKey}` },
    payloadSchemaDigest: `sha256:${'d'.repeat(64)}`,
    payload,
  };
}

describe('managed Tool Catalog and Execution driver', () => {
  it('passes catalog, streaming, recovery, and security conformance', async () => {
    const state = createFakeToolManagementState();
    const recreate = () => createFakeToolManagementDriver({ state, now });
    const suite = createToolManagementConformanceSuite({ createRequest, recreate });
    const result = await runConformanceSuite(suite, recreate());

    expect(result).toEqual({ passed: 5, failed: 0, failures: [] });
  });
});
