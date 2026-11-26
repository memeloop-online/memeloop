import { describe, expect, it } from 'vitest';

import { createArtifactManagementConformanceSuite, createFakeArtifactManagementDriver, createFakeArtifactManagementState } from '../drivers/artifactManagement.js';
import { runConformanceSuite } from '../drivers/driverConformance.js';
import { DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';

const now = () => new Date('2026-07-26T12:00:00.000Z');

function createRequest<T>(
  method: string,
  payload: T,
  idempotencyKey: string,
  fencingEpoch = 1,
  resourceUid = 'artifact-uid-1',
): DriverRequestEnvelope<T> {
  return {
    apiVersion: DRIVER_REQUEST_API_VERSION,
    method,
    resource: {
      apiVersion: 'artifacts.memeloop.io/v1alpha1',
      kind: 'ArtifactRecord',
      name: resourceUid,
      uid: resourceUid,
      generation: 1,
    },
    fencingEpoch,
    requestId: `${method}:${idempotencyKey}`,
    idempotencyKey,
    deadline: '2026-07-26T12:01:00.000Z',
    actor: { id: 'controller/artifact', kind: 'controller' },
    capabilityHandleRef: 'capability:artifact-1',
    trace: { traceId: 'trace-1', spanId: `${method}:${idempotencyKey}` },
    payloadSchemaDigest: `sha256:${'a'.repeat(64)}`,
    payload,
  };
}

describe('managed Artifact driver', () => {
  it('passes the complete lifecycle and hostile-input conformance suite', async () => {
    const state = createFakeArtifactManagementState();
    const suite = createArtifactManagementConformanceSuite({
      createRequest,
      recreate: () => createFakeArtifactManagementDriver({ state, now }),
    });
    const result = await runConformanceSuite(
      suite,
      createFakeArtifactManagementDriver({ state, now }),
    );

    expect(result).toEqual({ passed: 5, failed: 0, failures: [] });
  });
});
