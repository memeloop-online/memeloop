import { describe, expect, it } from 'vitest';

import { runConformanceSuite } from '../drivers/driverConformance.js';
import { DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';
import { createFakeModelManagementDriver, createFakeModelManagementState, createModelManagementConformanceSuite, type ManagedModelRequest } from '../drivers/modelManagement.js';

const now = () => new Date('2026-07-26T12:00:00.000Z');

function createRequest<T>(
  method: string,
  payload: T,
  idempotencyKey: string,
  fencingEpoch = 1,
  resourceUid = 'model-call-uid-1',
): DriverRequestEnvelope<T> {
  return {
    apiVersion: DRIVER_REQUEST_API_VERSION,
    method,
    resource: {
      apiVersion: 'models.memeloop.io/v1alpha1',
      kind: 'ModelCallRecord',
      name: 'model-call-1',
      uid: resourceUid,
      generation: 1,
    },
    run: { uid: 'run-uid-1', attempt: 1 },
    fencingEpoch,
    requestId: `${method}:${idempotencyKey}`,
    idempotencyKey,
    deadline: '2026-07-26T12:01:00.000Z',
    actor: { id: 'controller/model-gateway', kind: 'controller' },
    session: { id: 'worker-session-1', keyFingerprint: 'ed25519:key-1' },
    capabilityHandleRef: 'capability:model-1',
    trace: { traceId: 'trace-1', spanId: `${method}:${idempotencyKey}` },
    payloadSchemaDigest: `sha256:${'e'.repeat(64)}`,
    payload,
  };
}

function payload(
  overrides: Partial<ManagedModelRequest> = {},
): ManagedModelRequest {
  return {
    modelClass: 'managed-text',
    modelDigest: `sha256:${'a'.repeat(64)}`,
    messages: [{ role: 'user', content: 'hello' }],
    maxOutputTokens: 128,
    inputClassification: 'confidential',
    residency: 'local',
    ...overrides,
  };
}

async function consume(
  driver: ReturnType<typeof createFakeModelManagementDriver>,
  request: DriverRequestEnvelope<ManagedModelRequest>,
): Promise<void> {
  for await (const _chunk of driver.generate(request)) {
    // consume
  }
}

describe('managed Model Provider driver', () => {
  it('passes the complete provider conformance suite', async () => {
    const state = createFakeModelManagementState();
    const suite = createModelManagementConformanceSuite({
      createRequest,
      recreate: () => createFakeModelManagementDriver({ state, now }),
    });
    const result = await runConformanceSuite(
      suite,
      createFakeModelManagementDriver({ state, now }),
    );

    expect(result).toEqual({ passed: 5, failed: 0, failures: [] });
  });

  it('rejects capability, digest, classification, residency, and budget drift', async () => {
    const driver = createFakeModelManagementDriver({ now });
    await expect(consume(driver, {
      ...createRequest('model.generate', payload(), 'denied', 1, 'denied'),
      capabilityHandleRef: 'capability:wrong',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(consume(
      driver,
      createRequest(
        'model.generate',
        payload({ modelDigest: `sha256:${'f'.repeat(64)}` }),
        'digest',
        1,
        'digest',
      ),
    )).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(consume(
      driver,
      createRequest(
        'model.generate',
        payload({ inputClassification: 'restricted' }),
        'classification',
        1,
        'classification',
      ),
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(consume(
      driver,
      createRequest(
        'model.generate',
        payload({ residency: 'eu' }),
        'residency',
        1,
        'residency',
      ),
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(consume(
      driver,
      createRequest(
        'model.generate',
        payload({ maxOutputTokens: 4097 }),
        'budget',
        1,
        'budget',
      ),
    )).rejects.toMatchObject({ code: 'EXHAUSTED' });
  });

  it('rejects unsupported secret fields, method confusion, and expired requests', async () => {
    const driver = createFakeModelManagementDriver({ now });
    await expect(consume(
      driver,
      createRequest(
        'model.generate',
        { ...payload(), apiKey: 'must-never-enter-driver-payload' } as ManagedModelRequest,
        'secret-field',
        1,
        'secret-field',
      ),
    )).rejects.toMatchObject({ code: 'INVALID' });
    await expect(consume(
      driver,
      createRequest(
        'model.estimate',
        payload(),
        'method',
        1,
        'method',
      ),
    )).rejects.toMatchObject({ code: 'INVALID' });
    await expect(consume(driver, {
      ...createRequest(
        'model.generate',
        payload(),
        'expired',
        1,
        'expired',
      ),
      deadline: '2026-07-26T11:59:59.000Z',
    })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('enforces streamed output budget and binds usage handles to the worker session', async () => {
    const driver = createFakeModelManagementDriver({
      now,
      generateText: async function*() {
        yield 'this exceeds one token';
      },
    });
    const request = createRequest(
      'model.generate',
      payload({ maxOutputTokens: 1 }),
      'bounded-output',
    );
    const chunks = [];
    for await (const chunk of driver.generate(request)) chunks.push(chunk);
    expect(chunks.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'EXHAUSTED' },
    });
    const started = chunks.find((chunk) => chunk.type === 'started');
    expect(started).toMatchObject({ type: 'started' });
    if (!started || started.type !== 'started') return;
    await expect(driver.inspectUsage({
      ...createRequest(
        'model.inspect-usage',
        { callHandle: started.callHandle },
        'session-drift',
      ),
      session: {
        id: 'worker-session-2',
        keyFingerprint: 'ed25519:key-other',
      },
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
