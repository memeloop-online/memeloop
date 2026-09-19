import { describe, expect, it } from 'vitest';

import { DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';
import {
  assertManagementLeaseActive,
  assertManagementResponseCorrelation,
  createManagementDriverContext,
  type ManagementDriverState,
  managementLease,
  managementResponse,
} from '../drivers/managementDriverFramework.js';

function request(payload: unknown): DriverRequestEnvelope {
  return {
    apiVersion: DRIVER_REQUEST_API_VERSION,
    method: 'test.apply',
    resource: {
      apiVersion: 'test.memeloop.io/v1alpha1',
      kind: 'TestResource',
      name: 'test',
      uid: 'resource-1',
      generation: 1,
    },
    run: { uid: 'run-1', attempt: 1 },
    fencingEpoch: 2,
    requestId: 'request-1',
    idempotencyKey: 'apply-1',
    deadline: '2026-09-01T12:01:00.000Z',
    actor: { id: 'controller/test', kind: 'controller' },
    session: { id: 'session-1', keyFingerprint: 'key-1' },
    capabilityHandleRef: 'capability:test',
    trace: { traceId: 'trace-1', spanId: 'span-1' },
    payloadSchemaDigest: `sha256:${'e'.repeat(64)}`,
    payload,
  };
}

function state(): ManagementDriverState {
  return {
    idempotency: new Map(),
    idempotencyFingerprints: new Map(),
    fences: new Map(),
  };
}

describe('management driver framework', () => {
  it('replays only the complete authority-bound request and rejects drift', () => {
    const durable = state();
    const context = createManagementDriverContext({
      state: durable,
      now: () => new Date('2026-09-01T12:00:00.000Z'),
      driverName: 'test',
      requireRun: true,
    });
    const first = request({ value: 1 });
    context.validate(first, 'test.apply');
    context.remember(first, 'apply', 'handle:1');
    expect(context.replay(first, 'apply')).toBe('handle:1');

    const changedActor = { ...first, actor: { ...first.actor, id: 'controller/other' } };
    expect(() => context.replay(changedActor, 'apply')).toThrowError(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
    const changedPayload = { ...first, payload: { value: 2 } };
    expect(() => context.replay(changedPayload, 'apply')).toThrowError(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
  });

  it('fails closed when a persisted result has no fingerprint', () => {
    const durable = state();
    const context = createManagementDriverContext({
      state: durable,
      driverName: 'test',
    });
    const first = request({ value: 1 });
    durable.idempotency.set('resource-1:apply:apply-1', 'handle:1');
    expect(() => context.replay(first, 'apply')).toThrowError(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
  });

  it('captures and validates exact response correlation', () => {
    const first = request({ value: 1 });
    const wrapped = managementResponse(first, { accepted: true });
    expect(wrapped.correlation).toEqual({
      requestId: 'request-1',
      method: 'test.apply',
      resourceUid: 'resource-1',
      resourceGeneration: 1,
    });
    expect(() => {
      assertManagementResponseCorrelation(first, wrapped.correlation);
    }).not.toThrow();
    expect(() => {
      assertManagementResponseCorrelation(first, {
        ...wrapped.correlation,
        resourceGeneration: 2,
      });
    }).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
  });

  it('enforces lease expiry and revocation at point of use', () => {
    let current = new Date('2026-09-01T12:00:00.000Z');
    const now = () => current;
    const lease = managementLease(now, 1_000, 10_000, 'test');
    expect(() => {
      assertManagementLeaseActive(lease, now, 'test', 'lease:1');
    }).not.toThrow();

    current = new Date('2026-09-01T12:00:01.000Z');
    expect(() => {
      assertManagementLeaseActive(lease, now, 'test', 'lease:1');
    }).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );

    const revoked = { ...lease, revoked: true };
    expect(() => {
      assertManagementLeaseActive(revoked, now, 'test', 'lease:1');
    }).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });
});
