import { safeErrorMessageFromUnknown } from '../../safeError.js';
import type { OrchestrationOwnerReference } from '../client.js';
import { OrchestrationError } from '../errors.js';
import type { OrchestrationErrorData } from '../errors.js';
import type { ModelCallRecordSpec, ModelCallRecordStatus } from '../resources.js';
import type { ModelClassSpec } from '../resources.js';
import type { ModelAccessHandleBroker, ModelAccessHandleClaims } from '../security/modelAccessHandle.js';
import type { ModelProviderHealth } from './modelProviderDriver.js';
import type { ModelGenerateRequest, ModelStreamChunk } from './modelProviderDriver.js';

/**
 * ModelGateway (plan §12, §21.3): the trusted model path.
 *
 * The gateway holds no provider credential itself — it guards an
 * `ModelGatewayExecutor` (host-provided provider route)
 * that performs the actual call with host-held keys. Workers present a
 * short-lived `ModelAccessHandle` (24.34) instead of a provider key; the
 * gateway verifies Run/model/audience/expiry/proof-of-possession and
 * enforces per-Run token, cost, concurrency, and request-rate budgets at
 * the gateway (§12.4 — not only in the worker). Every call produces a
 * `ModelCallRecord` (24.32) via the injected recorder.
 *
 * Secret discipline (§12.4): handle tokens, prompts, and model output are
 * never written to records, logs, or thrown error details.
 */

export interface ModelGatewayGenerateRequest extends ModelGenerateRequest {
  /** Opaque ModelAccessHandle token presented by the caller. Never recorded. */
  accessHandle: string;
  /** Presented worker key fingerprint for the proof-of-possession check. */
  workerKey?: string;
}

export interface ModelGatewayCallRecord {
  /** ModelCallRecord correlation id (ModelGenerateRequest.callId). */
  callId: string;
  spec: ModelCallRecordSpec;
  status: ModelCallRecordStatus;
}

/** Audit port; hosts persist ModelCallRecord resources (e.g. ControlStore). */
export interface ModelGatewayRecorder {
  recordCall(record: ModelGatewayCallRecord): Promise<void> | void;
}

/** Performs the actual provider call with host-held credentials. */
export interface ModelGatewayExecutor {
  listModels?(): Promise<ModelClassSpec[]>;
  getHealth?(): Promise<ModelProviderHealth>;
  generate(request: ModelGenerateRequest): AsyncIterable<ModelStreamChunk>;
  cancel?(callId: string): Promise<void>;
}

export interface ModelGatewayOptions {
  /** Handle issuer/verifier (24.34). */
  broker: ModelAccessHandleBroker;
  /** Host provider executor holding the real credentials. */
  executor: ModelGatewayExecutor;
  /** Audit recorder for ModelCallRecords; recording failures never break calls. */
  recorder?: ModelGatewayRecorder;
  /** Host-asserted caller identity stamped on records (never self-reported). */
  caller?: string;
  /** Required handle audience (defaults to the broker's audience). */
  audience?: string;
  /** Cost charged per token (input + output) when the stream reports usage. */
  costPerToken?: number;
  /** Currency stamped on recorded usage. */
  currency?: string;
  /** Sliding-window request rate limit per handle (requests/second). */
  maxRequestsPerSecond?: number;
  /** Sink for non-fatal gateway errors (e.g. recorder failures). */
  onError?: (error: unknown) => void;
  now?: () => Date;
}

export interface ModelGateway {
  listModels(): Promise<ModelClassSpec[]>;
  getHealth(): Promise<ModelProviderHealth>;
  generate(request: ModelGatewayGenerateRequest): AsyncIterable<ModelStreamChunk>;
  /** Abort an in-flight call (e.g. Run cancellation). */
  cancel(callId: string): Promise<void>;
  /** Revoke a handle immediately (Run completion, cancellation, policy change). */
  revokeHandle(handleId: string): void;
  /** Revoke every handle the gateway has verified for the given Run name. */
  revokeRunHandles(runName: string): void;
}

