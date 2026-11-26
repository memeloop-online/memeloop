import { describe, expect, it } from 'vitest';

import { DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';
import { createManagedModelGatewayAdapter, type ManagedModelGatewayAdapterOptions } from '../drivers/managedModelGatewayAdapter.js';
import { createModelGateway, type ModelGatewayCallRecord, type ModelGatewayExecutor } from '../drivers/modelGateway.js';
import type { ManagedModelChunk, ManagedModelDescriptor, ManagedModelRequest, ModelManagementDriver } from '../drivers/modelManagement.js';
import type { ModelStreamChunk } from '../drivers/modelProviderDriver.js';
import { createInMemoryModelAccessHandleBroker, type ModelAccessHandleBroker, type ModelHandleSigner } from '../security/modelAccessHandle.js';

const now = () => new Date('2026-07-26T12:00:00.000Z');
const DIGEST = `sha256:${'a'.repeat(64)}`;
const MODEL_REF = {
  apiVersion: 'models.memeloop.io/v1alpha1',
  kind: 'ModelClass',
  name: 'managed-text',
};
const MODEL: ManagedModelDescriptor = {
  modelClass: MODEL_REF.name,
  provider: 'test-provider',
  model: 'test-model',
  digest: DIGEST,
  modalities: ['text'],
  contextWindow: 32_768,
  residency: ['local'],
  mode: 'broker',
  maxInputClassification: 'confidential',
  outputClassification: 'confidential',
  inputTrust: 'sanitized',
  outputTrust: 'untrusted',
  inputCostPerMillion: 1,
  outputCostPerMillion: 2,
};
const signer: ModelHandleSigner = {
  sign: async (payload) => new Uint8Array([...payload].reverse()),
  verify: async (payload, signature) =>
    signature.length === payload.length &&
    signature.every((byte, index) => byte === payload[payload.length - 1 - index]),
};

function request<T>(
  method: string,
  payload: T,
  token: string,
  overrides: Partial<DriverRequestEnvelope<T>> = {},
): DriverRequestEnvelope<T> {
  return {
    apiVersion: DRIVER_REQUEST_API_VERSION,
    method,
    resource: {
      apiVersion: 'models.memeloop.io/v1alpha1',
      kind: 'ModelCallRecord',
      name: 'managed-call',
      uid: 'managed-call-uid',
      generation: 1,
    },
    run: { uid: 'run-uid', attempt: 2 },
    fencingEpoch: 1,
    requestId: `${method}:request`,
    idempotencyKey: `${method}:idempotency`,
    deadline: '2026-07-26T12:01:00.000Z',
    actor: { id: 'controller/model', kind: 'controller' },
    session: { id: 'session-1', keyFingerprint: 'worker-key-1' },
    capabilityHandleRef: token,
    trace: { traceId: 'trace-1', spanId: method },
    payloadSchemaDigest: `sha256:${'b'.repeat(64)}`,
    payload,
    ...overrides,
  };
}

function modelPayload(
  overrides: Partial<ManagedModelRequest> = {},
): ManagedModelRequest {
  return {
    modelClass: MODEL.modelClass,
    modelDigest: MODEL.digest,
    messages: [{ role: 'user', content: 'hello' }],
    maxOutputTokens: 128,
    inputClassification: 'confidential',
    residency: 'local',
    ...overrides,
  };
}

function executor(): ModelGatewayExecutor {
  return {
    generate: () =>
      (async function*(): AsyncIterable<ModelStreamChunk> {
        yield { type: 'delta', delta: 'hello ' };
        yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } };
        yield { type: 'delta', delta: 'world' };
        yield { type: 'done' };
      })(),
    cancel: async () => {},
  };
}

