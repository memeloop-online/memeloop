import {
  assertPortableLlmRequest,
  type ILLMProvider,
  type ModelCatalogModel,
  type PortableLlmRequest,
  type ProviderAccountConfig,
  type ProviderModelRequestDefaults,
} from 'memeloop';
import { createLLMProviderFromAccount } from 'memeloop/llm-providers';
import { getApiKey } from '../auth/authStore.js';

/** Provider implementations bundled by the CLI. Unknown types fail closed. */
const KNOWN_PROVIDER_TYPES = new Set([
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'groq',
  'mistral',
  'cohere',
  'xai',
  'togetherai',
  'perplexity',
  'azure',
  'google-vertex',
  'ollama',
  'openai-compatible',
]);

export interface ResolvedConfiguredModel {
  apiMode: 'chat-completions' | 'responses';
  id: string;
  modelName: string;
  requestDefaults?: Readonly<ProviderModelRequestDefaults>;
  catalogModel?: ModelCatalogModel;
}

function isModelFactory(value: unknown): value is (modelId: string) => unknown {
  return typeof value === 'function';
}

export function resolveConfiguredModels(
  account: ProviderAccountConfig,
): ResolvedConfiguredModel[] {
  const catalogModels = new Map(
    (account.catalogProvider?.models ?? []).map(model => [model.id, model]),
  );
  return account.models.map(route => ({
    id: route.modelId,
    modelName: route.wireModelId,
    apiMode: route.apiMode,
    ...(route.requestDefaults === undefined
      ? {}
      : { requestDefaults: route.requestDefaults }),
    ...(catalogModels.get(route.modelId) === undefined
      ? {}
      : { catalogModel: catalogModels.get(route.modelId) }),
  }));
}

function selectModel(
  models: readonly ResolvedConfiguredModel[],
  requested: unknown,
): ResolvedConfiguredModel | undefined {
  if (typeof requested === 'string' && requested.length > 0) {
    return models.find(model => model.id === requested);
  }
  return models[0];
}

/** Apply the exact canonical route without adding host-only defaults. */
export function applyConfiguredModelDefaults(
  account: ProviderAccountConfig,
  request: PortableLlmRequest,
): PortableLlmRequest {
  const selected = selectModel(resolveConfiguredModels(account), request.logicalModelId);
  if (!selected) {
    throw new Error(
      `model '${request.logicalModelId}' is not configured for '${account.providerId}'`,
    );
  }
  const configured: PortableLlmRequest = {
    ...request,
    wireModelId: selected.modelName,
  };
  assertPortableLlmRequest(configured);
  return configured;
}

/**
 * Build one provider facade whose model factory dispatches exact canonical
 * routes. Provider credentials are resolved by opaque secretRef only.
 */
export async function createConfiguredProvider(
  account: ProviderAccountConfig,
  apiKey = account.secretRef === undefined ? undefined : getApiKey(account.secretRef),
): Promise<ILLMProvider> {
  if (!KNOWN_PROVIDER_TYPES.has(account.providerType)) {
    throw new Error(`unknown provider type '${account.providerType}'`);
  }
  const models = resolveConfiguredModels(account);
  if (models.length === 0) {
    throw new Error(
      `provider '${account.providerId}' must configure at least one exact model route`,
    );
  }
  const provider = await createLLMProviderFromAccount(account, { apiKey });

  const modelFactory = (requested?: string): unknown => {
    const selected = selectModel(models, requested);
    const factory = provider.model;
    if (selected === undefined || !isModelFactory(factory)) {
      throw new Error(`provider '${account.providerId}' has no model factory`);
    }
    return factory(selected.id);
  };

  return {
    name: account.providerId,
    ...(models[0] ? { modelId: models[0].id } : {}),
    model: modelFactory,
    chat(request: unknown) {
      assertPortableLlmRequest(request);
      if (request.providerId !== account.providerId) {
        throw new Error(
          `provider '${account.providerId}' cannot handle '${request.providerId}'`,
        );
      }
      const selected = selectModel(models, request.logicalModelId);
      if (!selected) {
        throw new Error(
          `model '${request.logicalModelId}' is not configured for '${account.providerId}'`,
        );
      }
      if (
        request.apiMode !== selected.apiMode ||
        request.wireModelId !== selected.modelName
      ) {
        throw new Error(
          `request route does not match configured model '${request.logicalModelId}'`,
        );
      }
      return provider.chat(applyConfiguredModelDefaults(account, request));
    },
  };
}