export function createModelGateway(options: ModelGatewayOptions): ModelGateway {
  const now = options.now ?? (() => new Date());
  const onError = options.onError ?? (() => {});
  const costPerToken = options.costPerToken ?? 0;

  /** In-flight calls by callId. */
  const inFlight = new Map<string, { handleId: string }>();
  /** handleId → run name, for revokeRunHandles (§12.1 step 6). */
  const seenHandles = new Map<string, string | undefined>();
  /** Per-handle request timestamps for the sliding-window rate limit. */
  const requestLog = new Map<string, number[]>();

  function checkRateLimit(handleId: string): void {
    const limit = options.maxRequestsPerSecond;
    if (!limit) return;
    const at = now().getTime();
    const windowStart = at - 1000;
    const log = (requestLog.get(handleId) ?? []).filter((timestamp) => timestamp >= windowStart);
    if (log.length >= limit) {
      const retryAfterMs = Math.max(1, log[0] + 1000 - at);
      throw new OrchestrationError({
        code: 'EXHAUSTED',
        message: `model gateway request rate limit exceeded (${limit}/s)`,
        retryable: true,
        retryAfterMs,
      });
    }
    log.push(at);
    requestLog.set(handleId, log);
  }

  async function verifyRequest(request: ModelGatewayGenerateRequest): Promise<ModelAccessHandleClaims> {
    const claims = await options.broker.verifyModelAccessHandle(request.accessHandle, {
      ...(options.audience !== undefined ? { audience: options.audience } : {}),
      ...(request.workerKey !== undefined ? { workerKey: request.workerKey } : {}),
    });
    // PoP: a key-bound handle must be presented with a key; the broker only
    // compares when both sides exist, so the gateway closes the gap.
    if (claims.workerKey && !request.workerKey) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: 'model access handle requires proof-of-possession of the bound worker key',
        retryable: false,
      });
    }
    if (
      claims.modelClassRef.apiVersion !== request.modelClassRef.apiVersion ||
      claims.modelClassRef.kind !== request.modelClassRef.kind ||
      claims.modelClassRef.name !== request.modelClassRef.name
    ) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: 'handle model class identity does not match the gateway request',
        retryable: false,
      });
    }
    if (claims.modelDigest && request.modelDigest !== claims.modelDigest) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: 'handle requires its bound model digest on the gateway request',
        retryable: false,
      });
    }
    checkRateLimit(claims.handleId);
    const concurrent = [...inFlight.values()].filter((entry) => entry.handleId === claims.handleId).length;
    const maxConcurrent = claims.budget?.maxConcurrent;
    if (maxConcurrent !== undefined && concurrent >= maxConcurrent) {
      throw new OrchestrationError({
        code: 'EXHAUSTED',
        message: `model gateway concurrency budget exceeded (${maxConcurrent} in-flight)`,
        retryable: true,
        retryAfterMs: 100,
      });
    }
    return claims;
  }

  function buildRecord(
    request: ModelGatewayGenerateRequest,
    claims: ModelAccessHandleClaims,
    status: ModelCallRecordStatus,
  ): ModelGatewayCallRecord {
    const runReference: OrchestrationOwnerReference | undefined = claims.runRef
      ? {
        apiVersion: claims.runRef.apiVersion,
        kind: claims.runRef.kind,
        name: claims.runRef.name,
        // ModelAccessHandle claims allow an absent uid; the record schema
        // requires one, so fall back to the empty marker.
        uid: claims.runRef.uid ?? '',
      }
      : undefined;
    // §12.4: the record carries identity, policy, usage, and latency — never
    // the handle token, prompts, or model output.
    return {
      callId: request.callId,
      spec: {
        modelClassRef: claims.modelClassRef,
        ...((claims.modelDigest ?? request.modelDigest) !== undefined
          ? { modelDigest: claims.modelDigest ?? request.modelDigest }
          : {}),
        ...(runReference ? { runRef: runReference } : {}),
        ...(claims.attempt !== undefined ? { runAttempt: claims.attempt } : {}),
        ...(options.caller !== undefined ? { caller: options.caller } : {}),
        accessHandleRef: claims.handleId,
        ...(claims.policyDigest !== undefined ? { policyDigest: claims.policyDigest } : {}),
        ...(request.inputClassification !== undefined ? { inputClassification: request.inputClassification } : {}),
      },
      status,
    };
  }

  async function record(record: ModelGatewayCallRecord): Promise<void> {
    try {
      await options.recorder?.recordCall(record);
    } catch (error) {
      onError(error);
    }
  }

  async function* generate(request: ModelGatewayGenerateRequest): AsyncIterable<ModelStreamChunk> {
    const startedAt = now();
    const claims = await verifyRequest(request);
    seenHandles.set(claims.handleId, claims.runRef?.name);
    inFlight.set(request.callId, { handleId: claims.handleId });

    // Clamp the output cap to the handle's remaining output budget so the
    // executor never produces beyond the budget by construction.
    const maxOutputTokens = claims.budget?.maxOutputTokens;
    const effectiveRequest: ModelGenerateRequest = {
      ...request,
      ...(maxOutputTokens !== undefined
        ? { maxOutputTokens: Math.min(request.maxOutputTokens ?? maxOutputTokens, maxOutputTokens) }
        : {}),
    };

    let inputTokens = 0;
    let outputTokens = 0;
    let phase: ModelCallRecordStatus['phase'] = 'Completed';
    let failure: OrchestrationErrorData | undefined;

    try {
      for await (const chunk of options.executor.generate(effectiveRequest)) {
        if (chunk.type === 'usage') {
          // Usage chunks are cumulative; take the max to tolerate duplicates.
          inputTokens = Math.max(inputTokens, chunk.usage?.inputTokens ?? 0);
          outputTokens = Math.max(outputTokens, chunk.usage?.outputTokens ?? 0);
          const cost = (inputTokens + outputTokens) * costPerToken;
          const overInput = claims.budget?.maxInputTokens !== undefined && inputTokens > claims.budget.maxInputTokens;
          const overOutput = claims.budget?.maxOutputTokens !== undefined && outputTokens > claims.budget.maxOutputTokens;
          const overCost = claims.budget?.maxCost !== undefined && cost > claims.budget.maxCost;
          if (overInput || overOutput || overCost) {
            phase = 'Failed';
            failure = {
              code: 'EXHAUSTED',
              message: 'model access handle budget exceeded at gateway',
              retryable: false,
            };
            await options.executor.cancel?.(request.callId);
            yield { type: 'error', error: failure };
            return;
          }
          continue;
        }
        if (chunk.type === 'error') {
          phase = chunk.error?.code === 'CANCELLED' ? 'Cancelled' : 'Failed';
          failure = chunk.error as OrchestrationErrorData;
        }
        yield chunk;
      }
      if (phase === 'Completed' && request.signal?.aborted) {
        phase = 'Cancelled';
      }
    } catch (error) {
      phase = 'Failed';
      failure = error instanceof OrchestrationError
        ? { code: error.code, message: error.message, retryable: error.retryable }
        : { code: 'INTERNAL', message: safeErrorMessageFromUnknown(error, { fallback: 'Model gateway failed' }), retryable: false };
      throw error;
    } finally {
      inFlight.delete(request.callId);
      const completedAt = now();
      await record(buildRecord(request, claims, {
        phase,
        usage: {
          inputTokens,
          outputTokens,
          cost: (inputTokens + outputTokens) * costPerToken,
          ...(options.currency !== undefined ? { currency: options.currency } : {}),
        },
        latencyMs: completedAt.getTime() - startedAt.getTime(),
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        ...(failure ? { error: failure } : {}),
      }));
    }
  }

  return {
    async listModels() {
      if (!options.executor.listModels) return [];
      return options.executor.listModels();
    },
    async getHealth() {
      if (options.executor.getHealth) return options.executor.getHealth();
      return { healthy: true, detail: 'model gateway', checkedAt: now().toISOString() };
    },
    generate,
    async cancel(callId: string) {
      await options.executor.cancel?.(callId);
    },
    revokeHandle(handleId: string) {
      options.broker.revokeModelAccessHandle(handleId);
      for (const [callId, entry] of inFlight) {
        if (entry.handleId === handleId) void options.executor.cancel?.(callId);
      }
    },
    revokeRunHandles(runName: string) {
      for (const [handleId, handleRun] of seenHandles) {
        if (handleRun === runName) {
          options.broker.revokeModelAccessHandle(handleId);
          for (const [callId, entry] of inFlight) {
            if (entry.handleId === handleId) void options.executor.cancel?.(callId);
          }
        }
      }
    },
  };
}

