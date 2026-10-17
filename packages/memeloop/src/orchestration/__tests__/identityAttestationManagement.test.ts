import { describe, expect, it } from 'vitest';

import { runConformanceSuite } from '../drivers/driverConformance.js';
import { DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';
import {
  createFakeIdentityAttestationManagementDriver,
  createFakeIdentityAttestationState,
  createIdentityAttestationConformanceSuite,
} from '../drivers/identityAttestationManagement.js';

const now = () => new Date('2026-07-26T12:00:00.000Z');

function createRequest<T>(
  method: string,
  payload: T,
  idempotencyKey: string,
  fencingEpoch = 1,
  resourceUid = 'identity-uid-1',
  actorKind: 'controller' | 'verifier' | 'admin' = 'controller',
): DriverRequestEnvelope<T> {
  return {
    apiVersion: DRIVER_REQUEST_API_VERSION,
    method,
    resource: {
      apiVersion: 'security.memeloop.io/v1alpha1',
      kind: 'Identity',
      name: resourceUid,
      uid: resourceUid,
      generation: 1,
    },
    fencingEpoch,
    requestId: `${method}:${idempotencyKey}`,
    idempotencyKey,
    deadline: '2026-07-26T12:01:00.000Z',
    actor: { id: `${actorKind}/identity`, kind: actorKind },
    session: {
      id: 'gateway-session-1',
      keyFingerprint: 'gateway:key-1',
    },
    capabilityHandleRef: 'capability:identity-1',
    trace: { traceId: 'trace-1', spanId: `${method}:${idempotencyKey}` },
    payloadSchemaDigest: `sha256:${'b'.repeat(64)}`,
    payload,
  };
}

describe('managed Identity and Attestation driver', () => {
  it('passes the complete lifecycle and isolation conformance suite', async () => {
    const state = createFakeIdentityAttestationState();
    const suite = createIdentityAttestationConformanceSuite({
      createRequest,
      recreate: () => createFakeIdentityAttestationManagementDriver({ state, now }),
    });
    const result = await runConformanceSuite(
      suite,
      createFakeIdentityAttestationManagementDriver({ state, now }),
    );

    expect(result).toEqual({ passed: 5, failed: 0, failures: [] });
  });
});
