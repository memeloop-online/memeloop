import { safeErrorMessageFromUnknown } from '../../safeError.js';
import { OrchestrationError } from '../errors.js';

import { assertDriverRequestEnvelope, canonicalDriverValue, type DriverRequestEnvelope } from './driverRequest.js';
import type { ModelGateway } from './modelGateway.js';
import {
  type ManagedModelChunk,
  type ManagedModelDescriptor,
  type ManagedModelEstimate,
  type ManagedModelRequest,
  type ManagedModelUsage,
  type ModelManagementCapabilities,
  type ModelManagementDriver,
} from './modelManagement.js';
import { classificationRank } from './modelProviderDriver.js';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'];

export interface ManagedModelGatewayAccess {
  /** Opaque signed token presented only to ModelGateway; never retained by the adapter. */
  token: string;
  /** Presented proof-of-possession fingerprint when the signed handle requires one. */
  workerKey?: string;
  /** Non-secret digest that binds idempotency/inspection to the same authority. */
  authorityFingerprint: string;
}

export interface ManagedModelGatewayAdapterOptions {
  models: ManagedModelDescriptor[];
  capabilities: ModelManagementCapabilities;
  /**
   * Verify the envelope capability against the selected model/Run/session and
   * return the already-authorized gateway token. Undefined means denial.
   */
  resolveAccess(
    request: DriverRequestEnvelope,
    model: ManagedModelDescriptor,
  ): Promise<ManagedModelGatewayAccess | undefined>;
  now?: () => Date;
}

interface ManagedGatewayCall {
  usage: ManagedModelUsage;
  chunks: ManagedModelChunk[];
  inputFingerprint: string;
  authorityFingerprint: string;
  gatewayCallId: string;
  model: ManagedModelDescriptor;
}

function fail(code: OrchestrationError['code'], message: string, retryable = false): never {
  throw new OrchestrationError({ code, message, retryable });
}

function objectWithFields(
  value: unknown,
  allowed: readonly string[],
  location: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID', `managed model ${location} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) {
    fail('INVALID', `managed model ${location} contains unsupported fields: ${unknown.join(', ')}`);
  }
  return record;
}

function validateDescriptor(model: ManagedModelDescriptor): void {
  if (
    !model.modelClass ||
    !model.provider ||
    !model.model ||
    !SHA256.test(model.digest) ||
    model.modalities.length === 0 ||
    model.contextWindow < 1 ||
    !Number.isSafeInteger(model.contextWindow) ||
    model.residency.length === 0 ||
    !CLASSIFICATIONS.includes(model.maxInputClassification) ||
    !CLASSIFICATIONS.includes(model.outputClassification)
  ) {
    fail('INVALID', `managed model descriptor '${model.modelClass}' is incomplete`);
  }
}

function resolveModel(
  payload: ManagedModelRequest,
  models: ManagedModelDescriptor[],
  capabilities: ModelManagementCapabilities,
): ManagedModelDescriptor {
  objectWithFields(payload, [
    'modelClass',
    'modelDigest',
    'messages',
    'maxOutputTokens',
    'temperature',
    'inputClassification',
    'residency',
  ], 'request payload');
  if (
    !Array.isArray(payload.messages) ||
    payload.messages.length === 0 ||
    payload.messages.length > 256
  ) {
    fail('INVALID', 'managed model messages must be a non-empty bounded array');
  }
  for (const message of payload.messages) {
    objectWithFields(message, ['role', 'content'], 'message');
    if (
      !['system', 'user', 'assistant', 'tool'].includes(message.role) ||
      typeof message.content !== 'string' ||
      !message.content ||
      message.content.length > 1_000_000
    ) {
      fail('INVALID', 'managed model messages contain an invalid role or content');
    }
  }
  if (!SHA256.test(payload.modelDigest)) {
    fail('INVALID', 'managed model digest must be canonical sha256');
  }
  if (
    !Number.isSafeInteger(payload.maxOutputTokens) ||
    payload.maxOutputTokens < 1 ||
    payload.maxOutputTokens > capabilities.maxOutputTokens
  ) {
    fail('EXHAUSTED', 'managed model output token request exceeds the adapter limit');
  }
  if (
    payload.temperature !== undefined &&
    (
      typeof payload.temperature !== 'number' ||
      !Number.isFinite(payload.temperature) ||
      payload.temperature < 0 ||
      payload.temperature > 2
    )
  ) {
    fail('INVALID', 'managed model temperature must be between zero and two');
  }
  if (!CLASSIFICATIONS.includes(payload.inputClassification)) {
    fail('INVALID', 'managed model input classification is unsupported');
  }
  const model = models.find((candidate) => candidate.modelClass === payload.modelClass);
  if (!model) fail('NOT_FOUND', `managed model class '${payload.modelClass}' was not found`);
  if (model.digest !== payload.modelDigest) {
    fail('CONFLICT', 'managed model digest does not match the selected model class');
  }
  if (
    classificationRank(payload.inputClassification) >
      classificationRank(model.maxInputClassification)
  ) {
    fail('FORBIDDEN', 'managed model input classification exceeds endpoint policy');
  }
  if (payload.residency && !model.residency.includes(payload.residency)) {
    fail('FORBIDDEN', `managed model cannot satisfy residency '${payload.residency}'`);
  }
  return model;
}