// ─── Loop-side adapter: ILLMProvider over the gateway ─────────────────

import { assertPortableLlmRequest, type PortableLlmRequest } from '../../llm/request.js';
import type { PortableLlmStreamPart } from '../../llm/response.js';
import type { ILLMProvider } from '../../types.js';
import type { ModelAccessHandleBudget } from '../security/modelAccessHandle.js';
import type { ModelGenerateMessage } from './modelProviderDriver.js';

export interface GatewayBackedProviderOptions {
  gateway: ModelGateway;
  broker: ModelAccessHandleBroker;
  /** ModelClass the loops are bound to; handles are issued for this model. */
  modelClassRef: ModelAccessHandleClaims['modelClassRef'];
  modelDigest?: string;
  /** Select a declared ModelClass for a request. Unknown explicit ids must fail closed. */
  resolveModelForRequest?: (request: PortableLlmRequest) => {
    modelClassRef: ModelAccessHandleClaims['modelClassRef'];
    modelDigest?: string;
  };
  /** Admission/policy snapshot digest bound into every issued handle. */
  policyDigest?: string;
  /** Worker key fingerprint bound into issued handles (PoP). */
  workerKey?: string;
  /** Static Run binding, or derive one per chat request (e.g. workload runs). */
  runRef?: ModelAccessHandleClaims['runRef'];
  /** Immutable AgentRun attempt bound into issued handles. */
  attempt?: number;
  runRefForRequest?: (request: PortableLlmRequest) => ModelAccessHandleClaims['runRef'] | undefined;
  /** Budget stamped into every issued handle (enforced at the gateway). */
  budget?: ModelAccessHandleBudget;
  /** Per-call handle TTL in milliseconds (broker default applies when unset). */
  handleTtlMs?: number;
  /** Display name/model for the ILLMProvider surface. */
  name?: string;
  modelId?: string;
  model?: unknown;
  /** Customize callId derivation (default: conversationId + sequence). */
  callIdForRequest?: (request: PortableLlmRequest, sequence: number) => string;
}

