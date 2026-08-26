import { assertPortableLlmRequest, type PortableLlmMessage, type PortableLlmRequest } from '../../llm/request.js';
import type { PortableLlmStreamPart } from '../../llm/response.js';
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
  role: PortableLlmMessage['role'];
  content: PortableLlmMessage['content'];
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
  providerOptions?: PortableLlmRequest['providerOptions'];
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
  /** Exact model routes served by this adapter; never inferred from slash-delimited strings. */
  routes: Array<{
    modelClassName: string;
    providerId: string;
    logicalModelId: string;
    wireModelId: string;
    apiMode: 'chat-completions' | 'responses';
  }>;
  /** Optional exact projection for specialized hosts; result is always revalidated. */
  toProviderRequest?: (request: ModelGenerateRequest) => PortableLlmRequest;
  /** Extract a text delta from a typed portable stream part; return undefined to skip. */
  toDelta?: (chunk: PortableLlmStreamPart) => string | undefined;
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
  const toProviderRequest = options.toProviderRequest ??
    ((request: ModelGenerateRequest) => {
      const candidates = options.routes.filter(route => route.modelClassName === request.modelClassRef.name);
      if (candidates.length !== 1) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: candidates.length === 0
            ? `model class '${request.modelClassRef.name}' is not served by provider '${provider.name}'`
            : `model class '${request.modelClassRef.name}' is ambiguous for provider '${provider.name}'`,
          retryable: false,
        });
      }
      const route = candidates[0];
      return {
        providerId: route.providerId,
        modelId: route.wireModelId,
        logicalModelId: route.logicalModelId,
        wireModelId: route.wireModelId,
        apiMode: route.apiMode,
        messages: request.messages as PortableLlmMessage[],
        stream: true,
        ...(request.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: request.maxOutputTokens }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.topP === undefined ? {} : { topP: request.topP }),
        ...(request.providerOptions === undefined
          ? {}
          : { providerOptions: request.providerOptions }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      } satisfies PortableLlmRequest;
    });
  const toDelta = options.toDelta ?? ((chunk: PortableLlmStreamPart) => chunk.type === 'text-delta' ? chunk.text : undefined);

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
        const providerRequest = toProviderRequest({ ...request, signal: controller.signal });
        assertPortableLlmRequest(providerRequest);
        const output = await provider.chat(providerRequest);
        if (output != null && typeof output === 'object' && Symbol.asyncIterator in output) {
          for await (const chunk of output) {
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
        } else {
          const delta = toDelta(output);
          if (delta !== undefined) yield { type: 'delta', delta };
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
