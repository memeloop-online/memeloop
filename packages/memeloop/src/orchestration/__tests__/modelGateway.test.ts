import { describe, expect, it, vi } from 'vitest';

import type { PortableLlmRequest } from '../../llm/request.js';
import type { PortableLlmStreamPart } from '../../llm/response.js';
import type { ILLMProvider } from '../../types.js';
import {
  createGatewayMediatedLLMProvider,
  createModelGateway,
  type ModelGatewayCallRecord,
  type ModelGatewayExecutor,
  type ModelGatewayGenerateRequest,
} from '../drivers/modelGateway.js';
import type { ModelGenerateRequest, ModelStreamChunk } from '../drivers/modelProviderDriver.js';
import { createInMemoryModelAccessHandleBroker, type IssueModelAccessHandleRequest, type ModelAccessHandleBroker, type ModelHandleSigner } from '../security/modelAccessHandle.js';

const fakeSigner: ModelHandleSigner = {
  sign: async (payload) => new Uint8Array([...payload].reverse()),
  verify: async (payload, signature) => signature.length === payload.length && signature.every((byte, index) => byte === payload[payload.length - 1 - index]),
};

const AUDIENCE = 'gateway://test';
const MODEL_REF = { apiVersion: 'models.memeloop.io/v1alpha1', kind: 'ModelClass', name: 'chat-small' };

function makeBroker(): ModelAccessHandleBroker {
  return createInMemoryModelAccessHandleBroker({ signer: fakeSigner, audience: AUDIENCE });
}

interface FakeExecutorScript {
  chunks: ModelStreamChunk[];
  /** Resolve this many chunks per microtask drain; use a gate to hold the stream open. */
  holdUntilCancelled?: boolean;
}

function makeExecutor(script?: FakeExecutorScript): ModelGatewayExecutor & {
  calls: ModelGenerateRequest[];
  cancelled: string[];
  release: () => void;
} {
  const calls: ModelGenerateRequest[] = [];
  const cancelled: string[] = [];
  let releaseGate: (() => void) | undefined;
  return {
    calls,
    cancelled,
    release: () => releaseGate?.(),
    generate(request) {
      calls.push(request);
      const chunks = script?.chunks ?? [{ type: 'delta', delta: 'hi' } as ModelStreamChunk, { type: 'done' } as ModelStreamChunk];
      return (async function*() {
        for (const chunk of chunks) {
          if (script?.holdUntilCancelled) {
            await new Promise<void>((resolve) => {
              releaseGate = resolve;
            });
          }
          yield chunk;
        }
      })();
    },
    async cancel(callId: string) {
      cancelled.push(callId);
      releaseGate?.();
    },
  };
}

function makeRequest(overrides: Partial<ModelGatewayGenerateRequest> = {}): ModelGatewayGenerateRequest {
  return {
    callId: `call-${Math.random().toString(36).slice(2)}`,
    modelClassRef: MODEL_REF,
    messages: [{ role: 'user', content: 'secret prompt' }],
    accessHandle: '',
    ...overrides,
  };
}

async function issue(broker: ModelAccessHandleBroker, request: Partial<IssueModelAccessHandleRequest> = {}) {
  return broker.issueModelAccessHandle({ modelClassRef: MODEL_REF, ...request });
}

