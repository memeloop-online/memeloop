import { safeErrorMessageFromUnknown } from '../../safeError.js';
import { OrchestrationError } from '../errors.js';
import type { DataClassification } from '../resources.js';

import type { DriverConformanceSuite } from './driverConformance.js';
import { canonicalDriverValue, type DriverRequestEnvelope } from './driverRequest.js';
import {
  allocateManagementHandle,
  assertManagementOnlyFields,
  canonicalManagementRequest,
  createManagementDriverContext,
  managementConformanceSuite,
  managementInvalid as invalid,
  requireManagementString,
} from './managementDriverFramework.js';
import { classificationRank } from './modelProviderDriver.js';

const SHA256 = /^sha256:[a-f0-9]{64}$/;

export interface ManagedModelDescriptor {
  modelClass: string;
  provider: string;
  model: string;
  digest: string;
  modalities: Array<'text' | 'image' | 'audio' | 'video' | 'embedding'>;
  contextWindow: number;
  residency: string[];
  mode: 'local' | 'broker';
  maxInputClassification: DataClassification;
  outputClassification: DataClassification;
  inputTrust: 'untrusted' | 'sanitized' | 'trusted';
  outputTrust: 'untrusted' | 'sanitized' | 'trusted';
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
}

export interface ModelManagementCapabilities {
  name: string;
  streaming: boolean;
  cancellation: boolean;
  usageEstimation: boolean;
  maxConcurrentCalls: number;
  maxOutputTokens: number;
  persistence: 'process' | 'host' | 'external';
  threatAssumptions: string[];
}

export interface ManagedModelRequest {
  modelClass: string;
  modelDigest: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
  }>;
  maxOutputTokens: number;
  temperature?: number;
  inputClassification: DataClassification;
  residency?: string;
}

export interface ManagedModelEstimate {
  inputTokens: number;
  maximumOutputTokens: number;
  maximumCost: number;
}

export interface ManagedModelUsage {
  callHandle: string;
  resourceUid: string;
  modelClass: string;
  modelDigest: string;
  phase: 'Running' | 'Completed' | 'Cancelled' | 'Failed';
  inputTokens: number;
  outputTokens: number;
  cost: number;
  fencingEpoch: number;
  updatedAt: string;
}

export type ManagedModelChunk =
  | { type: 'started'; callHandle: string }
  | { type: 'delta'; delta: string }
  | {
    type: 'usage';
    inputTokens: number;
    outputTokens: number;
    cost: number;
  }
  | {
    type: 'error';
    error: { code: string; message: string; retryable: boolean };
  }
  | { type: 'done' };

