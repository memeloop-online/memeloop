/**
 * Pre-built, config-driven LLM providers.
 *
 * Exposes every major @ai-sdk/* provider through a single entry point so hosts
 * can switch providers by changing a string in user config — no need to install
 * AI SDK packages individually.
 *
 * ```ts
 * import { createLLMProvider } from 'memeloop/llm-providers';
 *
 * const provider = createLLMProvider({
 *   provider: 'openai',
 *   baseUrl: 'https://api.openai.com/v1',
 *   apiKey: process.env.OPENAI_API_KEY,
 *   model: 'gpt-4o',
 * });
 * ```
 *
 * For custom providers, or to keep bundle size minimal, use the generic
 * `createFetchLLMProvider` exported from `memeloop` and supply your own
 * `createModel` factory.
 *
 * `createLLMProvider` is async because it dynamically imports the selected
 * AI SDK provider on first use. Host bundlers can then decide whether to
 * bundle, split, or externalize those provider dependencies for their runtime.
 */

import type { LanguageModel } from 'ai';

import { createFetchLLMProvider } from './llm/fetchProvider.js';
import { normalizeProviderAccountConfig, type ProviderAccountConfig } from './llm/providerAccount.js';
import type { ProviderModelRoute } from './llm/providerRegistry.js';
import { assertPortableLlmRequest } from './llm/request.js';
import type { ILLMProvider } from './types.js';

// ─── Provider ids ──────────────────────────────────────────────────────

export type LLMProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek'
  | 'groq'
  | 'mistral'
  | 'cohere'
  | 'xai'
  | 'togetherai'
  | 'perplexity'
  | 'azure'
  | 'google-vertex'
  | 'ollama';

// ─── Config ────────────────────────────────────────────────────────────

export interface LLMProviderConfig {
  /** Provider id. */
  provider: LLMProviderId;
  /** Display name (defaults to provider id). */
  name?: string;
  /** API key or credential. */
  apiKey?: string;
  /** Override the provider's default API base URL. */
  baseUrl?: string;
  /** Default model id. When omitted a provider-specific default is used. */
  model?: string;
  /** Provider-specific options passed through to the AI SDK factory. */
  options?: Record<string, unknown>;
  /** OpenAI wire API selected for this model. Defaults to Chat Completions. */
  openAIApiMode?: 'chat-completions' | 'responses';
}

// ─── Defaults ──────────────────────────────────────────────────────────

const defaultModels: Record<LLMProviderId, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-sonnet-20241022',
  google: 'gemini-1.5-flash',
  deepseek: 'deepseek-chat',
  groq: 'llama-3.1-8b-instant',
  mistral: 'mistral-small-latest',
  cohere: 'command-r-plus',
  xai: 'grok-beta',
  togetherai: 'meta-llama/Llama-3.1-8B-Instruct-Turbo',
  perplexity: 'sonar',
  azure: '',
  'google-vertex': '',
  ollama: 'llama3.1',
};

const knownProviderTypes: ReadonlySet<string> = new Set(Object.keys(defaultModels));

function isKnownProviderType(providerType: string): providerType is LLMProviderId {
  return knownProviderTypes.has(providerType);
}

// ─── Unified factory ───────────────────────────────────────────────────

/**
 * Dynamic loader for AI SDK provider factories.
 *
 * Each provider is imported on demand so that hosts only load the SDK packages
 * they actually use. This avoids eagerly loading Node-only providers in hosts
 * that bundle or externalize this entry for multiple runtimes.
 */
async function loadProviderFactory(
  provider: LLMProviderId,
  openAIApiMode: LLMProviderConfig['openAIApiMode'],
): Promise<
  (
    apiKey: string | undefined,
    baseUrl: string | undefined,
    options: Record<string, unknown> | undefined,
  ) => (modelId: string) => LanguageModel
