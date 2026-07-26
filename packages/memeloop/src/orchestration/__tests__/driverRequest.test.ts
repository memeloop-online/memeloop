import { describe, expect, it } from 'vitest';

import { assertDriverRequestEnvelope, DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';
import { OrchestrationError } from '../errors.js';

const NOW = new Date('2026-07-26T12:00:00.000Z');

function request(
  overrides: Partial<DriverRequestEnvelope<Record<string, unknown>>> = {},
): unknown {
  return {
    apiVersion: DRIVER_REQUEST_API_VERSION,
    method: 'storage.provision',
    resource: {
      apiVersion: 'storage.memeloop.io/v1alpha1',
      kind: 'AgentVolumeClaim',
      name: 'claim-1',
      uid: 'claim-uid-1',
      generation: 1,
    },
    run: { uid: 'run-uid-1', attempt: 2 },
    fencingEpoch: 7,
    requestId: 'request-1',
    idempotencyKey: 'claim-uid-1:provision',
    deadline: '2026-07-26T12:00:30.000Z',
    actor: { id: 'controller/storage', kind: 'controller' },
    session: { id: 'session-1', keyFingerprint: 'ed25519:key-1' },
    capabilityHandleRef: 'capability:grant-1',
    trace: { traceId: 'trace-1', spanId: 'span-1' },
    payloadSchemaDigest: `sha256:${'a'.repeat(64)}`,
    payload: { sizeBytes: 1024 },
    ...overrides,
  };
}

function validate(value: unknown): void {
  assertDriverRequestEnvelope(value, {
    now: () => NOW,
    maxFutureDeadlineMs: 60_000,
    requireRun: true,
    requireFencing: true,
    requireCapability: true,
  });
}

describe('driver request envelope', () => {
  it('accepts a complete bounded request', () => {
    expect(() => {
      validate(request());
    }).not.toThrow();
  });

  it.each([
    ['newer protocol', request({ apiVersion: 'drivers.memeloop.io/v2' as never })],
    ['unknown field', { ...(request() as object), allowUnsafe: true }],
    ['missing run', request({ run: undefined })],
    ['invalid attempt', request({ run: { uid: 'run-uid-1', attempt: 0 } })],
    ['missing fence', request({ fencingEpoch: undefined })],
    ['missing capability', request({ capabilityHandleRef: undefined })],
    ['noncanonical schema digest', request({ payloadSchemaDigest: 'sha256:not-a-digest' })],
    ['excessive deadline', request({ deadline: '2026-07-26T12:02:00.000Z' })],
  ])('rejects %s without invoking a driver', (_name, value) => {
    expect(() => {
      validate(value);
    }).toThrow(OrchestrationError);
  });

  it('reports expired deadlines as TIMEOUT', () => {
    try {
      validate(request({ deadline: '2026-07-26T11:59:59.000Z' }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestrationError);
      expect((error as OrchestrationError).code).toBe('TIMEOUT');
    }
  });
});