/** Complete §10.4 provider lifecycle; the capability is in the host envelope. */
export interface ModelManagementDriver {
  getCapabilities(): Promise<ModelManagementCapabilities>;
  listModels(
    request: DriverRequestEnvelope<Record<string, never>>,
  ): Promise<ManagedModelDescriptor[]>;
  estimate(
    request: DriverRequestEnvelope<ManagedModelRequest>,
  ): Promise<ManagedModelEstimate>;
  generate(
    request: DriverRequestEnvelope<ManagedModelRequest>,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<ManagedModelChunk>;
  cancel(
    request: DriverRequestEnvelope<{ callHandle: string }>,
  ): Promise<ManagedModelUsage>;
  inspectUsage(
    request: DriverRequestEnvelope<{ callHandle: string }>,
  ): Promise<ManagedModelUsage | undefined>;
  getHealth(
    request: DriverRequestEnvelope<Record<string, never>>,
  ): Promise<{ healthy: boolean; checkedAt: string; detail?: string }>;
}

interface ModelCallRecord {
  usage: ManagedModelUsage;
  chunks: ManagedModelChunk[];
  inputFingerprint: string;
  capabilityHandleRef: string;
  sessionKeyFingerprint?: string;
}

export interface FakeModelManagementState {
  calls: Map<string, ModelCallRecord>;
  idempotency: Map<string, string>;
  idempotencyFingerprints: Map<string, string>;
  fences: Map<string, number>;
  nextHandle: number;
}

export function createFakeModelManagementState(): FakeModelManagementState {
  return {
    calls: new Map(),
    idempotency: new Map(),
    idempotencyFingerprints: new Map(),
    fences: new Map(),
    nextHandle: 1,
  };
}

function assertOnlyFields(
  value: unknown,
  allowed: readonly string[],
  location: string,
): asserts value is Record<string, unknown> {
  assertManagementOnlyFields(value, allowed, 'model', location);
}

function requiredHandle(payload: unknown): string {
  return requireManagementString(payload, 'callHandle', 'model');
}

export function createFakeModelManagementDriver(options: {
  state?: FakeModelManagementState;
  now?: () => Date;
  models?: ManagedModelDescriptor[];
  authorizeAccess?: (
    request: DriverRequestEnvelope,
    model: ManagedModelDescriptor,
  ) => boolean | Promise<boolean>;
  generateText?: (
    request: ManagedModelRequest,
    signal?: AbortSignal,
  ) => AsyncIterable<string>;
  capabilities?: Partial<ModelManagementCapabilities>;
} = {}): ModelManagementDriver {
  const state = options.state ?? createFakeModelManagementState();
  const now = options.now ?? (() => new Date());
  const models = options.models ?? [{
    modelClass: 'managed-text',
    provider: 'fake',
    model: 'fake-1',
    digest: `sha256:${'a'.repeat(64)}`,
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
  }];
  const authorizeAccess = options.authorizeAccess ??
    ((request: DriverRequestEnvelope) => request.capabilityHandleRef === 'capability:model-1');
  const generateText = options.generateText ??
    (async function*() {
      yield 'managed ';
      yield 'response';
    });
  const capabilities: ModelManagementCapabilities = {
    name: 'fake-managed-model',
    streaming: true,
    cancellation: true,
    usageEstimation: true,
    maxConcurrentCalls: 4,
    maxOutputTokens: 4096,
    persistence: 'external',
    threatAssumptions: [
      'the model gateway, capability verifier, and durable usage state are trusted',
    ],
    ...options.capabilities,
  };
  const active = new Map<string, AbortController>();

  const context = createManagementDriverContext({
    state,
    now,
    driverName: 'model',
    requireRun: true,
  });

  function validate<T>(
    request: DriverRequestEnvelope<T>,
    method: string,
  ): number {
    return context.validate(request, method, {
      actorKinds: ['controller', 'admin'],
      forbiddenMessage: () => 'model provider access requires a controller or admin actor',
    });
  }

  function modelFor(payload: ManagedModelRequest): ManagedModelDescriptor {
    assertOnlyFields(
      payload,
      [
        'modelClass',
        'modelDigest',
        'messages',
        'maxOutputTokens',
        'temperature',
        'inputClassification',
        'residency',
      ],
      'request payload',
    );
    if (
      !Array.isArray(payload.messages) ||
      payload.messages.length === 0 ||
      payload.messages.length > 256 ||
      payload.messages.some((message) => {
        assertOnlyFields(message, ['role', 'content'], 'message');
        return !message.content || message.content.length > 1_000_000 ||
          !['system', 'user', 'assistant', 'tool'].includes(message.role);
      })
    ) invalid('model messages must be non-empty and bounded');
    if (!SHA256.test(payload.modelDigest)) invalid('model digest must be canonical sha256');
    if (
      !Number.isSafeInteger(payload.maxOutputTokens) ||
      payload.maxOutputTokens < 1 ||
      payload.maxOutputTokens > capabilities.maxOutputTokens
    ) {
      throw new OrchestrationError({
        code: 'EXHAUSTED',
        message: 'model output token request exceeds the driver limit',
        retryable: false,
      });
    }
    const model = models.find((candidate) => candidate.modelClass === payload.modelClass);
    if (!model) {
      throw new OrchestrationError({
        code: 'NOT_FOUND',
        message: `model class '${payload.modelClass}' was not found`,
        retryable: false,
      });
    }
    if (model.digest !== payload.modelDigest) {
      throw new OrchestrationError({
        code: 'CONFLICT',
        message: 'model digest does not match the selected model class',
        retryable: false,
      });
    }
    if (
      classificationRank(payload.inputClassification) >
        classificationRank(model.maxInputClassification)
    ) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: 'model input classification exceeds the endpoint policy',
        retryable: false,
      });
    }
    if (payload.residency && !model.residency.includes(payload.residency)) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `model cannot satisfy residency '${payload.residency}'`,
        retryable: false,
      });
    }
    return model;
  }

  async function authorize(
    request: DriverRequestEnvelope,
    model: ManagedModelDescriptor,
  ): Promise<void> {
    if (!await authorizeAccess(request, model)) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: 'model access capability was rejected',
        retryable: false,
      });
    }
  }

  function getCall(handle: string, resourceUid: string): ModelCallRecord {
    const call = state.calls.get(handle);
    if (!call) {
      throw new OrchestrationError({
        code: 'NOT_FOUND',
        message: `model call handle '${handle}' was not found`,
        retryable: false,
      });
    }
    if (call.usage.resourceUid !== resourceUid) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `model call handle '${handle}' belongs to another resource`,
        retryable: false,
      });
    }
    return call;
  }

  function assertCallAuthority(
    call: ModelCallRecord,
    request: DriverRequestEnvelope,
  ): void {
    if (
      call.capabilityHandleRef !== request.capabilityHandleRef ||
      call.sessionKeyFingerprint !== request.session?.keyFingerprint
    ) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: 'model call authority does not match its originating capability/session',
        retryable: false,
      });
    }
  }

  function estimateFor(
    payload: ManagedModelRequest,
    model: ManagedModelDescriptor,
  ): ManagedModelEstimate {
    const characters = payload.messages.reduce(
      (sum, message) => sum + message.content.length,
      0,
    );
    const inputTokens = Math.max(1, Math.ceil(characters / 4));
    return {
      inputTokens,
      maximumOutputTokens: payload.maxOutputTokens,
      maximumCost: inputTokens / 1_000_000 * (model.inputCostPerMillion ?? 0) +
        payload.maxOutputTokens / 1_000_000 *
          (model.outputCostPerMillion ?? 0),
    };
  }

  return {
    async getCapabilities() {
      return structuredClone(capabilities);
    },
    async listModels(request) {
      validate(request, 'model.list');
      assertOnlyFields(request.payload, [], 'list payload');
      if (models[0]) await authorize(request, models[0]);
      return structuredClone(models);
    },
    async estimate(request) {
      validate(request, 'model.estimate');
      const model = modelFor(request.payload);
      await authorize(request, model);
      return estimateFor(request.payload, model);
    },
    async *generate(request, generateOptions) {
      const fence = validate(request, 'model.generate');
      const model = modelFor(request.payload);
      await authorize(request, model);
      const inputFingerprint = canonicalManagementRequest(request);
      const replayHandle = context.replay(request, 'generate');
      if (replayHandle) {
        const replay = getCall(replayHandle, request.resource.uid);
        if (replay.inputFingerprint !== inputFingerprint) {
          throw new OrchestrationError({
            code: 'CONFLICT',
            message: 'model generation idempotency key was reused with different input',
            retryable: false,
          });
        }
        for (const chunk of replay.chunks) yield structuredClone(chunk);
        return;
      }
      if (active.size >= capabilities.maxConcurrentCalls) {
        throw new OrchestrationError({
          code: 'EXHAUSTED',
          message: 'model driver concurrency limit is exhausted',
          retryable: true,
        });
      }
      const callHandle = allocateManagementHandle(state, 'model-call');
      const estimate = estimateFor(request.payload, model);
      const usage: ManagedModelUsage = {
        callHandle,
        resourceUid: request.resource.uid,
        modelClass: model.modelClass,
        modelDigest: model.digest,
        phase: 'Running',
        inputTokens: estimate.inputTokens,
        outputTokens: 0,
        cost: estimate.inputTokens / 1_000_000 *
          (model.inputCostPerMillion ?? 0),
        fencingEpoch: fence,
        updatedAt: now().toISOString(),
      };
      const record: ModelCallRecord = {
        usage,
        chunks: [{ type: 'started', callHandle }],
        inputFingerprint,
        capabilityHandleRef: request.capabilityHandleRef as string,
        ...(request.session?.keyFingerprint
          ? { sessionKeyFingerprint: request.session.keyFingerprint }
          : {}),
      };
      state.calls.set(callHandle, record);
      context.remember(request, 'generate', callHandle);
      const controller = new AbortController();
      active.set(callHandle, controller);
      const externalAbort = () => {
        controller.abort();
      };
      generateOptions?.signal?.addEventListener('abort', externalAbort, {
        once: true,
      });
      yield structuredClone(record.chunks[0]);
      try {
        for await (const delta of generateText(request.payload, controller.signal)) {
          if (controller.signal.aborted) break;
          const chunk: ManagedModelChunk = { type: 'delta', delta };
          const deltaTokens = Math.max(1, Math.ceil(delta.length / 4));
          if (usage.outputTokens + deltaTokens > request.payload.maxOutputTokens) {
            usage.phase = 'Failed';
            const exhausted: ManagedModelChunk = {
              type: 'error',
              error: {
                code: 'EXHAUSTED',
                message: 'model output exceeded the authorized token budget',
                retryable: false,
              },
            };
            record.chunks.push(exhausted);
            yield structuredClone(exhausted);
            return;
          }
          record.chunks.push(chunk);
          usage.outputTokens += deltaTokens;
          yield structuredClone(chunk);
        }
        if (controller.signal.aborted) {
          usage.phase = 'Cancelled';
          const existing = record.chunks.find((candidate) =>
            candidate.type === 'error' &&
            candidate.error.code === 'CANCELLED'
          );
          const chunk: ManagedModelChunk = existing ?? {
            type: 'error',
            error: {
              code: 'CANCELLED',
              message: 'model generation was cancelled',
              retryable: false,
            },
          };
          if (!existing) record.chunks.push(chunk);
          yield structuredClone(chunk);
          return;
        }
        usage.phase = 'Completed';
        usage.cost += usage.outputTokens / 1_000_000 *
          (model.outputCostPerMillion ?? 0);
        const usageChunk: ManagedModelChunk = {
          type: 'usage',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cost: usage.cost,
        };
        record.chunks.push(usageChunk, { type: 'done' });
        yield structuredClone(usageChunk);
        yield { type: 'done' };
      } catch (error) {
        usage.phase = 'Failed';
        const chunk: ManagedModelChunk = {
          type: 'error',
          error: {
            code: 'INTERNAL',
            message: safeErrorMessageFromUnknown(error, { fallback: 'Model management operation failed' }),
            retryable: false,
          },
        };
        record.chunks.push(chunk);
        yield structuredClone(chunk);
      } finally {
        usage.updatedAt = now().toISOString();
        active.delete(callHandle);
        generateOptions?.signal?.removeEventListener('abort', externalAbort);
      }
    },
    async cancel(request) {
      const fence = validate(request, 'model.cancel');
      assertOnlyFields(request.payload, ['callHandle'], 'cancel payload');
      if (!capabilities.cancellation) {
        throw new OrchestrationError({
          code: 'UNSUPPORTED',
          message: 'model cancellation is unsupported',
          retryable: false,
        });
      }
      const call = getCall(requiredHandle(request.payload), request.resource.uid);
      assertCallAuthority(call, request);
      active.get(call.usage.callHandle)?.abort();
      if (call.usage.phase === 'Running') {
        call.usage.phase = 'Cancelled';
        call.chunks.push({
          type: 'error',
          error: {
            code: 'CANCELLED',
            message: 'model generation was cancelled',
            retryable: false,
          },
        });
      }
      call.usage.fencingEpoch = fence;
      call.usage.updatedAt = now().toISOString();
      return structuredClone(call.usage);
    },
    async inspectUsage(request) {
      const fence = validate(request, 'model.inspect-usage');
      assertOnlyFields(request.payload, ['callHandle'], 'inspect payload');
      const handle = requiredHandle(request.payload);
      const call = state.calls.get(handle);
      if (!call) return undefined;
      const scoped = getCall(handle, request.resource.uid);
      assertCallAuthority(scoped, request);
      scoped.usage.fencingEpoch = fence;
      return structuredClone(scoped.usage);
    },
    async getHealth(request) {
      validate(request, 'model.health');
      assertOnlyFields(request.payload, [], 'health payload');
      if (models[0]) await authorize(request, models[0]);
      return {
        healthy: true,
        checkedAt: now().toISOString(),
        detail: `${models.length} admitted model(s)`,
      };
    },
  };
}

