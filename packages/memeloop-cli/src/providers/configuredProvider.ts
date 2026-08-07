import type { ILLMProvider } from 'memeloop';
import { createLLMProvider, createProviderFromEntry } from 'memeloop/llm-providers';

import { normalizeProviderModels, type ProviderEntry, type ProviderModelEntry } from '../config.js';

type ChatRequest = Record<string, unknown> & {
  max_tokens?: number;
  maxOutputTokens?: number;
  model?: string;
  providerOptions?: Record<string, Record<string, unknown>>;
  topP?: number;
};

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
    return models.find(model => model.id === requested || model.modelName === requested);
  }
  return models[0];
}

function mergeProviderOptions(
  defaults: Record<string, Record<string, unknown>> | undefined,
  overrides: Record<string, Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> | undefined {
  if (!defaults && !overrides) return undefined;
  const result: Record<string, Record<string, unknown>> = {};
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
  request: ChatRequest,
): ChatRequest {
  const selected = selectModel(resolveConfiguredModels(entry), request.model);
  if (!selected) return { ...request };
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
  const advancedOptions: Record<string, unknown> = { ...modelOptions };
  if (model.reasoningEffort !== undefined) {
    advancedOptions.reasoningEffort = model.reasoningEffort;
  }
  const defaultProviderOptions = mergeProviderOptions(
    Object.keys(advancedOptions).length > 0
      ? { [namespace]: advancedOptions }
      : undefined,
    model.providerOptions,
  );

  const maxOutputTokens = request.maxOutputTokens ?? request.max_tokens ??
    positiveInteger(
      model.maxOutputTokens ?? optionMaxOutputTokens ?? model.limit?.output,
      `model '${selected.id}' maxOutputTokens`,
    );
  const topP = request.topP ?? probability(
    model.topP ?? optionTopP,
    `model '${selected.id}' topP`,
  );
  return {
    ...request,
    model: selected.modelName,
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
}

/**
 * Build one provider facade whose model factory and request defaults dispatch
 * independently for every configured model.
 */
export async function createConfiguredProvider(
  entry: ProviderEntry,
): Promise<ILLMProvider> {
  const models = resolveConfiguredModels(entry);
  const modelMap = Object.fromEntries(
    models.map(model => [model.id, { name: model.modelName }]),
  );
  const chatProvider = await createProviderFromEntry({
    name: entry.name,
    apiKey: entry.apiKey,
    baseUrl: entry.baseUrl,
    options: entry.options,
    models: modelMap,
  });
  const responsesProvider = models.some(model => model.apiMode === 'responses')
    ? await createLLMProvider({
      provider: 'openai',
      name: entry.name,
      apiKey: entry.apiKey,
      baseUrl: entry.baseUrl,
      options: entry.options,
      model: models[0]?.modelName,
      openAIApiMode: 'responses',
    })
    : undefined;

  const modelFactory = (requested?: string): unknown => {
    const selected = selectModel(models, requested);
    const provider = selected?.apiMode === 'responses'
      ? responsesProvider
      : chatProvider;
    const factory = provider?.model;
    if (typeof factory !== 'function') {
      throw new Error(`provider '${entry.name}' has no model factory`);
    }
    return (factory as (model?: string) => unknown)(selected?.modelName ?? requested);
  };

  return {
    name: entry.name,
    ...(models[0] ? { modelId: models[0].modelName } : {}),
    model: modelFactory,
    chat(request: unknown) {
      const body = (
        typeof request === 'object' && request !== null && !Array.isArray(request)
          ? request
          : {}
      ) as ChatRequest;
      const selected = selectModel(models, body.model);
      const provider = selected?.apiMode === 'responses'
        ? responsesProvider
        : chatProvider;
      if (!provider) throw new Error(`provider '${entry.name}' is unavailable`);
      return provider.chat(applyConfiguredModelDefaults(entry, body));
    },
  };
}

export function resolveConfiguredProviderModelId(entry: ProviderEntry): string {
  const first = resolveConfiguredModels(entry)[0];
  return first ? `${entry.name}/${first.id}` : entry.name;
}
