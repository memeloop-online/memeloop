/**
 * Pre-built, config-driven LLM providers.
 *
 * Exposes every major @ai-sdk/* provider through a single entry point so hosts
 * can switch providers by changing a string in user config — no need to install
 * AI SDK packages individually.
 *
 * Hosts persist a canonical `ProviderAccountConfig` and one exact
 * `ProviderModelRoute` per model. `createLLMProviderFromAccount` and
 * `createLLMProviderFromAccountRoute` are the only config-driven factories;
 * credentials remain runtime arguments and route `apiMode` selects the exact
 * upstream wire API.
 */

import type { LanguageModel } from 'ai';

import { createFetchLLMProvider } from './llm/fetchProvider.js';
import { applyProviderModelRouteDefaults } from './llm/prepareModelRequest.js';
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

const knownProviderTypes: ReadonlySet<string> = new Set<LLMProviderId>([
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
]);

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
  apiMode: ProviderModelRoute['apiMode'],
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
        // Select the exact upstream API declared by this model route.
        return (modelId) => apiMode === 'responses' ? sdk.responses(modelId) : sdk.chat(modelId);
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
      return routeProviders.get(route.modelId)!.chat(
        applyProviderModelRouteDefaults(route, request),
      );
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
      return delegate.chat(applyProviderModelRouteDefaults(route, request));
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