function estimate(
  payload: ManagedModelRequest,
  model: ManagedModelDescriptor,
): ManagedModelEstimate {
  const characters = payload.messages.reduce(
    (total, message) => total + message.content.length,
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

function callHandle(payload: unknown): string {
  const record = objectWithFields(payload, ['callHandle'], 'handle payload');
  if (
    typeof record.callHandle !== 'string' ||
    !record.callHandle ||
    record.callHandle.length > 2048
  ) {
    fail('INVALID', 'managed model callHandle is required and must be bounded');
  }
  return record.callHandle;
}

/**
 * Adapt the real signed ModelGateway into the complete management protocol.
 * Stream/idempotency state is process-local, so crash adoption is not claimed.
 */
export function createManagedModelGatewayAdapter(
  gateway: ModelGateway,
  options: ManagedModelGatewayAdapterOptions,
): ModelManagementDriver {
  const { capabilities } = options;
  if (
    !capabilities.name ||
    capabilities.persistence !== 'process' ||
    !capabilities.streaming ||
    !capabilities.cancellation ||
    capabilities.maxConcurrentCalls < 1 ||
    !Number.isSafeInteger(capabilities.maxConcurrentCalls) ||
    capabilities.maxOutputTokens < 1 ||
    !Number.isSafeInteger(capabilities.maxOutputTokens) ||
    capabilities.threatAssumptions.length === 0 ||
    options.models.length === 0
  ) {
    fail('INVALID', 'managed gateway adapter capabilities overstate or omit its process lifecycle');
  }
  for (const model of options.models) validateDescriptor(model);
  if (new Set(options.models.map((model) => model.modelClass)).size !== options.models.length) {
    fail('INVALID', 'managed gateway adapter modelClass values must be unique');
  }

  const now = options.now ?? (() => new Date());
  const calls = new Map<string, ManagedGatewayCall>();
  const idempotency = new Map<string, string>();
  const fences = new Map<string, number>();
  const active = new Map<string, AbortController>();
  let nextCall = 1;

  function validate<T>(request: DriverRequestEnvelope<T>, method: string): number {
    assertDriverRequestEnvelope(request, {
      now,
      requireRun: true,
      requireFencing: true,
      requireCapability: true,
      expectedMethod: method,
    });
    if (request.actor.kind !== 'controller' && request.actor.kind !== 'admin') {
      fail('FORBIDDEN', 'managed model access requires a controller or admin actor');
    }
    const epoch = request.fencingEpoch as number;
    const current = fences.get(request.resource.uid) ?? 0;
    if (epoch < current) {
      throw new OrchestrationError({
        code: 'STALE_EPOCH',
        message: `stale managed model fencing epoch ${epoch}; current epoch is ${current}`,
        retryable: false,
      });
    }
    fences.set(request.resource.uid, epoch);
    return epoch;
  }

  async function access(
    request: DriverRequestEnvelope,
    model: ManagedModelDescriptor,
  ): Promise<ManagedModelGatewayAccess> {
    const resolved = await options.resolveAccess(request, model);
    if (
      !resolved ||
      !resolved.token ||
      !resolved.authorityFingerprint ||
      resolved.authorityFingerprint.length > 2048
    ) {
      fail('FORBIDDEN', 'managed model gateway capability was rejected');
    }
    return resolved;
  }

  function scoped(handle: string, resourceUid: string): ManagedGatewayCall {
    const call = calls.get(handle);
    if (!call) fail('NOT_FOUND', `managed model call '${handle}' was not found`);
    if (call.usage.resourceUid !== resourceUid) {
      fail('FORBIDDEN', `managed model call '${handle}' belongs to another resource`);
    }
    return call;
  }

  function authorityInput(
    request: DriverRequestEnvelope,
    authorityFingerprint: string,
  ): string {
    return canonicalDriverValue({
      payload: request.payload,
      run: request.run,
      session: request.session,
      payloadSchemaDigest: request.payloadSchemaDigest,
      authorityFingerprint,
    });
  }

  function cancellationChunk(
    deadline: string,
  ): Extract<ManagedModelChunk, { type: 'error' }> {
    const timedOut = Date.parse(deadline) <= now().getTime();
    return {
      type: 'error',
      error: {
        code: timedOut ? 'TIMEOUT' : 'CANCELLED',
        message: timedOut
          ? 'managed model generation exceeded its deadline'
          : 'managed model generation was cancelled',
        retryable: false,
      },
    };
  }

  return {
    async getCapabilities() {
      return structuredClone(capabilities);
    },

    async listModels(request) {
      validate(request, 'model.list');
      objectWithFields(request.payload, [], 'list payload');
      const authorized: ManagedModelDescriptor[] = [];
      for (const model of options.models) {
        if (await options.resolveAccess(request, model)) authorized.push(model);
      }
      if (authorized.length === 0) {
        fail('FORBIDDEN', 'managed model capability authorizes no model descriptors');
      }
      return structuredClone(authorized);
    },

    async estimate(request) {
      validate(request, 'model.estimate');
      const model = resolveModel(request.payload, options.models, capabilities);
      await access(request, model);
      return estimate(request.payload, model);
    },

    async *generate(request, generateOptions) {
      const epoch = validate(request, 'model.generate');
      const model = resolveModel(request.payload, options.models, capabilities);
      const granted = await access(request, model);
      const inputFingerprint = authorityInput(request, granted.authorityFingerprint);
      const key = `${request.resource.uid}:generate:${request.idempotencyKey}`;
      const replayHandle = idempotency.get(key);
      if (replayHandle) {
        const replay = scoped(replayHandle, request.resource.uid);
        if (replay.inputFingerprint !== inputFingerprint) {
          fail('CONFLICT', 'managed model idempotency key was reused with different input');
        }
        if (replay.usage.phase === 'Running') {
          fail('CONFLICT', 'managed model call is still active and cannot be replayed yet', true);
        }
        for (const chunk of replay.chunks) yield structuredClone(chunk);
        return;
      }
      if (active.size >= capabilities.maxConcurrentCalls) {
        fail('EXHAUSTED', 'managed model gateway concurrency is exhausted', true);
      }

      const handle = `managed-model-call:${nextCall}`;
      nextCall += 1;
      const gatewayCallId = `${request.resource.uid}:${handle}`;
      const estimated = estimate(request.payload, model);
      const usage: ManagedModelUsage = {
        callHandle: handle,
        resourceUid: request.resource.uid,
        modelClass: model.modelClass,
        modelDigest: model.digest,
        phase: 'Running',
        inputTokens: estimated.inputTokens,
        outputTokens: 0,
        cost: estimated.inputTokens / 1_000_000 *
          (model.inputCostPerMillion ?? 0),
        fencingEpoch: epoch,
        updatedAt: now().toISOString(),
      };
      const record: ManagedGatewayCall = {
        usage,
        chunks: [{ type: 'started', callHandle: handle }],
        inputFingerprint,
        authorityFingerprint: granted.authorityFingerprint,
        gatewayCallId,
        model,
      };
      calls.set(handle, record);
      idempotency.set(key, handle);
      const controller = new AbortController();
      active.set(handle, controller);
      const abort = () => {
        controller.abort();
      };
      generateOptions?.signal?.addEventListener('abort', abort, { once: true });
      const deadlineDelay = Math.max(1, Date.parse(request.deadline) - now().getTime());
      const deadlineTimer = setTimeout(abort, deadlineDelay);

      let terminal = false;
      try {
        yield structuredClone(record.chunks[0]);
        if (controller.signal.aborted) {
          usage.phase = 'Cancelled';
          const existingCancellation = record.chunks.at(-1);
          const error = existingCancellation?.type === 'error'
            ? existingCancellation
            : cancellationChunk(request.deadline);
          if (existingCancellation !== error) record.chunks.push(error);
          yield structuredClone(error);
          terminal = true;
          return;
        }
        for await (
          const chunk of gateway.generate({
            callId: gatewayCallId,
            modelClassRef: {
              apiVersion: 'models.memeloop.io/v1alpha1',
              kind: 'ModelClass',
              name: model.modelClass,
            },
            modelDigest: model.digest,
            messages: request.payload.messages,
            maxOutputTokens: request.payload.maxOutputTokens,
            ...(request.payload.temperature !== undefined
              ? { temperature: request.payload.temperature }
              : {}),
            inputClassification: request.payload.inputClassification,
            accessHandle: granted.token,
            ...(granted.workerKey ? { workerKey: granted.workerKey } : {}),
            signal: controller.signal,
          })
        ) {
          if (controller.signal.aborted) break;
          if (chunk.type === 'delta' && chunk.delta !== undefined) {
            const deltaTokens = Math.max(1, Math.ceil(chunk.delta.length / 4));
            if (usage.outputTokens + deltaTokens > request.payload.maxOutputTokens) {
              usage.phase = 'Failed';
              const error: ManagedModelChunk = {
                type: 'error',
                error: {
                  code: 'EXHAUSTED',
                  message: 'managed model output exceeded the authorized token budget',
                  retryable: false,
                },
              };
              record.chunks.push(error);
              yield structuredClone(error);
              await gateway.cancel(gatewayCallId);
              terminal = true;
              return;
            }
            usage.outputTokens += deltaTokens;
            const delta: ManagedModelChunk = { type: 'delta', delta: chunk.delta };
            record.chunks.push(delta);
            yield structuredClone(delta);
          } else if (chunk.type === 'error') {
            const existingCancellation = record.chunks.at(-1);
            if (
              usage.phase === 'Cancelled' &&
              existingCancellation?.type === 'error' &&
              existingCancellation.error.code === 'CANCELLED'
            ) {
              yield structuredClone(existingCancellation);
              terminal = true;
              return;
            }
            usage.phase = chunk.error?.code === 'CANCELLED' ? 'Cancelled' : 'Failed';
            const error: ManagedModelChunk = {
              type: 'error',
              error: chunk.error ?? {
                code: 'INTERNAL',
                message: 'model gateway returned an empty error',
                retryable: false,
              },
            };
            record.chunks.push(error);
            yield structuredClone(error);
            terminal = true;
            return;
          }
        }
        if (controller.signal.aborted) {
          usage.phase = 'Cancelled';
          await gateway.cancel(gatewayCallId);
          const existingCancellation = record.chunks.at(-1);
          if (
            existingCancellation?.type === 'error' &&
            existingCancellation.error.code === 'CANCELLED'
          ) {
            yield structuredClone(existingCancellation);
            terminal = true;
            return;
          }
          const error = cancellationChunk(request.deadline);
          record.chunks.push(error);
          yield structuredClone(error);
          terminal = true;
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
        terminal = true;
      } catch (error) {
        usage.phase = 'Failed';
        const failure: ManagedModelChunk = {
          type: 'error',
          error: {
            code: error instanceof OrchestrationError ? error.code : 'INTERNAL',
            message: safeErrorMessageFromUnknown(error, { fallback: 'Managed model gateway failed' }),
            retryable: error instanceof OrchestrationError && error.retryable,
          },
        };
        record.chunks.push(failure);
        yield structuredClone(failure);
        terminal = true;
      } finally {
        clearTimeout(deadlineTimer);
        generateOptions?.signal?.removeEventListener('abort', abort);
        active.delete(handle);
        if (!terminal && usage.phase === 'Running') {
          usage.phase = 'Cancelled';
          await gateway.cancel(gatewayCallId);
          record.chunks.push({
            type: 'error',
            error: {
              code: 'CANCELLED',
              message: 'managed model stream consumer disconnected',
              retryable: false,
            },
          });
        }
        usage.updatedAt = now().toISOString();
      }
    },

    async cancel(request) {
      const epoch = validate(request, 'model.cancel');
      const call = scoped(callHandle(request.payload), request.resource.uid);
      const granted = await access(request, call.model);
      if (granted.authorityFingerprint !== call.authorityFingerprint) {
        fail('FORBIDDEN', 'managed model cancellation authority does not match the call');
      }
      active.get(call.usage.callHandle)?.abort();
      await gateway.cancel(call.gatewayCallId);
      if (call.usage.phase === 'Running') {
        call.usage.phase = 'Cancelled';
        call.chunks.push({
          type: 'error',
          error: {
            code: 'CANCELLED',
            message: 'managed model generation was cancelled',
            retryable: false,
          },
        });
      }
      call.usage.fencingEpoch = epoch;
      call.usage.updatedAt = now().toISOString();
      return structuredClone(call.usage);
    },

    async inspectUsage(request) {
      const epoch = validate(request, 'model.inspect-usage');
      const handle = callHandle(request.payload);
      const found = calls.get(handle);
      if (!found) return undefined;
      const call = scoped(handle, request.resource.uid);
      const granted = await access(request, call.model);
      if (granted.authorityFingerprint !== call.authorityFingerprint) {
        fail('FORBIDDEN', 'managed model inspection authority does not match the call');
      }
      call.usage.fencingEpoch = epoch;
      return structuredClone(call.usage);
    },

    async getHealth(request) {
      validate(request, 'model.health');
      objectWithFields(request.payload, [], 'health payload');
      let authorized = false;
      for (const model of options.models) {
        if (await options.resolveAccess(request, model)) {
          authorized = true;
          break;
        }
      }
      if (!authorized) fail('FORBIDDEN', 'managed model health capability was rejected');
      return gateway.getHealth();
    },
  };
}