/**
 * Route loop model calls through the ModelGateway (plan §12.1, 24.35): loops
 * use the canonical `ILLMProvider` surface, and every `chat()` issues a
 * short-lived handle, streams through the gateway's verification, budget
 * enforcement, and audit, and revokes the handle when the call ends (§12.1
 * step 6). No provider key exists on this path by construction.
 */
export function createGatewayMediatedLLMProvider(options: GatewayBackedProviderOptions): ILLMProvider {
  let sequence = 0;
  return {
    name: options.name ?? 'model-gateway',
    modelId: options.modelId ??
      (typeof options.model === 'string' ? options.model : options.modelClassRef.name),
    model: options.model,
    chat(request: PortableLlmRequest) {
      assertPortableLlmRequest(request);
      sequence += 1;
      const conversationId = request.conversationId ?? 'anonymous';
      const callId = options.callIdForRequest?.(request, sequence) ?? `chat-${conversationId}-${sequence}`;
      const messages = request.messages as ModelGenerateMessage[];
      const runReference = options.runRefForRequest?.(request) ?? options.runRef;

      return (async function*(): AsyncGenerator<PortableLlmStreamPart, void, unknown> {
        const selectedModel = options.resolveModelForRequest?.(request) ?? {
          modelClassRef: options.modelClassRef,
          ...(options.modelDigest !== undefined ? { modelDigest: options.modelDigest } : {}),
        };
        const handle = await options.broker.issueModelAccessHandle({
          modelClassRef: selectedModel.modelClassRef,
          ...(selectedModel.modelDigest !== undefined ? { modelDigest: selectedModel.modelDigest } : {}),
          ...(options.policyDigest !== undefined ? { policyDigest: options.policyDigest } : {}),
          ...(runReference ? { runRef: runReference } : {}),
          ...(runReference && options.attempt !== undefined
            ? { attempt: options.attempt }
            : {}),
          ...(options.workerKey !== undefined ? { workerKey: options.workerKey } : {}),
          ...(options.budget !== undefined ? { budget: options.budget } : {}),
          ...(options.handleTtlMs !== undefined ? { ttlMs: options.handleTtlMs } : {}),
        });
        try {
          for await (
            const chunk of options.gateway.generate({
              callId,
              modelClassRef: selectedModel.modelClassRef,
              ...(selectedModel.modelDigest !== undefined ? { modelDigest: selectedModel.modelDigest } : {}),
              messages,
              ...(request.maxOutputTokens === undefined
                ? {}
                : { maxOutputTokens: request.maxOutputTokens }),
              ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
              ...(request.topP === undefined ? {} : { topP: request.topP }),
              ...(request.providerOptions === undefined
                ? {}
                : { providerOptions: request.providerOptions }),
              accessHandle: handle.token,
              ...(options.workerKey !== undefined ? { workerKey: options.workerKey } : {}),
              ...(request.signal === undefined ? {} : { signal: request.signal }),
            })
          ) {
            if (chunk.type === 'delta' && chunk.delta !== undefined) {
              yield { type: 'text-delta', id: `gateway-${sequence}`, text: chunk.delta };
            } else if (chunk.type === 'error') {
              throw new OrchestrationError(
                (chunk.error as OrchestrationErrorData | undefined) ?? {
                  code: 'INTERNAL',
                  message: 'model gateway call failed',
                  retryable: false,
                },
              );
            }
          }
          yield { type: 'finish', finishReason: 'stop' };
        } finally {
          // §12.1 step 6: the handle dies with the call.
          options.broker.revokeModelAccessHandle(handle.claims.handleId);
        }
      })();
    },
  };
}
