import type { ILLMProvider } from '../../types.js';

import { OrchestrationError } from '../errors.js';
import type { DataClassification, ModelClassSpec } from '../resources.js';

export type { DataClassification } from '../resources.js';

/**
 * Ordered data classifications. A request whose classification exceeds the
 * endpoint's `maxInputClassification` must be rejected before any token leaves
 * the node. Output classification is stamped on the resulting ModelCallRecord.
 */
const CLASSIFICATION_ORDER: Record<DataClassification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

export function classificationRank(value: DataClassification): number {
  return CLASSIFICATION_ORDER[value];
}

export interface ModelProviderDataPolicy {
  /** Requests above this classification are rejected with FORBIDDEN. */
  maxInputClassification?: DataClassification;
  /** Classification stamped on outputs produced by this endpoint. */
  outputClassification?: DataClassification;
}

export function assertClassificationAllowed(
  policy: ModelProviderDataPolicy | undefined,
  classification: DataClassification | undefined,
): void {
  if (!policy?.maxInputClassification || !classification) return;
  if (classificationRank(classification) > classificationRank(policy.maxInputClassification)) {
    throw new OrchestrationError({
      code: 'FORBIDDEN',
      message: `input classification '${classification}' exceeds endpoint limit '${policy.maxInputClassification}'`,
      retryable: false,
      details: { classification, maxInputClassification: policy.maxInputClassification },
    });
  }
}

export interface ModelGenerateMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ModelGenerateRequest {
  /** ModelCallRecord name; correlates the call and anchors idempotency. */
  callId: string;
  modelClassRef: {
    apiVersion: string;
    kind: string;
    name: string;
  };
  /** Required digest from the ModelClass; drivers must not serve a mismatch. */
  modelDigest?: string;
  messages: ModelGenerateMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
  inputClassification?: DataClassification;
  signal?: AbortSignal;
}

export interface ModelStreamChunk {
  type: 'delta' | 'usage' | 'error' | 'done';
  delta?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface ModelProviderHealth {
  healthy: boolean;
  detail?: string;
  checkedAt: string;
}

/**
 * Portable model provider contract. Local runtimes (in-process, ollama) and
 * gateway-mediated remote models implement the same interface; loops select
 * models declaratively via ModelClass/ModelEndpoint and never touch provider
 * SDK objects. Drivers enforce input classification before any token leaves
 * the node.
 */
export interface ModelProviderDriver {
  listModels(): Promise<ModelClassSpec[]>;
  getHealth(): Promise<ModelProviderHealth>;
  generate(request: ModelGenerateRequest): AsyncIterable<ModelStreamChunk>;
  cancel?(callId: string): Promise<void>;
}

export interface LegacyLLMProviderDriverOptions {
  /** ModelClass specs this legacy provider can serve. */
  models: ModelClassSpec[];
  dataPolicy?: ModelProviderDataPolicy;
  /** Map a portable generate request into the legacy provider's request shape. */
  toLegacyRequest?: (request: ModelGenerateRequest) => unknown;
  /** Extract a text delta from a legacy stream chunk; return undefined to skip. */
  toDelta?: (chunk: unknown) => string | undefined;
}

/** Canonical resource name used by local ModelClass registration and routing. */
export function modelClassNameForSpec(model: Pick<ModelClassSpec, 'provider' | 'model'>): string {
  return `${model.provider}-${model.model}`
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'model';
}

/**
 * Adapt an existing `ILLMProvider` to the portable `ModelProviderDriver`
 * contract so current runtimes can be scheduled and policy-enforced without
 * rewriting providers. Classification is enforced in the adapter, before the
 * legacy provider is invoked.
 */
export function createModelProviderDriverFromLLMProvider(
  provider: ILLMProvider,
  options: LegacyLLMProviderDriverOptions,
): ModelProviderDriver {
  const inFlight = new Map<string, AbortController>();
  const toLegacyRequest = options.toLegacyRequest ??
    ((request: ModelGenerateRequest) => {
      const candidates = options.models.filter(model =>
        modelClassNameForSpec(model) === request.modelClassRef.name ||
        model.model === request.modelClassRef.name
      );
      if (candidates.length !== 1) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: candidates.length === 0
            ? `model class '${request.modelClassRef.name}' is not served by provider '${provider.name}'`
            : `model class '${request.modelClassRef.name}' is ambiguous for provider '${provider.name}'`,
          retryable: false,
        });
      }
      return {
        model: candidates[0].model,
        messages: request.messages,
        max_tokens: request.maxOutputTokens,
        temperature: request.temperature,
        topP: request.topP,
        providerOptions: request.providerOptions,
        abortSignal: request.signal,
      };
    });
  const toDelta = options.toDelta ?? ((chunk: unknown) => (typeof chunk === 'string' ? chunk : undefined));

  return {
    async listModels() {
      return options.models;
    },
    async getHealth() {
      return {
        healthy: true,
        detail: `legacy provider ${provider.name}`,
        checkedAt: new Date().toISOString(),
      };
    },
    async *generate(request: ModelGenerateRequest): AsyncIterable<ModelStreamChunk> {
      assertClassificationAllowed(options.dataPolicy, request.inputClassification);
      const controller = new AbortController();
      inFlight.set(request.callId, controller);
      const onExternalAbort = () => {
        controller.abort();
      };
      request.signal?.addEventListener('abort', onExternalAbort);
      try {
        // The driver-owned controller signal reaches the provider, so cancel()
        // aborts in-flight calls regardless of the caller's own signal.
        const legacy = toLegacyRequest({ ...request, signal: controller.signal });
        const output = await provider.chat(legacy);
        if (output != null && typeof output === 'object' && Symbol.asyncIterator in output) {
          for await (const chunk of output as AsyncIterable<unknown>) {
            if (controller.signal.aborted) {
              yield {
                type: 'error',
                error: { code: 'CANCELLED', message: 'generate cancelled', retryable: false },
              };
              return;
            }
            const delta = toDelta(chunk);
            if (delta !== undefined) {
              yield { type: 'delta', delta };
            }
          }
        } else if (typeof output === 'string') {
          yield { type: 'delta', delta: output };
        }
        yield { type: 'done' };
      } finally {
        request.signal?.removeEventListener('abort', onExternalAbort);
        inFlight.delete(request.callId);
      }
    },
    async cancel(callId: string) {
      inFlight.get(callId)?.abort();
    },
  };
}
