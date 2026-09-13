import { describe, expect, it } from 'vitest';

import { createCredentialManagementConformanceSuite, createFakeCredentialManagementDriver, createFakeCredentialManagementState } from '../drivers/credentialManagement.js';
import { runConformanceSuite } from '../drivers/driverConformance.js';
import { DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';

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
      kind: 'AgentRun',
      name: 'run-1',
      uid: resourceUid,
      generation: 1,
    },
    run: { uid: resourceUid, attempt: 1 },
    fencingEpoch,
    requestId: `${method}:${idempotencyKey}`,
    idempotencyKey,
    deadline: '2026-07-26T12:01:00.000Z',
    actor: { id: 'controller/credential', kind: 'controller' },
    session: {
      id: 'worker-session-1',
      keyFingerprint: 'ed25519:worker-1',
    },
    capabilityHandleRef: 'capability:credential-1',
    trace: { traceId: 'trace-1', spanId: `${method}:${idempotencyKey}` },
    payloadSchemaDigest: `sha256:${'c'.repeat(64)}`,
    payload,
  };
}

describe('managed Credential Broker driver', () => {
  it('passes the complete lifecycle and security conformance suite', async () => {
    const state = createFakeCredentialManagementState();
    const suite = createCredentialManagementConformanceSuite({
      createRequest,
      recreate: () => createFakeCredentialManagementDriver({ state, now }),
    });
    const result = await runConformanceSuite(
      suite,
      createFakeCredentialManagementDriver({ state, now }),
    );

    expect(result).toEqual({ passed: 5, failed: 0, failures: [] });
  });
});