> {
  switch (provider) {
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return (apiKey, baseUrl, options) => {
        const sdk = createOpenAI({ apiKey, baseURL: baseUrl, ...options });
        // Keep Chat Completions as the compatibility default. Hosts may opt a
        // specific model into Responses without splitting a shared provider.
        return (modelId) => openAIApiMode === 'responses' ? sdk.responses(modelId) : sdk.chat(modelId);
      };
    }
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return (apiKey, baseUrl, options) => {
        const sdk = createAnthropic({ apiKey, baseURL: baseUrl, ...options });
        return (modelId) => sdk(modelId);
      };
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      return (apiKey, baseUrl, options) => {
        const sdk = createGoogleGenerativeAI({ apiKey, baseURL: baseUrl, ...options });
        return (modelId) => sdk(modelId);
      };
    }
    case 'deepseek': {
      const { createDeepSeek } = await import('@ai-sdk/deepseek');
      return (apiKey, baseUrl, options) => {
        const sdk = createDeepSeek({ apiKey, baseURL: baseUrl, ...options });
        return (modelId) => sdk(modelId);
      };
    }
    case 'groq': {
      const { createGroq } = await import('@ai-sdk/groq');
      return (apiKey, baseUrl, options) => {
        const sdk = createGroq({ apiKey, baseURL: baseUrl, ...options });
        return (modelId) => sdk(modelId);
      };
    }
    case 'mistral': {
      const { createMistral } = await import('@ai-sdk/mistral');
      return (apiKey, baseUrl, options) => {
        const sdk = createMistral({ apiKey, baseURL: baseUrl, ...options });
        return (modelId) => sdk(modelId);
      };
    }
    case 'cohere': {
      const { createCohere } = await import('@ai-sdk/cohere');
      return (apiKey, baseUrl, options) => {
        const sdk = createCohere({ apiKey, baseURL: baseUrl, ...options });
        return (modelId) => sdk(modelId);
      };
    }
    case 'xai': {
      const { createXai } = await import('@ai-sdk/xai');
      return (apiKey, baseUrl, options) => {
        const sdk = createXai({ apiKey, baseURL: baseUrl, ...options });
        return (modelId) => sdk(modelId);
      };
    }
    case 'togetherai': {
      const { createTogetherAI } = await import('@ai-sdk/togetherai');
      return (apiKey, baseUrl, options) => {
        const sdk = createTogetherAI({ apiKey, baseURL: baseUrl, ...options });
        return (modelId) => sdk(modelId);
      };
    }
    case 'perplexity': {
      const { createPerplexity } = await import('@ai-sdk/perplexity');
      return (apiKey, baseUrl, options) => {
        const sdk = createPerplexity({ apiKey, baseURL: baseUrl, ...options });
        return (modelId) => sdk(modelId);
      };
    }
    case 'azure': {
      const { createAzure } = await import('@ai-sdk/azure');
      return (apiKey, _baseUrl, options) => {
        const sdk = createAzure({ apiKey, ...options });
        return (modelId) => sdk(modelId);
      };
    }
    case 'google-vertex': {
      const { createVertex } = await import('@ai-sdk/google-vertex');
      return (_apiKey, _baseUrl, options) => {
        const sdk = createVertex({ ...options });
        return (modelId) => sdk(modelId);
      };
    }
    case 'ollama': {
      const { createOllama } = await import('ollama-ai-provider-v2');
      return (_apiKey, baseUrl, options) => {
        const sdk = createOllama({ baseURL: baseUrl, ...options });
        return (modelId) => sdk(modelId);
      };
    }
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unsupported provider: ${String(exhaustive)}`);
    }
  }
}

/**
 * Create an `ILLMProvider` from a config-driven provider id.
 *
 * Switches implementation based on `config.provider`.
 * The selected provider's AI SDK package is loaded on demand, so hosts only
 * pay the dependency cost for providers they actually use.
 */
export async function createLLMProvider(config: LLMProviderConfig): Promise<ILLMProvider> {
  const name = config.name ?? config.provider;

  function resolveModel(modelId?: string): string {
    return modelId ?? config.model ?? defaultModels[config.provider] ?? '';
  }

  const createProviderModel = await loadProviderFactory(config.provider, config.openAIApiMode);
  const modelFactory = createProviderModel(config.apiKey, config.baseUrl, config.options);

  return createFetchLLMProvider({
    name,
    modelId: resolveModel(),
    apiMode: config.openAIApiMode ?? 'chat-completions',
    createModel: (modelId?: string) => modelFactory(resolveModel(modelId)),
  });
}

export interface LLMProviderAccountRouteInput {
  /** Persisted, credential-free account configuration. */
  account: ProviderAccountConfig;
  /** One exact route declared by `account.models`. */
  route: ProviderModelRoute;
  /** Runtime-only credential resolved by the host's secret store. */
  apiKey?: string;
}

export interface LLMProviderAccountCredentialOptions {
  /** Explicit runtime credential. Takes precedence over `resolveSecret`. */
  apiKey?: string;
  /** Resolve the account's opaque `secretRef` without persisting the result. */
  resolveSecret?: (
    secretReference: string,
  ) => string | undefined | Promise<string | undefined>;
}

/**
 * Construct a provider facade for every exact route in one canonical account.
 * Each route owns a cached SDK adapter, so accounts may safely mix Chat
 * Completions and Responses models behind one logical provider id.
 */
export async function createLLMProviderFromAccount(
  accountInput: ProviderAccountConfig,
  credentials: LLMProviderAccountCredentialOptions = {},
): Promise<ILLMProvider> {
  const account = normalizeProviderAccountConfig(accountInput);
  if (account.enabled === false) {
    throw new Error(`provider account '${account.providerId}' is disabled`);
  }
  if (account.models.length === 0) {
    throw new Error(`provider account '${account.providerId}' must declare at least one model route`);
  }
  assertCompatibleBaseUrl(account);
  if (credentials.apiKey !== undefined && typeof credentials.apiKey !== 'string') {
    throw new TypeError('apiKey must be a string when provided');
  }
  if (
    credentials.resolveSecret !== undefined &&
    typeof credentials.resolveSecret !== 'function'
  ) {
    throw new TypeError('resolveSecret must be a function when provided');
  }
  const apiKey = credentials.apiKey ?? (
    account.secretRef === undefined || credentials.resolveSecret === undefined
      ? undefined
      : await credentials.resolveSecret(account.secretRef)
  );
  if (apiKey !== undefined && typeof apiKey !== 'string') {
    throw new TypeError('resolved API key must be a string when provided');
  }

  const routeProviders = new Map<string, ILLMProvider>();
  await Promise.all(account.models.map(async route => {
    routeProviders.set(
      route.modelId,
      await createLLMProviderFromAccountRoute({
        account,
        route,
        apiKey,
      }),
    );
  }));

  const defaultRoute = account.models[0];
  return {
    name: account.providerId,
    modelId: defaultRoute.modelId,
    model(modelId?: string) {
      const logicalModelId = modelId ?? defaultRoute.modelId;
      const provider = routeProviders.get(logicalModelId);
      const modelFactory: unknown = provider?.model;
      if (typeof modelFactory !== 'function') {
        throw new Error(
          `model '${logicalModelId}' is not configured for '${account.providerId}'`,
        );
      }
      return (modelFactory as () => unknown)();
    },
    chat(request: unknown) {
      assertPortableLlmRequest(request);
      if (request.providerId !== account.providerId) {
        throw new Error(
          `provider '${account.providerId}' cannot handle '${request.providerId}'`,
        );
      }
      const route = account.models.find(
        candidate => candidate.modelId === request.logicalModelId,
      );
      if (
        route === undefined || route.wireModelId !== request.wireModelId ||
        route.apiMode !== request.apiMode
      ) {
        throw new Error(
          `request route does not match configured model '${account.providerId}/${request.logicalModelId}'`,
        );
      }
      return routeProviders.get(route.modelId)!.chat(request);
    },
  };
}

/**
 * Construct one Node-only provider adapter for one canonical account route.
 *
 * The returned provider retains the logical `route.modelId` for scheduling and
 * audit records, while the SDK only receives `route.wireModelId`. Credentials
 * are runtime arguments and are never copied into the normalized account.
 */
export async function createLLMProviderFromAccountRoute(
  input: LLMProviderAccountRouteInput,
): Promise<ILLMProvider> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('provider account route input must be an object');
  }
  if (input.apiKey !== undefined && typeof input.apiKey !== 'string') {
    throw new TypeError('apiKey must be a string when provided');
  }

  const account = normalizeProviderAccountConfig(input.account);
  if (account.enabled === false) {
    throw new Error(`provider account '${account.providerId}' is disabled`);
  }
  assertCompatibleBaseUrl(account);
  // Normalize the route independently so accessors, exotic prototypes, extra
  // fields, and malformed values cannot be compared against trusted account
  // data. Reusing the canonical account validator keeps both schemas exact.
  const requestedRoute = normalizeProviderAccountConfig({
    providerId: account.providerId,
    providerType: account.providerType,
    models: [input.route],
  }).models[0];
  const route = account.models.find(candidate =>
    candidate.modelId === requestedRoute.modelId &&
    candidate.wireModelId === requestedRoute.wireModelId &&
    candidate.apiMode === requestedRoute.apiMode
  );
  if (route === undefined) {
    throw new Error(
      `model route '${requestedRoute.modelId}' is not an exact member of provider account '${account.providerId}'`,
    );
  }

  const createModel = await createAccountRouteModelFactory({
    account,
    route,
    apiKey: input.apiKey,
  });
  const delegate = createFetchLLMProvider({
    name: account.providerId,
    modelId: route.modelId,
    apiMode: route.apiMode,
    // This adapter owns exactly one route. Never let a caller substitute a
    // second wire model through the generic ILLMProvider model hook.
    createModel: () => createModel(route.wireModelId),
  });

  return {
    ...delegate,
    modelId: route.modelId,
    model: () => createModel(route.wireModelId),
    chat(request: unknown) {
      assertPortableLlmRequest(request);
      if (
        request.providerId !== account.providerId ||
        request.logicalModelId !== route.modelId ||
        request.wireModelId !== route.wireModelId ||
        request.apiMode !== route.apiMode
      ) {
        throw new Error(
          `request route does not match configured model '${account.providerId}/${route.modelId}'`,
        );
      }
      return delegate.chat(request);
    },
  };
}

function assertCompatibleBaseUrl(account: Readonly<ProviderAccountConfig>): void {
  if (
    !isKnownProviderType(account.providerType) &&
    account.baseUrl === undefined
  ) {
    throw new Error(
      `OpenAI-compatible provider account '${account.providerId}' requires an explicit baseUrl`,
    );
  }
}

async function createAccountRouteModelFactory(input: {
  account: Readonly<ProviderAccountConfig>;
  route: Readonly<ProviderModelRoute>;
  apiKey?: string;
}): Promise<(wireModelId: string) => LanguageModel> {
  const { account, apiKey, route } = input;
  if (isKnownProviderType(account.providerType)) {
    const createProviderModel = await loadProviderFactory(account.providerType, route.apiMode);
    return createProviderModel(apiKey, account.baseUrl, undefined);
  }

  const baseUrl = account.baseUrl;
  if (baseUrl === undefined) {
    throw new Error(
      `OpenAI-compatible provider account '${account.providerId}' requires an explicit baseUrl`,
    );
  }

  // The generic compatible SDK currently implements Chat Completions only.
  // For a declared Responses route, use the OpenAI SDK's compatible baseURL
  // support so the selected wire protocol remains exact.
  if (route.apiMode === 'responses') {
    const { createOpenAI } = await import('@ai-sdk/openai');
    const sdk = createOpenAI({
      apiKey,
      baseURL: baseUrl,
    });
    return wireModelId => sdk.responses(wireModelId);
  }

  const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
  const sdk = createOpenAICompatible({
    name: account.providerId,
    baseURL: baseUrl,
    apiKey,
  });
  return wireModelId => sdk(wireModelId);
}

// ─── Convenience per-provider factories ────────────────────────────────

type ProviderConfigWithoutId = Omit<LLMProviderConfig, 'provider'>;

/** Convenience factory for OpenAI. */
export function createOpenaiProvider(config: ProviderConfigWithoutId = {}): Promise<ILLMProvider> {
  return createLLMProvider({ provider: 'openai', ...config });
}

/** Convenience factory for Anthropic. */
export function createAnthropicProvider(
  config: ProviderConfigWithoutId = {},
): Promise<ILLMProvider> {
  return createLLMProvider({ provider: 'anthropic', ...config });
}

/** Convenience factory for Google Generative AI. */
export function createGoogleProvider(config: ProviderConfigWithoutId = {}): Promise<ILLMProvider> {
  return createLLMProvider({ provider: 'google', ...config });
}

/** Convenience factory for DeepSeek. */
export function createDeepseekProvider(
  config: ProviderConfigWithoutId = {},
): Promise<ILLMProvider> {
  return createLLMProvider({ provider: 'deepseek', ...config });
}

/** Convenience factory for Groq. */
export function createGroqProvider(config: ProviderConfigWithoutId = {}): Promise<ILLMProvider> {
  return createLLMProvider({ provider: 'groq', ...config });
}

/** Convenience factory for Mistral. */
export function createMistralProvider(config: ProviderConfigWithoutId = {}): Promise<ILLMProvider> {
  return createLLMProvider({ provider: 'mistral', ...config });
}

/** Convenience factory for Cohere. */
export function createCohereProvider(config: ProviderConfigWithoutId = {}): Promise<ILLMProvider> {
  return createLLMProvider({ provider: 'cohere', ...config });
}

/** Convenience factory for xAI. */
export function createXaiProvider(config: ProviderConfigWithoutId = {}): Promise<ILLMProvider> {
  return createLLMProvider({ provider: 'xai', ...config });
}

/** Convenience factory for Together AI. */
export function createTogetheraiProvider(
  config: ProviderConfigWithoutId = {},
): Promise<ILLMProvider> {
  return createLLMProvider({ provider: 'togetherai', ...config });
}

/** Convenience factory for Perplexity. */
export function createPerplexityProvider(
  config: ProviderConfigWithoutId = {},
): Promise<ILLMProvider> {
  return createLLMProvider({ provider: 'perplexity', ...config });
}

/** Convenience factory for Azure OpenAI. */
export function createAzureProvider(config: ProviderConfigWithoutId = {}): Promise<ILLMProvider> {
  return createLLMProvider({ provider: 'azure', ...config });
}

/** Convenience factory for Google Vertex. */
export function createGoogleVertexProvider(
  config: ProviderConfigWithoutId = {},
): Promise<ILLMProvider> {
  return createLLMProvider({ provider: 'google-vertex', ...config });
}

/** Convenience factory for Ollama. */
export function createOllamaProvider(config: ProviderConfigWithoutId = {}): Promise<ILLMProvider> {
  return createLLMProvider({ provider: 'ollama', ...config });
}