async function fixture(): Promise<{
  broker: ModelAccessHandleBroker;
  driver: ModelManagementDriver;
  records: ModelGatewayCallRecord[];
  token: string;
}> {
  const broker = createInMemoryModelAccessHandleBroker({
    signer,
    audience: 'gateway://managed-adapter-test',
    now,
  });
  const handle = await broker.issueModelAccessHandle({
    modelClassRef: MODEL_REF,
    modelDigest: MODEL.digest,
    runRef: {
      apiVersion: 'run.memeloop.io/v1alpha1',
      kind: 'AgentRun',
      name: 'run',
      uid: 'run-uid',
    },
    attempt: 2,
    workerKey: 'worker-key-1',
  });
  const records: ModelGatewayCallRecord[] = [];
  const gateway = createModelGateway({
    broker,
    executor: executor(),
    recorder: {
      recordCall: (record) => {
        records.push(record);
      },
    },
    now,
  });
  const adapterOptions: ManagedModelGatewayAdapterOptions = {
    models: [MODEL],
    capabilities: {
      name: 'real-model-gateway',
      streaming: true,
      cancellation: true,
      usageEstimation: true,
      maxConcurrentCalls: 4,
      maxOutputTokens: 4096,
      persistence: 'process',
      threatAssumptions: [
        'the host capability resolver and signed ModelGateway handle broker are trusted',
      ],
    },
    now,
    resolveAccess: async (envelope, model) => {
      if (!envelope.capabilityHandleRef) return undefined;
      try {
        const claims = await broker.verifyModelAccessHandle(
          envelope.capabilityHandleRef,
          {
            workerKey: envelope.session?.keyFingerprint,
          },
        );
        if (
          claims.runRef?.uid !== envelope.run?.uid ||
          claims.attempt !== envelope.run?.attempt ||
          claims.modelClassRef.name !== model.modelClass ||
          claims.modelDigest !== model.digest
        ) {
          return undefined;
        }
        return {
          token: envelope.capabilityHandleRef,
          workerKey: envelope.session?.keyFingerprint,
          authorityFingerprint: claims.handleId,
        };
      } catch {
        return undefined;
      }
    },
  };
  return {
    broker,
    driver: createManagedModelGatewayAdapter(gateway, adapterOptions),
    records,
    token: handle.token,
  };
}

