import { describe, expect, it } from 'vitest';

import { runConformanceSuite } from '../drivers/driverConformance.js';
import { DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';
import { createFakePolicyApprovalManagementDriver, createFakePolicyApprovalState, createPolicyApprovalConformanceSuite } from '../drivers/policyApprovalManagement.js';

const now = () => new Date('2026-07-26T12:00:00.000Z');

function createRequest<T>(
  method: string,
  payload: T,
  idempotencyKey: string,
  fencingEpoch = 1,
  resourceUid = 'policy-uid-1',
  actorKind: 'controller' | 'verifier' | 'admin' = 'controller',
): DriverRequestEnvelope<T> {
  return {
    apiVersion: DRIVER_REQUEST_API_VERSION,
    method,
    resource: {
      apiVersion: 'security.memeloop.io/v1alpha1',
      kind: 'PolicyDecision',
      name: resourceUid,
      uid: resourceUid,
      generation: 1,
    },
    fencingEpoch,
    requestId: `${method}:${idempotencyKey}`,
    idempotencyKey,
    deadline: '2026-07-26T12:01:00.000Z',
    actor: { id: `${actorKind}/policy`, kind: actorKind },
    session: { id: 'gateway-session-1', keyFingerprint: 'gateway:key-1' },
    capabilityHandleRef: 'capability:policy-1',
    trace: { traceId: 'trace-1', spanId: `${method}:${idempotencyKey}` },
    payloadSchemaDigest: `sha256:${'d'.repeat(64)}`,
    payload,
  };
}

describe('managed Policy and Approval driver', () => {
  it('passes the complete decision and security conformance suite', async () => {
    const state = createFakePolicyApprovalState();
    const recreate = () => createFakePolicyApprovalManagementDriver({ state, now });
    const suite = createPolicyApprovalConformanceSuite({ createRequest, recreate });
    const result = await runConformanceSuite(suite, recreate());

    expect(result).toEqual({ passed: 5, failed: 0, failures: [] });
  });
});