export function createModelManagementConformanceSuite(options: {
  createRequest<T>(
    method: string,
    payload: T,
    idempotencyKey: string,
    fencingEpoch?: number,
    resourceUid?: string,
  ): DriverRequestEnvelope<T>;
  recreate(driver: ModelManagementDriver): ModelManagementDriver;
}): DriverConformanceSuite {
  const modelDigest = `sha256:${'a'.repeat(64)}`;
  const payload = (content = 'hello'): ManagedModelRequest => ({
    modelClass: 'managed-text',
    modelDigest,
    messages: [{ role: 'user', content }],
    maxOutputTokens: 128,
    inputClassification: 'confidential',
    residency: 'local',
  });
  async function collect(
    driver: ModelManagementDriver,
    request: DriverRequestEnvelope<ManagedModelRequest>,
  ): Promise<ManagedModelChunk[]> {
    const chunks: ManagedModelChunk[] = [];
    for await (const chunk of driver.generate(request)) chunks.push(chunk);
    return chunks;
  }

  return managementConformanceSuite('model-provider', [
    {
      name: 'declares provider and model security capabilities',
      description: 'Capabilities and model descriptors include policy-relevant claims',
      run: async (value) => {
        const driver = value as ModelManagementDriver;
        const capabilities = await driver.getCapabilities();
        if (!capabilities.name || !capabilities.threatAssumptions.length) {
          throw new Error('model capabilities are incomplete');
        }
        const models = await driver.listModels(options.createRequest(
          'model.list',
          {},
          'list',
          3,
        ));
        const model = models[0];
        if (
          !model ||
          !SHA256.test(model.digest) ||
          !model.modalities.length ||
          !model.residency.length ||
          !model.inputTrust ||
          !model.outputTrust
        ) throw new Error('model security descriptor is incomplete');
      },
    },
    {
      name: 'estimates and streams bounded usage idempotently',
      description: 'Generation binds exact input and replays one logical call',
      run: async (value) => {
        const driver = value as ModelManagementDriver;
        const estimate = await driver.estimate(options.createRequest(
          'model.estimate',
          payload(),
          'estimate',
          3,
        ));
        if (estimate.inputTokens < 1 || estimate.maximumOutputTokens !== 128) {
          throw new Error('model estimate is invalid');
        }
        const request = options.createRequest(
          'model.generate',
          payload(),
          'generate',
          3,
        );
        const first = await collect(driver, request);
        const second = await collect(driver, request);
        if (canonicalDriverValue(first) !== canonicalDriverValue(second)) {
          throw new Error('model generation did not replay');
        }
        if (first.at(-1)?.type !== 'done') throw new Error('model stream did not complete');
        let driftRejected = false;
        try {
          await collect(driver, { ...request, payload: payload('different') });
        } catch (error) {
          driftRejected = error instanceof OrchestrationError && error.code === 'CONFLICT';
        }
        if (!driftRejected) throw new Error('model idempotency drift was accepted');
      },
    },
    {
      name: 'persists usage across recreation and rejects stale fencing',
      description: 'Usage is inspectable after restart and stale controllers fail closed',
      run: async (value) => {
        const driver = value as ModelManagementDriver;
        const chunks = await collect(
          driver,
          options.createRequest(
            'model.generate',
            payload('restart'),
            'restart',
            5,
          ),
        );
        const started = chunks.find((chunk) => chunk.type === 'started');
        if (!started || started.type !== 'started') throw new Error('model call handle is missing');
        const restarted = options.recreate(driver);
        const usage = await restarted.inspectUsage(options.createRequest(
          'model.inspect-usage',
          { callHandle: started.callHandle },
          'inspect',
          6,
        ));
        if (usage?.phase !== 'Completed') throw new Error('completed usage was not adopted');
        let staleRejected = false;
        try {
          await restarted.inspectUsage(options.createRequest(
            'model.inspect-usage',
            { callHandle: started.callHandle },
            'stale',
            4,
          ));
        } catch (error) {
          staleRejected = error instanceof OrchestrationError && error.code === 'STALE_EPOCH';
        }
        if (!staleRejected) throw new Error('stale model fencing epoch was accepted');
      },
    },
    {
      name: 'cancels an active bounded stream',
      description: 'Cancellation reaches the driver-owned in-flight operation',
      run: async (value) => {
        const driver = value as ModelManagementDriver;
        const request = options.createRequest(
          'model.generate',
          payload('cancel'),
          'cancel-stream',
          7,
        );
        const iterator = driver.generate(request)[Symbol.asyncIterator]();
        const started: IteratorResult<ManagedModelChunk> = await iterator.next();
        if (started.done || started.value.type !== 'started') {
          throw new Error('model stream did not start');
        }
        const cancelled = await driver.cancel(options.createRequest(
          'model.cancel',
          { callHandle: started.value.callHandle },
          'cancel',
          7,
        ));
        if (cancelled.phase !== 'Cancelled') throw new Error('model call was not cancelled');
        await iterator.return?.();
      },
    },
    {
      name: 'rejects foreign handles, policy excess, and capability denial',
      description: 'Resource, digest, classification, residency, and capability scope fail closed',
      run: async (value) => {
        const driver = value as ModelManagementDriver;
        const chunks = await collect(
          driver,
          options.createRequest(
            'model.generate',
            payload('scope'),
            'scope',
            8,
            'model-a',
          ),
        );
        const started = chunks.find((chunk) => chunk.type === 'started');
        if (!started || started.type !== 'started') throw new Error('model call handle is missing');
        let foreignRejected = false;
        try {
          await driver.inspectUsage(options.createRequest(
            'model.inspect-usage',
            { callHandle: started.callHandle },
            'foreign',
            8,
            'model-b',
          ));
        } catch (error) {
          foreignRejected = error instanceof OrchestrationError && error.code === 'FORBIDDEN';
        }
        if (!foreignRejected) throw new Error('foreign model handle was accepted');
      },
    },
  ]);
}