async function consume(
  stream: AsyncIterable<ManagedModelChunk>,
): Promise<ManagedModelChunk[]> {
  const chunks: ManagedModelChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe('managed ModelGateway adapter', () => {
  it('uses a real signed gateway handle and produces auditable, replayable calls', async () => {
    const { driver, records, token } = await fixture();
    const generate = request('model.generate', modelPayload(), token);

    expect(await driver.listModels(request('model.list', {}, token))).toEqual([MODEL]);
    expect(await driver.estimate(request('model.estimate', modelPayload(), token)))
      .toMatchObject({ inputTokens: 2, maximumOutputTokens: 128 });

    const chunks = await consume(driver.generate(generate));
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'started',
      'delta',
      'delta',
      'usage',
      'done',
    ]);
    expect(
      chunks.filter((chunk) => chunk.type === 'delta').map((chunk) => chunk.delta)
        .join(''),
    ).toBe('hello world');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      spec: {
        runRef: { uid: 'run-uid' },
        runAttempt: 2,
        modelDigest: MODEL.digest,
      },
      status: { phase: 'Completed' },
    });
    expect(JSON.stringify(records[0])).not.toContain(token);

    const replay = await consume(driver.generate(generate));
    expect(replay).toEqual(chunks);
    expect(records).toHaveLength(1);

    const started = chunks[0];
    expect(started.type).toBe('started');
    if (started.type !== 'started') return;
    expect(
      await driver.inspectUsage(request(
        'model.inspect-usage',
        { callHandle: started.callHandle },
        token,
      )),
    ).toMatchObject({
      phase: 'Completed',
      resourceUid: 'managed-call-uid',
      modelDigest: MODEL.digest,
    });
  });

  it('fails closed on authority, idempotency, resource, and fencing drift', async () => {
    const { broker, driver, token } = await fixture();
    const generate = request('model.generate', modelPayload(), token);
    const chunks = await consume(driver.generate(generate));
    const started = chunks[0];
    expect(started.type).toBe('started');
    if (started.type !== 'started') return;

    await expect(consume(driver.generate({
      ...generate,
      payload: modelPayload({ messages: [{ role: 'user', content: 'changed' }] }),
    }))).rejects.toMatchObject({ code: 'CONFLICT' });

    const foreign = await broker.issueModelAccessHandle({
      modelClassRef: MODEL_REF,
      modelDigest: MODEL.digest,
      runRef: {
        apiVersion: 'run.memeloop.io/v1alpha1',
        kind: 'AgentRun',
        name: 'run',
        uid: 'run-uid',
      },
      attempt: 2,
      workerKey: 'worker-key-1',
    });
    await expect(driver.inspectUsage(request(
      'model.inspect-usage',
      { callHandle: started.callHandle },
      foreign.token,
    ))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(driver.inspectUsage(request(
      'model.inspect-usage',
      { callHandle: started.callHandle },
      token,
      {
        resource: {
          ...generate.resource,
          uid: 'other-resource',
        },
      },
    ))).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await driver.inspectUsage(request(
      'model.inspect-usage',
      { callHandle: started.callHandle },
      token,
      { fencingEpoch: 3 },
    ));
    await expect(driver.inspectUsage(request(
      'model.inspect-usage',
      { callHandle: started.callHandle },
      token,
      { fencingEpoch: 2 },
    ))).rejects.toMatchObject({ code: 'STALE_EPOCH' });
  });

  it('rejects dishonest durability and cannot adopt process-local calls after restart', async () => {
    const { driver, token } = await fixture();
    const chunks = await consume(driver.generate(
      request('model.generate', modelPayload(), token),
    ));
    const started = chunks[0];
    expect(started.type).toBe('started');
    if (started.type !== 'started') return;

    const restarted = (await fixture()).driver;
    expect(
      await restarted.inspectUsage(request(
        'model.inspect-usage',
        { callHandle: started.callHandle },
        token,
      )),
    ).toBeUndefined();

    expect(() =>
      createManagedModelGatewayAdapter(
        createModelGateway({
          broker: (undefined as never),
          executor: executor(),
        }),
        {
          models: [MODEL],
          capabilities: {
            name: 'dishonest',
            streaming: true,
            cancellation: true,
            usageEstimation: true,
            maxConcurrentCalls: 1,
            maxOutputTokens: 1,
            persistence: 'external',
            threatAssumptions: ['none'],
          },
          resolveAccess: async () => undefined,
        },
      )
    ).toThrowError(/process lifecycle/);
  });

  it('cleans up when a stream consumer disconnects immediately after started', async () => {
    const { driver, token } = await fixture();
    const generate = request('model.generate', modelPayload(), token);
    const iterator = driver.generate(generate)[Symbol.asyncIterator]();
    const started = await iterator.next();
    expect(started.value).toMatchObject({ type: 'started' });
    await iterator.return?.();

    const replay = await consume(driver.generate(generate));
    expect(replay.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'CANCELLED' },
    });
  });

  it('emits and replays one terminal cancellation chunk', async () => {
    const { driver, token } = await fixture();
    const generate = request('model.generate', modelPayload(), token);
    const iterator = driver.generate(generate)[Symbol.asyncIterator]();
    const started = await iterator.next();
    expect(started.value).toMatchObject({ type: 'started' });
    if (started.value?.type !== 'started') return;

    expect(
      await driver.cancel(request(
        'model.cancel',
        { callHandle: started.value.callHandle },
        token,
      )),
    ).toMatchObject({ phase: 'Cancelled' });
    const remainder: ManagedModelChunk[] = [];
    for (
      let next = await iterator.next();
      !next.done;
      next = await iterator.next()
    ) {
      remainder.push(next.value);
    }
    expect(remainder).toEqual([{
      type: 'error',
      error: {
        code: 'CANCELLED',
        message: 'managed model generation was cancelled',
        retryable: false,
      },
    }]);

    const replay = await consume(driver.generate(generate));
    expect(replay.filter((chunk) => chunk.type === 'error')).toHaveLength(1);
  });
});
