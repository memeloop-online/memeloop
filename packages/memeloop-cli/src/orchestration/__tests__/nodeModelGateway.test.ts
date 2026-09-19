import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  AUDIT_RECORD_API_VERSION,
  AUDIT_RECORD_KIND,
  type AuditRecordResource,
  DRIVER_REQUEST_API_VERSION,
  type DriverRequestEnvelope,
  type ManagedModelRequest,
  type ModelCallRecordResource,
  OrchestrationError,
  type PortableLlmRequest,
} from 'memeloop';

import { createNodeRuntime } from '../../runtime/nodeRuntime.js';
import { createControlStoreModelCallRecorder, createHmacModelHandleSigner, loadOrCreateModelBrokerKey, MODEL_AUDIT_OBSERVER_WARNING_CODE } from '../nodeModelGateway.js';

function mkLLMProvider() {
  return {
    name: 'gw-test',
    modelId: 'gw-model',
    model: 'gw-model',
    chat: async function*() {
      yield { type: 'text-delta' as const, id: 'gateway-delta-1', text: 'hello ' };
      yield { type: 'text-delta' as const, id: 'gateway-delta-2', text: 'world' };
      yield { type: 'finish' as const, finishReason: 'stop' };
    },
  };
}

function llmRequest(
  providerId: string,
  logicalModelId: string,
  apiMode: PortableLlmRequest['apiMode'],
  conversationId: string,
): PortableLlmRequest {
  return {
    providerId,
    logicalModelId,
    wireModelId: logicalModelId,
    apiMode,
    conversationId,
    messages: [{ role: 'user', content: 'test' }],
    stream: true,
  };
}

const MODEL_REF = { apiVersion: 'models.memeloop.io/v1alpha1', kind: 'ModelClass', name: 'gw-test-gw-model' };
const MODEL_DIGEST = `sha256:${'d'.repeat(64)}`;

describe('createHmacModelHandleSigner', () => {
  it('signs and verifies, rejecting tampering', async () => {
    const signer = createHmacModelHandleSigner(new Uint8Array(32).fill(7));
    const payload = new TextEncoder().encode('claims');
    const signature = await signer.sign(payload);
    expect(await signer.verify(payload, signature)).toBe(true);
    expect(await signer.verify(new TextEncoder().encode('other'), signature)).toBe(false);
    const tampered = new Uint8Array(signature);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(await signer.verify(payload, tampered)).toBe(false);
  });
});

