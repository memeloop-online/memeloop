import { assertPortableLlmRequest, type ILLMProvider, type PortableLlmJsonValue, type PortableLlmRequest, type ProviderAccountConfig } from 'memeloop';
import { createLLMProviderFromAccount } from 'memeloop/llm-providers';

import { normalizeProviderModels, type ProviderEntry, type ProviderModelEntry } from '../config.js';

type ProviderOptions = Record<string, Record<string, PortableLlmJsonValue>>;

export interface ResolvedConfiguredModel {
  apiMode: 'chat-completions' | 'responses';
  id: string;
  model: ProviderModelEntry;
  modelName: string;
}

function positiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

function probability(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a finite number between 0 and 1`);
  }
  return value;
}

function apiMode(model: ProviderModelEntry): 'chat-completions' | 'responses' {
  if (model.apiMode && model.openAIApiMode && model.apiMode !== model.openAIApiMode) {
    throw new Error(`model '${model.id ?? model.name}' has conflicting apiMode values`);
  }
  return model.apiMode ?? model.openAIApiMode ?? 'chat-completions';
}

export function resolveConfiguredModels(entry: ProviderEntry): ResolvedConfiguredModel[] {
  const models = normalizeProviderModels(entry.models);
  return Object.entries(models).map(([id, model]) => {
    const name = model.name?.trim() || id;
    // Array entries follow the official catalog shape: `id` is the wire model
    // id and `name` is a human-readable label. Historic map entries have no
    // embedded id, so their existing `name` remains the wire model id.
    const modelName = model.id?.trim() || name;
    const resolvedMode = apiMode(model);
    positiveInteger(model.limit?.context, `model '${id}' limit.context`);
    positiveInteger(model.limit?.output, `model '${id}' limit.output`);
    positiveInteger(model.maxInputTokens, `model '${id}' maxInputTokens`);
    positiveInteger(model.maxOutputTokens, `model '${id}' maxOutputTokens`);
    probability(model.topP, `model '${id}' topP`);
    const modelOptionTopP = model.modelOptions?.top_p;
    probability(modelOptionTopP, `model '${id}' modelOptions.top_p`);
    return {
      id,
      model: { ...model, name },
      modelName,
      apiMode: resolvedMode,
    };
  });
}

function selectModel(
  models: ResolvedConfiguredModel[],
  requested: unknown,
): ResolvedConfiguredModel | undefined {
  if (typeof requested === 'string' && requested.length > 0) {
    return models.find(model => model.id === requested);
  }
  return models[0];
}

function mergeProviderOptions(
  defaults: ProviderOptions | undefined,
  overrides: ProviderOptions | undefined,
): ProviderOptions | undefined {
  if (!defaults && !overrides) return undefined;
  const result: ProviderOptions = {};
  for (const [namespace, options] of Object.entries(defaults ?? {})) {
    result[namespace] = { ...options };
  }
  for (const [namespace, options] of Object.entries(overrides ?? {})) {
    result[namespace] = { ...result[namespace], ...options };
  }
  return result;
}

/** Apply per-model YAML defaults without overriding explicit call settings. */
export function applyConfiguredModelDefaults(
  entry: ProviderEntry,
  request: PortableLlmRequest,
): PortableLlmRequest {
  const selected = selectModel(resolveConfiguredModels(entry), request.logicalModelId);
  if (!selected) throw new Error(`model '${request.logicalModelId}' is not configured for '${entry.name}'`);
  const model = selected.model;
  const modelOptions = { ...model.modelOptions };
  const optionTopP = modelOptions.top_p;
  delete modelOptions.top_p;
  const optionMaxOutputTokens = modelOptions.max_output_tokens ?? modelOptions.max_tokens;
  delete modelOptions.max_output_tokens;
  delete modelOptions.max_tokens;

  const namespace = selected.apiMode === 'responses' || entry.name === 'openai'
    ? 'openai'
    : entry.name;
  const advancedOptions = { ...modelOptions } as Record<string, PortableLlmJsonValue>;
  if (model.reasoningEffort !== undefined) {
    advancedOptions.reasoningEffort = model.reasoningEffort;
  }
  const defaultProviderOptions = mergeProviderOptions(
    Object.keys(advancedOptions).length > 0
      ? { [namespace]: advancedOptions }
      : undefined,
    model.providerOptions as ProviderOptions | undefined,
  );

  const maxOutputTokens = request.maxOutputTokens ??
    positiveInteger(
      model.maxOutputTokens ?? optionMaxOutputTokens ?? model.limit?.output,
      `model '${selected.id}' maxOutputTokens`,
    );
  const topP = request.topP ?? probability(
    model.topP ?? optionTopP,
    `model '${selected.id}' topP`,
  );
  const configured: unknown = {
    ...request,
    wireModelId: selected.modelName,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(defaultProviderOptions || request.providerOptions
      ? {
        providerOptions: mergeProviderOptions(
          defaultProviderOptions,
          request.providerOptions,
        ),
      }
      : {}),
  };
  // Configuration is host input. Validate the merged request as strictly as
  // the caller-supplied request so provider defaults cannot smuggle an
  // unbounded or non-portable SDK value across the public boundary.
  assertPortableLlmRequest(configured);
  return configured;
}

/**
 * Build one provider facade whose model factory and request defaults dispatch
 * independently for every configured model.
 */
export async function createConfiguredProvider(
  entry: ProviderEntry,
): Promise<ILLMProvider> {
  const models = resolveConfiguredModels(entry);
  if (models.length === 0) {
    throw new Error(`provider '${entry.name}' must configure at least one exact model route`);
  }
  const routes = models.map(model => ({
    modelId: model.id,
    wireModelId: model.modelName,
    apiMode: model.apiMode,
  }));
  const account: ProviderAccountConfig = {
    providerId: entry.name,
    providerType: entry.name,
    ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }),
    models: routes,
  };
  const provider = await createLLMProviderFromAccount(account, {
    apiKey: entry.apiKey,
  });

  const modelFactory = (requested?: string): unknown => {
    const selected = selectModel(models, requested);
    const factory = provider?.model;
    if (selected === undefined || typeof factory !== 'function') {
      throw new Error(`provider '${entry.name}' has no model factory`);
    }
    return (factory as (modelId: string) => unknown)(selected.id);
  };

  return {
    name: entry.name,
    ...(models[0] ? { modelId: models[0].id } : {}),
    model: modelFactory,
    chat(request: unknown) {
      assertPortableLlmRequest(request);
      const body = request;
      if (body.providerId !== entry.name) {
        throw new Error(`provider '${entry.name}' cannot handle '${body.providerId}'`);
      }
      const selected = selectModel(models, body.logicalModelId);
      if (!selected) throw new Error(`model '${body.logicalModelId}' is not configured for '${entry.name}'`);
      if (
        body.apiMode !== selected.apiMode || body.wireModelId !== selected.modelName
      ) throw new Error(`request route does not match configured model '${body.logicalModelId}'`);
      return provider.chat(applyConfiguredModelDefaults(entry, body));
    },
  };
}