async function drain(stream: AsyncIterable<ModelStreamChunk>): Promise<ModelStreamChunk[]> {
  const chunks: ModelStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe('createModelGateway (plan §12)', () => {
  it('streams a verified call and records usage without secrets', async () => {
    const broker = makeBroker();
    const records: ModelGatewayCallRecord[] = [];
    const executor = makeExecutor({
      chunks: [
        { type: 'delta', delta: 'hel' },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
        { type: 'delta', delta: 'lo' },
        { type: 'done' },
      ],
    });
    const gateway = createModelGateway({
      broker,
      executor,
      recorder: {
        recordCall: (record) => {
          records.push(record);
        },
      },
      caller: 'node/test',
      costPerToken: 0.01,
    });
    const handle = await issue(broker, {
      runRef: {
        apiVersion: 'run.memeloop.io/v1alpha1',
        kind: 'AgentRun',
        name: 'run-1',
        uid: 'run-uid-1',
      },
      attempt: 1,
    });

    const chunks = await drain(gateway.generate(makeRequest({ accessHandle: handle.token })));

    expect(chunks.map((chunk) => chunk.type)).toEqual(['delta', 'delta', 'done']);
    expect(chunks.filter((chunk) => chunk.type === 'delta').map((chunk) => chunk.delta).join('')).toBe('hello');
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record.spec.modelClassRef.name).toBe('chat-small');
    expect(record.spec.runRef?.name).toBe('run-1');
    expect(record.spec.caller).toBe('node/test');
    expect(record.spec.accessHandleRef).toBe(handle.claims.handleId);
    expect(record.status).toMatchObject({ phase: 'Completed', usage: { inputTokens: 10, outputTokens: 5, cost: 0.15 } });
    // §12.4: no token, prompt, or output in the record.
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(handle.token);
    expect(serialized).not.toContain('secret prompt');
    expect(serialized).not.toContain('hello');
  });

  it('rejects malformed, forged, and wrong-audience handles before any token flows', async () => {
    const broker = makeBroker();
    const executor = makeExecutor();
    const gateway = createModelGateway({ broker, executor });

    await expect(drain(gateway.generate(makeRequest({ accessHandle: 'garbage' })))).rejects.toMatchObject({ code: 'INVALID' });
    await expect(drain(gateway.generate(makeRequest({ accessHandle: 'mlh1.Zm9yZ2Vk.Zm9yZ2Vk' })))).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const otherBroker = createInMemoryModelAccessHandleBroker({ signer: fakeSigner, audience: 'gateway://other' });
    const foreign = await issue(otherBroker);
    await expect(drain(gateway.generate(makeRequest({ accessHandle: foreign.token })))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(executor.calls).toHaveLength(0);
  });

  it('rejects expired handles', async () => {
    const broker = makeBroker();
    const gateway = createModelGateway({ broker, executor: makeExecutor() });
    const handle = await issue(broker, { ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(drain(gateway.generate(makeRequest({ accessHandle: handle.token })))).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('enforces proof-of-possession: key-bound handles require the presented key', async () => {
    const broker = makeBroker();
    const executor = makeExecutor();
    const gateway = createModelGateway({ broker, executor });
    const handle = await issue(broker, { workerKey: 'worker-key-fp' });

    await expect(drain(gateway.generate(makeRequest({ accessHandle: handle.token })))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(drain(gateway.generate(makeRequest({ accessHandle: handle.token, workerKey: 'other' })))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(drain(gateway.generate(makeRequest({ accessHandle: handle.token, workerKey: 'worker-key-fp' })))).resolves.toBeDefined();
    expect(executor.calls).toHaveLength(1);
  });

  it('enforces model and digest binding', async () => {
    const broker = makeBroker();
    const gateway = createModelGateway({ broker, executor: makeExecutor() });
    const handle = await issue(broker, { modelDigest: 'sha256:aaa' });

    await expect(drain(gateway.generate(makeRequest({
      accessHandle: handle.token,
      modelClassRef: { ...MODEL_REF, name: 'chat-large' },
    })))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(drain(gateway.generate(makeRequest({
      accessHandle: handle.token,
      modelClassRef: { ...MODEL_REF, apiVersion: 'models.example/v1' },
    })))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(drain(gateway.generate(makeRequest({
      accessHandle: handle.token,
      modelClassRef: { ...MODEL_REF, kind: 'Alias' },
    })))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(drain(gateway.generate(makeRequest({
      accessHandle: handle.token,
    })))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(drain(gateway.generate(makeRequest({ accessHandle: handle.token, modelDigest: 'sha256:bbb' })))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('enforces the concurrency budget per handle', async () => {
    const broker = makeBroker();
    const executor = makeExecutor({ holdUntilCancelled: true, chunks: [{ type: 'done' }] });
    const gateway = createModelGateway({ broker, executor });
    const handle = await issue(broker, { budget: { maxConcurrent: 1 } });

    const first = drain(gateway.generate(makeRequest({ accessHandle: handle.token, callId: 'call-a' })));
    await vi.waitFor(() => {
      expect(executor.calls).toHaveLength(1);
    });
    await expect(drain(gateway.generate(makeRequest({ accessHandle: handle.token, callId: 'call-b' })))).rejects.toMatchObject({
      code: 'EXHAUSTED',
      retryable: true,
    });
    executor.release();
    await first;
  });

  it('enforces the request-rate budget per handle', async () => {
    const broker = makeBroker();
    const gateway = createModelGateway({ broker, executor: makeExecutor(), maxRequestsPerSecond: 2 });
    const handle = await issue(broker);

    await drain(gateway.generate(makeRequest({ accessHandle: handle.token })));
    await drain(gateway.generate(makeRequest({ accessHandle: handle.token })));
    await expect(drain(gateway.generate(makeRequest({ accessHandle: handle.token })))).rejects.toMatchObject({
      code: 'EXHAUSTED',
      retryable: true,
    });
  });

  it('aborts the stream when the output-token budget is exceeded mid-call', async () => {
    const broker = makeBroker();
    const records: ModelGatewayCallRecord[] = [];
    const executor = makeExecutor({
      chunks: [
        { type: 'delta', delta: 'a' },
        { type: 'usage', usage: { inputTokens: 3, outputTokens: 50 } },
        { type: 'delta', delta: 'b' },
        { type: 'done' },
      ],
    });
    const gateway = createModelGateway({
      broker,
      executor,
      recorder: {
        recordCall: (record) => {
          records.push(record);
        },
      },
    });
    const handle = await issue(broker, { budget: { maxOutputTokens: 10 } });

    const chunks = await drain(gateway.generate(makeRequest({ accessHandle: handle.token, callId: 'call-capped' })));

    expect(chunks.map((chunk) => chunk.type)).toEqual(['delta', 'error']);
    expect(chunks[1].error?.code).toBe('EXHAUSTED');
    expect(executor.cancelled).toEqual(['call-capped']);
    expect(records[0].status.phase).toBe('Failed');
    expect(records[0].status.error?.code).toBe('EXHAUSTED');
  });

  it('enforces the cost budget with the configured per-token price', async () => {
    const broker = makeBroker();
    const executor = makeExecutor({ chunks: [{ type: 'usage', usage: { inputTokens: 100, outputTokens: 100 } }, { type: 'done' }] });
    const gateway = createModelGateway({ broker, executor, costPerToken: 0.01 });
    const handle = await issue(broker, { budget: { maxCost: 1 } });

    const chunks = await drain(gateway.generate(makeRequest({ accessHandle: handle.token })));
    expect(chunks[0].type).toBe('error');
    expect((chunks[0] as { error?: { code: string } }).error?.code).toBe('EXHAUSTED');
  });

  it('clamps maxOutputTokens to the handle budget', async () => {
    const broker = makeBroker();
    const executor = makeExecutor();
    const gateway = createModelGateway({ broker, executor });
    const handle = await issue(broker, { budget: { maxOutputTokens: 20 } });

    await drain(gateway.generate(makeRequest({ accessHandle: handle.token, maxOutputTokens: 1000 })));
    expect(executor.calls[0].maxOutputTokens).toBe(20);
  });

  it('cancel() aborts the in-flight call and records Cancelled', async () => {
    const broker = makeBroker();
    const records: ModelGatewayCallRecord[] = [];
    const executor = makeExecutor({
      holdUntilCancelled: true,
      chunks: [{ type: 'error', error: { code: 'CANCELLED', message: 'cancelled', retryable: false } }],
    });
    const gateway = createModelGateway({
      broker,
      executor,
      recorder: {
        recordCall: (record) => {
          records.push(record);
        },
      },
    });
    const handle = await issue(broker);

    const pending = drain(gateway.generate(makeRequest({ accessHandle: handle.token, callId: 'call-cancel' })));
    await vi.waitFor(() => {
      expect(executor.calls).toHaveLength(1);
    });
    await gateway.cancel('call-cancel');
    await pending;

    expect(executor.cancelled).toEqual(['call-cancel']);
    expect(records[0].status.phase).toBe('Cancelled');
  });

  it('revokes access on Run cancellation: in-flight aborted, later calls rejected (§12.1/§21.3)', async () => {
    const broker = makeBroker();
    const executor = makeExecutor({ holdUntilCancelled: true, chunks: [{ type: 'done' }] });
    const gateway = createModelGateway({ broker, executor });
    const runRef = {
      apiVersion: 'run.memeloop.io/v1alpha1',
      kind: 'AgentRun',
      name: 'run-x',
      uid: 'run-x-uid',
    };
    const handle = await issue(broker, { runRef, attempt: 1 });

    const pending = drain(gateway.generate(makeRequest({ accessHandle: handle.token, callId: 'call-revoke' })));
    await vi.waitFor(() => {
      expect(executor.calls).toHaveLength(1);
    });
    gateway.revokeRunHandles('run-x');
    await pending;

    expect(executor.cancelled).toEqual(['call-revoke']);
    await expect(drain(gateway.generate(makeRequest({ accessHandle: handle.token })))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it("revokeHandle aborts only the matching handle's in-flight calls", async () => {
    const broker = makeBroker();
    const executor = makeExecutor({ holdUntilCancelled: true, chunks: [{ type: 'done' }] });
    const gateway = createModelGateway({ broker, executor });
    const first = await issue(broker);
    const second = await issue(broker);

    const pending = drain(gateway.generate(makeRequest({ accessHandle: first.token, callId: 'call-1' })));
    await vi.waitFor(() => {
      expect(executor.calls).toHaveLength(1);
    });
    gateway.revokeHandle(first.claims.handleId);
    await pending;

    expect(executor.cancelled).toEqual(['call-1']);
    await expect(drain(gateway.generate(makeRequest({ accessHandle: first.token })))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The second handle is unaffected.
    const stream = gateway.generate(makeRequest({ accessHandle: second.token, callId: 'call-2' }));
    const pendingSecond = drain(stream);
    await vi.waitFor(() => {
      expect(executor.calls).toHaveLength(2);
    });
    executor.release();
    await pendingSecond;
  });

  it('recorder failures never break calls (reported via onError)', async () => {
    const broker = makeBroker();
    const onError = vi.fn();
    const gateway = createModelGateway({
      broker,
      executor: makeExecutor(),
      recorder: {
        recordCall: () => {
          throw new Error('store down');
        },
      },
      onError,
    });
    const handle = await issue(broker);

    const chunks = await drain(gateway.generate(makeRequest({ accessHandle: handle.token })));
    expect(chunks.at(-1)?.type).toBe('done');
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('createGatewayMediatedLLMProvider (24.35 loop routing)', () => {
  function isAsyncParts(value: unknown): value is AsyncIterable<PortableLlmStreamPart> {
    return value !== null && typeof value === 'object' && Symbol.asyncIterator in value;
  }

  async function chat(
    provider: ILLMProvider,
    request: Pick<PortableLlmRequest, 'conversationId' | 'messages'>,
  ): Promise<string> {
    let text = '';
    const modelId = provider.modelId ?? MODEL_REF.name;
    const response = await provider.chat({
      providerId: provider.name,
      logicalModelId: modelId,
      wireModelId: modelId,
      apiMode: 'chat-completions',
      ...request,
    });
    if (typeof response === 'string') return response;
    if (!isAsyncParts(response)) {
      return response.type === 'text-delta' ? response.text : '';
    }
    for await (const chunk of response) {
      if (chunk.type === 'text-delta') text += chunk.text;
    }
    return text;
  }

  it('issues a per-call handle, streams deltas, and revokes the handle at call end', async () => {
    const broker = makeBroker();
    const records: ModelGatewayCallRecord[] = [];
    const executor = makeExecutor({ chunks: [{ type: 'delta', delta: 'he' }, { type: 'delta', delta: 'y' }, { type: 'done' }] });
    const gateway = createModelGateway({
      broker,
      executor,
      recorder: {
        recordCall: (record) => {
          records.push(record);
        },
      },
    });
    const provider = createGatewayMediatedLLMProvider({
      gateway,
      broker,
      modelClassRef: MODEL_REF,
      name: 'mediated',
    });

    expect(provider.name).toBe('mediated');
    const text = await chat(provider, { conversationId: 'conv-1', messages: [{ role: 'user', content: 'hi' }] });
    expect(text).toBe('hey');

    // The executor saw exactly one gateway-verified call with the messages.
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0].messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(executor.calls[0].callId).toBe('chat-conv-1-1');
    // Audited and revoked (§12.1 step 6): the issued handle no longer verifies.
    expect(records).toHaveLength(1);
    const handleId = records[0].spec.accessHandleRef!;
    // A second chat issues a fresh handle (revoked ones are not reused).
    await chat(provider, { conversationId: 'conv-1', messages: [] });
    expect(records).toHaveLength(2);
    expect(records[1].spec.accessHandleRef).not.toBe(handleId);
  });

  it('derives the Run binding per request and stamps budget into handles', async () => {
    const broker = makeBroker();
    const records: ModelGatewayCallRecord[] = [];
    const gateway = createModelGateway({
      broker,
      executor: makeExecutor(),
      recorder: {
        recordCall: (record) => {
          records.push(record);
        },
      },
    });
    const provider = createGatewayMediatedLLMProvider({
      gateway,
      broker,
      modelClassRef: MODEL_REF,
      budget: { maxConcurrent: 4 },
      policyDigest: `sha256:${'a'.repeat(64)}`,
      attempt: 2,
      runRefForRequest: (request) => {
        const conversationId = (request as { conversationId?: string }).conversationId ?? '';
        const match = /^looprun:[^:]+:(.+)$/.exec(conversationId);
        return match
          ? {
            apiVersion: 'run.memeloop.io/v1alpha1',
            kind: 'AgentRun',
            name: match[1],
            uid: `uid:${match[1]}`,
          }
          : undefined;
      },
    });

    await chat(provider, { conversationId: 'looprun:default:run-42', messages: [] });
    expect(records[0].spec.runRef).toMatchObject({ kind: 'AgentRun', name: 'run-42' });
    expect(records[0].spec.policyDigest).toBe(`sha256:${'a'.repeat(64)}`);
    expect(records[0].spec.runAttempt).toBe(2);
    // Interactive chats without a workload identity carry no runRef.
    await chat(provider, { conversationId: 'chat-ui-1', messages: [] });
    expect(records[1].spec.runRef).toBeUndefined();
  });

  it('propagates gateway budget violations as OrchestrationError', async () => {
    const broker = makeBroker();
    const executor = makeExecutor({ chunks: [{ type: 'usage', usage: { inputTokens: 0, outputTokens: 50 } }, { type: 'done' }] });
    const gateway = createModelGateway({ broker, executor });
    const provider = createGatewayMediatedLLMProvider({
      gateway,
      broker,
      modelClassRef: MODEL_REF,
      budget: { maxOutputTokens: 10 },
    });

    await expect(chat(provider, { conversationId: 'conv-x', messages: [] })).rejects.toMatchObject({ code: 'EXHAUSTED' });
  });

  it('rejects calls when the broker rejects issuance (no silent direct path)', async () => {
    const broker = makeBroker();
    const gateway = createModelGateway({ broker, executor: makeExecutor() });
    const provider = createGatewayMediatedLLMProvider({
      gateway,
      broker,
      modelClassRef: MODEL_REF,
      handleTtlMs: 0, // broker rejects non-positive TTL
    });

    await expect(chat(provider, { conversationId: 'conv-y', messages: [] })).rejects.toMatchObject({ code: 'INVALID' });
  });
});