describe('loadOrCreateModelBrokerKey', () => {
  it('persists a 0600 host-local key and reloads it', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-broker-key-'));
    try {
      const first = loadOrCreateModelBrokerKey(dataDir);
      const second = loadOrCreateModelBrokerKey(dataDir);
      expect(first.length).toBeGreaterThanOrEqual(32);
      expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
      const stat = fs.statSync(path.join(dataDir, 'model-broker.key'));
      expect(stat.mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('fails closed on a corrupt or unreadable existing key', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-broker-key-invalid-'));
    const keyPath = path.join(dataDir, 'model-broker.key');
    try {
      fs.writeFileSync(keyPath, Buffer.alloc(31), { mode: 0o600 });
      expect(() => loadOrCreateModelBrokerKey(dataDir)).toThrow(/exactly 32 bytes/);
      expect(fs.readFileSync(keyPath)).toHaveLength(31);

      fs.rmSync(keyPath);
      fs.mkdirSync(keyPath);
      expect(() => loadOrCreateModelBrokerKey(dataDir)).toThrow(/unreadable/);
      expect(fs.statSync(keyPath).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('re-reads the key that wins a concurrent first-write race', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-broker-key-race-'));
    const keyPath = path.join(dataDir, 'model-broker.key');
    const winner = Buffer.alloc(32, 9);
    const writeFile = fs.writeFileSync.bind(fs);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      writeFile(keyPath, winner, { mode: 0o600 });
      throw Object.assign(new Error('concurrent create'), { code: 'EEXIST' });
    });
    try {
      expect(Buffer.from(loadOrCreateModelBrokerKey(dataDir))).toEqual(winner);
      expect(fs.readFileSync(keyPath)).toEqual(winner);
    } finally {
      writeSpy.mockRestore();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('createControlStoreModelCallRecorder', () => {
  const actor = { id: 'controller/model-call-recorder-test', kind: 'controller' } as const;
  const record = {
    callId: 'audit-call',
    spec: {
      modelClassRef: MODEL_REF,
      accessHandleRef: 'handle-1',
    },
    status: { phase: 'Completed' as const },
  };

  it('reports unexpected persistence failures without breaking model calls', async () => {
    const persistenceError = new Error('control store unavailable');
    const onError = vi.fn();
    const recorder = createControlStoreModelCallRecorder(
      { create: vi.fn().mockRejectedValue(persistenceError) } as never,
      actor,
      undefined,
      onError,
    );

    await expect(recorder.recordCall(record)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(persistenceError);
  });

  it('emits an observable warning when no audit error observer is configured', async () => {
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const persistenceError = new Error('control store unavailable');
    const recorder = createControlStoreModelCallRecorder(
      { create: vi.fn().mockRejectedValue(persistenceError) } as never,
      actor,
    );

    try {
      await expect(recorder.recordCall(record)).resolves.toBeUndefined();
      expect(emitWarning).toHaveBeenCalledWith(
        expect.stringContaining('Model call audit observer failed (Error): control store unavailable'),
        { code: MODEL_AUDIT_OBSERVER_WARNING_CODE },
      );
    } finally {
      emitWarning.mockRestore();
    }
  });

  it('isolates a failing audit error observer without recursive callbacks', async () => {
    const onError = vi.fn().mockRejectedValue(new Error('audit logger unavailable'));
    const onObserverError = vi.fn();
    const persistenceError = new Error('control store unavailable');
    const recorder = createControlStoreModelCallRecorder(
      { create: vi.fn().mockRejectedValue(persistenceError) } as never,
      actor,
      undefined,
      onError,
      onObserverError,
    );

    await expect(recorder.recordCall(record)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    expect(onObserverError).toHaveBeenCalledWith(expect.objectContaining({ message: 'audit logger unavailable' }));
    expect(onObserverError).toHaveBeenCalledOnce();
  });

  it('keeps duplicate idempotent retries quiet', async () => {
    const onError = vi.fn();
    const recorder = createControlStoreModelCallRecorder(
      {
        create: vi.fn().mockRejectedValue(
          new OrchestrationError({
            code: 'CONFLICT',
            message: 'resource already exists',
            retryable: false,
          }),
        ),
      } as never,
      actor,
      undefined,
      onError,
    );

    await expect(recorder.recordCall(record)).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('nodeRuntime model gateway (plan §12 / 24.65)', () => {
  it('issues handles, serves verified calls, and audits ModelCallRecords in the ControlStore', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-gateway-'));
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: mkLLMProvider() as never,
      includeVscodeCli: false,
      localNodeId: 'node-gw',
      config: { providers: [] },
      modelGateway: {
        managedModels: [{
          modelClass: MODEL_REF.name,
          provider: 'gw-test',
          model: 'gw-model',
          digest: MODEL_DIGEST,
          modalities: ['text'],
          contextWindow: 32_768,
          residency: ['local'],
          mode: 'broker',
          maxInputClassification: 'confidential',
          outputClassification: 'confidential',
          inputTrust: 'sanitized',
          outputTrust: 'untrusted',
        }],
      },
    });
    try {
      expect(runtime.modelGateway).toBeDefined();
      expect(runtime.modelGateway!.managedDriver).toBeDefined();

      const handle = await runtime.modelGateway!.issueHandle({
        modelClassRef: MODEL_REF,
        runRef: {
          apiVersion: 'run.memeloop.io/v1alpha1',
          kind: 'AgentRun',
          name: 'run-gw',
          uid: 'run-gw-uid',
        },
        attempt: 1,
        budget: { maxConcurrent: 2 },
      });

      const chunks: string[] = [];
      for await (
        const chunk of runtime.modelGateway!.gateway.generate({
          callId: 'call-gw-1',
          modelClassRef: MODEL_REF,
          messages: [{ role: 'user', content: 'hi' }],
          accessHandle: handle.token,
        })
      ) {
        if (chunk.type === 'delta' && chunk.delta) chunks.push(chunk.delta);
      }
      expect(chunks.join('')).toBe('hello world');

      // Audit: exactly one ModelCallRecord with the terminal status.
      const records = await runtime.controlStore!.list<ModelCallRecordResource['spec']>({
        apiVersion: 'models.memeloop.io/v1alpha1',
        kind: 'ModelCallRecord',
      });
      expect(records.items).toHaveLength(1);
      const record = records.items[0];
      expect(record.spec).toMatchObject({
        caller: 'node/node-gw',
        accessHandleRef: handle.claims.handleId,
      });
      expect(record.status).toMatchObject({ phase: 'Completed' });

      // A forged token is rejected before any provider call.
      await expect(async () => {
        for await (
          const _chunk of runtime.modelGateway!.gateway.generate({
            callId: 'call-gw-2',
            modelClassRef: MODEL_REF,
            messages: [{ role: 'user', content: 'hi' }],
            accessHandle: 'mlh1.Zm9yZ2Vk.Zm9yZ2Vk',
          })
        ) { /* drain */ }
      }).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const after = await runtime.controlStore!.list<ModelCallRecordResource['spec']>({ apiVersion: 'models.memeloop.io/v1alpha1', kind: 'ModelCallRecord' });
      expect(after.items).toHaveLength(1);

      // The complete management protocol delegates through the same real
      // signed gateway and persists the same auditable call record.
      const managedHandle = await runtime.modelGateway!.issueHandle({
        modelClassRef: MODEL_REF,
        modelDigest: MODEL_DIGEST,
        runRef: {
          apiVersion: 'run.memeloop.io/v1alpha1',
          kind: 'AgentRun',
          name: 'run-managed',
          uid: 'run-managed-uid',
        },
        attempt: 3,
        workerKey: 'worker-key-managed',
      });
      const managedPayload: ManagedModelRequest = {
        modelClass: MODEL_REF.name,
        modelDigest: MODEL_DIGEST,
        messages: [{ role: 'user', content: 'managed hi' }],
        maxOutputTokens: 32,
        inputClassification: 'confidential',
        residency: 'local',
      };
      const managedRequest: DriverRequestEnvelope<ManagedModelRequest> = {
        apiVersion: DRIVER_REQUEST_API_VERSION,
        method: 'model.generate',
        resource: {
          apiVersion: 'models.memeloop.io/v1alpha1',
          kind: 'ModelCallRecord',
          name: 'managed-call',
          uid: 'managed-call-uid',
          generation: 1,
        },
        run: { uid: 'run-managed-uid', attempt: 3 },
        fencingEpoch: 1,
        requestId: 'managed-generate-1',
        idempotencyKey: 'managed-generate-1',
        deadline: new Date(Date.now() + 60_000).toISOString(),
        actor: { id: 'controller/test', kind: 'controller' },
        session: {
          id: 'worker-session-managed',
          keyFingerprint: 'worker-key-managed',
        },
        capabilityHandleRef: managedHandle.token,
        trace: { traceId: 'managed-trace', spanId: 'managed-span' },
        payloadSchemaDigest: `sha256:${'e'.repeat(64)}`,
        payload: managedPayload,
      };
      const managedChunks = [];
      for await (
        const chunk of runtime.modelGateway!.managedDriver!.generate(
          managedRequest,
        )
      ) {
        managedChunks.push(chunk);
      }
      expect(managedChunks.map((chunk) => chunk.type)).toEqual([
        'started',
        'delta',
        'delta',
        'usage',
        'done',
      ]);
      const managedRecords = await runtime.controlStore!.list<ModelCallRecordResource['spec']>({
        apiVersion: 'models.memeloop.io/v1alpha1',
        kind: 'ModelCallRecord',
      });
      expect(managedRecords.items).toHaveLength(2);
      expect(
        managedRecords.items.find(
          (item) => item.spec.runRef?.uid === 'run-managed-uid',
        )?.spec,
      ).toMatchObject({
        modelDigest: MODEL_DIGEST,
        runAttempt: 3,
      });
      const auditRecords = await runtime.controlStore!.list<AuditRecordResource['spec']>({
        apiVersion: AUDIT_RECORD_API_VERSION,
        kind: AUDIT_RECORD_KIND,
      });
      expect(auditRecords.items).toHaveLength(2);
      expect(auditRecords.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          spec: expect.objectContaining({
            recordKind: 'audit',
            effect: 'execute',
            data: {
              kind: 'audit',
              action: 'model.generate',
              outcome: 'success',
            },
            attributes: expect.objectContaining({
              phase: 'Completed',
            }),
          }),
        }),
      ]));
      expect(JSON.stringify(auditRecords.items)).not.toContain('managed hi');

      // Revocation on Run completion closes access immediately (§12.1 step 6).
      runtime.modelGateway!.gateway.revokeRunHandles('run-gw');
      await expect(async () => {
        for await (
          const _chunk of runtime.modelGateway!.gateway.generate({
            callId: 'call-gw-3',
            modelClassRef: MODEL_REF,
            messages: [{ role: 'user', content: 'hi' }],
            accessHandle: handle.token,
          })
        ) { /* drain */ }
      }).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await runtime.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('routes every configured model through its own class, wire API, and generation defaults', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-gateway-multi-model-'));
    const originalFetch = globalThis.fetch;
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-openai-key';
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      );
      const bodyText = typeof init.body === 'string'
        ? init.body
        : new TextDecoder().decode(init.body as ArrayBufferView<ArrayBuffer>);
      requests.push({ path: url.pathname, body: JSON.parse(bodyText) as Record<string, unknown> });
      return new Response(
        JSON.stringify({ error: { message: 'intercepted', type: 'invalid_request_error' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    };
    const runtime = await createNodeRuntime({
      dataDir,
      includeVscodeCli: false,
      localNodeId: 'node-gw-multi-model',
      config: {
        providers: [{
          providerId: 'cpa',
          providerType: 'openai-compatible',
          baseUrl: 'https://cpa.example.test/v1',
          models: [
            {
              modelId: 'westlake/deepseek',
              wireModelId: 'westlake/deepseek',
              apiMode: 'chat-completions',
              requestDefaults: { maxOutputTokens: 32_768 },
            },
            {
              modelId: 'kimi-k3-256k',
              wireModelId: 'kimi-k3-256k',
              apiMode: 'chat-completions',
              requestDefaults: { maxOutputTokens: 131_072, topP: 0.95 },
            },
            {
              modelId: 'gpt-5.6-luna',
              wireModelId: 'gpt-5.6-luna',
              apiMode: 'responses',
              requestDefaults: { maxOutputTokens: 128_000 },
            },
            {
              modelId: 'gpt-5.6-sol',
              wireModelId: 'gpt-5.6-sol',
              apiMode: 'responses',
              requestDefaults: { maxOutputTokens: 128_000 },
            },
          ],
          catalogProvider: {
            id: 'cpa',
            name: 'CPA',
            env: [],
            models: [
              {
                id: 'westlake/deepseek',
                name: 'DeepSeek V4 Flash',
                attachment: false,
                reasoning: true,
                toolCall: true,
                modalities: { input: ['text'], output: ['text'] },
                limit: { context: 1_000_000, output: 32_768 },
              },
              {
                id: 'kimi-k3-256k',
                name: 'Kimi K3 256K',
                attachment: false,
                reasoning: true,
                toolCall: true,
                modalities: { input: ['text', 'image'], output: ['text'] },
                limit: { context: 262_144, output: 131_072 },
              },
              {
                id: 'gpt-5.6-luna',
                name: 'GPT-5.6 Luna',
                attachment: false,
                reasoning: true,
                toolCall: true,
                modalities: { input: ['text', 'image'], output: ['text'] },
                limit: { context: 1_050_000, output: 128_000 },
              },
              {
                id: 'gpt-5.6-sol',
                name: 'GPT-5.6 Sol',
                attachment: false,
                reasoning: true,
                toolCall: true,
                modalities: { input: ['text', 'image'], output: ['text'] },
                limit: { context: 1_050_000, output: 128_000 },
              },
            ],
          },
        }],
      },
    });
    try {
      await runtime.modelEndpointRegistrar?.refresh();
      const classes = await runtime.controlStore!.list({
        apiVersion: 'models.memeloop.io/v1alpha1',
        kind: 'ModelClass',
      });
      expect(classes.items.map(item => ({ name: item.metadata.name, spec: item.spec })))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            name: 'cpa-westlake-deepseek',
            spec: expect.objectContaining({
              provider: 'cpa',
              model: 'westlake/deepseek',
              contextWindow: 1_000_000,
              maxOutputTokens: 32_768,
              capabilities: { toolUse: true },
              modalities: ['text'],
            }),
          }),
          expect.objectContaining({
            name: 'cpa-kimi-k3-256k',
            spec: expect.objectContaining({
              provider: 'cpa',
              model: 'kimi-k3-256k',
              contextWindow: 262_144,
              maxOutputTokens: 131_072,
              modalities: ['text', 'vision'],
            }),
          }),
          expect.objectContaining({
            name: 'cpa-gpt-5.6-luna',
            spec: expect.objectContaining({ provider: 'cpa', model: 'gpt-5.6-luna' }),
          }),
          expect.objectContaining({
            name: 'cpa-gpt-5.6-sol',
            spec: expect.objectContaining({ provider: 'cpa', model: 'gpt-5.6-sol' }),
          }),
        ]));

      for (
        const model of [
          'westlake/deepseek',
          'kimi-k3-256k',
          'gpt-5.6-luna',
          'gpt-5.6-sol',
        ]
      ) {
        await expect(async () => {
          const stream = runtime.context.llmProvider.chat(llmRequest(
            'cpa',
            model,
            model.startsWith('gpt-5.6-') ? 'responses' : 'chat-completions',
            `multi-${model}`,
          )) as AsyncIterable<unknown>;
          for await (const _ of stream) {
            // The intercepted response fails before text is yielded.
          }
        }).rejects.toBeDefined();
      }

      expect(requests.map(request => [request.path, request.body.model])).toEqual([
        ['/v1/chat/completions', 'westlake/deepseek'],
        ['/v1/chat/completions', 'kimi-k3-256k'],
        ['/v1/responses', 'gpt-5.6-luna'],
        ['/v1/responses', 'gpt-5.6-sol'],
      ]);
      expect(requests[0]?.body.max_tokens).toBe(32_768);
      expect(requests[1]?.body).toMatchObject({ max_tokens: 131_072, top_p: 0.95 });
      expect(requests[2]?.body.max_output_tokens).toBe(128_000);
      expect(requests[3]?.body.max_output_tokens).toBe(128_000);

      await expect(async () => {
        const stream = runtime.context.llmProvider.chat({
          ...llmRequest('cpa', 'not-advertised', 'chat-completions', 'invalid-model'),
          messages: [],
        }) as AsyncIterable<unknown>;
        for await (const _ of stream) {
          // consume
        }
      }).rejects.toThrow('Model not found: cpa/not-advertised');
      expect(requests).toHaveLength(4);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
      await runtime.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('is disabled via modelGateway.enabled=false', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-gateway-off-'));
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: mkLLMProvider() as never,
      includeVscodeCli: false,
      localNodeId: 'node-gw-off',
      config: { providers: [] },
      modelGateway: { enabled: false },
    });
    try {
      expect(runtime.modelGateway).toBeUndefined();
    } finally {
      await runtime.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('routes loop model calls through the gateway by default (24.35)', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-gateway-loops-'));
    const directProvider = mkLLMProvider();
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: directProvider as never,
      includeVscodeCli: false,
      localNodeId: 'node-gw-loops',
      config: { providers: [] },
    });
    try {
      // The loop-facing provider is the gateway-mediated adapter, not the raw one.
      expect(runtime.context.llmProvider).not.toBe(directProvider);
      expect(runtime.context.llmProvider.name).toBe('gw-test');

      let text = '';
      const stream = runtime.context.llmProvider.chat({
        ...llmRequest('gw-test', 'gw-model', 'chat-completions', 'conv-loops'),
        messages: [{ role: 'user', content: 'hi' }],
      }) as AsyncIterable<unknown>;
      for await (const chunk of stream) {
        if (typeof chunk === 'string') text += chunk;
        if (
          chunk !== null && typeof chunk === 'object' &&
          'type' in chunk && chunk.type === 'text-delta' &&
          'text' in chunk && typeof chunk.text === 'string'
        ) text += chunk.text;
      }
      // Same text as the direct path (deltas survive the gateway round-trip).
      expect(text).toBe('hello world');

      // The call was audited: a ModelCallRecord exists for the loop model class.
      const records = await runtime.controlStore!.list<ModelCallRecordResource['spec']>({
        apiVersion: 'models.memeloop.io/v1alpha1',
        kind: 'ModelCallRecord',
      });
      expect(records.items.length).toBeGreaterThanOrEqual(1);
      expect(records.items[0].spec).toMatchObject({
        modelClassRef: { name: 'gw-test-gw-model' },
      });
      expect(records.items[0].status).toMatchObject({ phase: 'Completed' });
    } finally {
      await runtime.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('uses explicit direct-local execution while retaining the canonical route', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-gateway-direct-'));
    const directProvider = mkLLMProvider();
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: directProvider as never,
      includeVscodeCli: false,
      localNodeId: 'node-gw-direct',
      config: { providers: [] },
      modelGateway: { routeLoops: false },
    });
    try {
      expect(runtime.modelGateway).toBeDefined();
      expect(runtime.context.llmProvider).toBe(directProvider);
      const route = runtime.context.modelProviderRegistry!.resolve('gw-test', 'gw-model');
      expect(route).toMatchObject({
        provider: directProvider,
        providerId: 'gw-test',
        modelId: 'gw-model',
        wireModelId: 'gw-model',
        apiMode: 'chat-completions',
      });
    } finally {
      await runtime.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);
});
