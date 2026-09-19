import { describe, expect, it } from 'vitest';

import { createAuditTelemetryConformanceSuite, createFakeAuditTelemetryManagementDriver, createFakeAuditTelemetryState } from '../drivers/auditTelemetryManagement.js';
import { runConformanceSuite } from '../drivers/driverConformance.js';
import { DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';

const now = () => new Date('2026-07-26T12:00:00.000Z');

function createRequest<T>(
  method: string,
  payload: T,
  idempotencyKey: string,
  fencingEpoch = 1,
  resourceUid = 'audit-uid-1',
  actorKind: 'controller' | 'verifier' | 'admin' = 'controller',
): DriverRequestEnvelope<T> {
  return {
    apiVersion: DRIVER_REQUEST_API_VERSION,
    method,
    resource: {
      apiVersion: 'audit.memeloop.io/v1alpha1',
      kind: 'AuditStream',
      name: resourceUid,
      uid: resourceUid,
      generation: 1,
    },
    fencingEpoch,
    requestId: `${method}:${idempotencyKey}`,
    idempotencyKey,
    deadline: '2026-07-26T12:01:00.000Z',
    actor: { id: `${actorKind}/audit`, kind: actorKind },
    session: { id: 'gateway-session-1', keyFingerprint: 'gateway:key-1' },
    capabilityHandleRef: 'capability:audit-1',
    trace: { traceId: 'trace-1', spanId: `${method}:${idempotencyKey}` },
    payloadSchemaDigest: `sha256:${'d'.repeat(64)}`,
    payload,
  };
}

describe('managed Audit and Telemetry driver', () => {
  it('passes the append-only security and durability conformance suite', async () => {
    const state = createFakeAuditTelemetryState();
    const recreate = () => createFakeAuditTelemetryManagementDriver({ state, now });
    const suite = createAuditTelemetryConformanceSuite({
      createRequest,
      recreate,
      createQuotaDriver: () =>
        createFakeAuditTelemetryManagementDriver({
          state: createFakeAuditTelemetryState(),
          now,
          maxRecordsPerResource: 1,
        }),
    });
    const result = await runConformanceSuite(suite, recreate());

    expect(result).toEqual({ passed: 5, failed: 0, failures: [] });
  });
});
