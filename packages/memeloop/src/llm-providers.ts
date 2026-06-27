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

import type { LanguageModelV1 } from 'ai';

import { createFetchLLMProvider } from './llm/fetchProvider.js';
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
}

/** A provider entry from any host config (loose shape used by CLI/Desktop). */
export interface ConfiguredProviderEntry {
  /** Provider id matching LLMProviderId. */
  name: string;
  /** API base URL. */
  baseUrl?: string;
  /** API key. */
  apiKey?: string;
  /** Provider-specific options. */
  options?: Record<string, unknown>;
  /** Available models; the first key is used as the default model. */
  models?: Record<string, { name: string }>;
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

// ─── Unified factory ───────────────────────────────────────────────────

/**
 * Dynamic loader for AI SDK provider factories.
 *
 * Each provider is imported on demand so that hosts only load the SDK packages
 * they actually use. This avoids eagerly loading Node-only providers in hosts
 * that bundle or externalize this entry for multiple runtimes.
 */
async function loadProviderFactory(provider: LLMProviderId): Promise<
  (apiKey: string | undefined, baseUrl: string | undefined, options: Record<string, unknown> | undefined) => (modelId: string) => LanguageModelV1
> {
  switch (provider) {
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return (apiKey, baseUrl, options) => {
        const sdk = createOpenAI({ apiKey, baseURL: baseUrl, ...options });
        return (modelId) => sdk(modelId) as unknown as LanguageModelV1;
      };
    }
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return (apiKey, baseUrl, options) => {
        const sdk = createAnthropic({ apiKey, baseURL: baseUrl, ...options });
        return (modelId) => sdk(modelId) as unknown as LanguageModelV1;
      };
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      return (apiKey, baseUrl, options) => {
        const sdk = createGoogleGenerativeAI({ apiKey, baseURL: baseUrl, ...options });
        return (modelId) => sdk(modelId) as unknown as LanguageModelV1;
      };
    }
    case 'deepseek': {
      const { createDeepSeek } = await import('@ai-sdk/deepseek');
      return (apiKey, baseUrl, options) => {
        const sdk = createDeepSeek({ apiKey, baseURL: baseUrl, ...options });
        return (modelId) => sdk(modelId) as unknown as LanguageModelV1;
      };
    }
    case 'groq': {
      const { createGroq } = await import('@ai-sdk/groq');
      return (apiKey, baseUrl, options) => {
        const sdk = createGroq({ apiKey, baseURL: baseUrl, ...options });
        return (modelId) => sdk(modelId) as unknown as LanguageModelV1;
      };
    }
    case 'mistral': {
      const { createMistral } = await import('@ai-sdk/mistral');
      return (apiKey, baseUrl, options) => {
        const sdk = createMistral({ apiKey, baseURL: baseUrl, ...options });
        return (modelId) => sdk(modelId) as unknown as LanguageModelV1;
      };
    }
    case 'cohere': {
      const { createCohere } = await import('@ai-sdk/cohere');
      return (apiKey, baseUrl, options) => {
        const sdk = createCohere({ apiKey, baseURL: baseUrl, ...options });
        return (modelId) => sdk(modelId) as unknown as LanguageModelV1;
      };
    }
    case 'xai': {
      const { createXai } = await import('@ai-sdk/xai');
      return (apiKey, baseUrl, options) => {
        const sdk = createXai({ apiKey, baseURL: baseUrl, ...options });
        return (modelId) => sdk(modelId) as unknown as LanguageModelV1;
      };
    }
    case 'togetherai': {
      const { createTogetherAI } = await import('@ai-sdk/togetherai');
      return (apiKey, baseUrl, options) => {
        const sdk = createTogetherAI({ apiKey, baseURL: baseUrl, ...options });
        return (modelId) => sdk(modelId) as unknown as LanguageModelV1;
      };
    }
    case 'perplexity': {
      const { createPerplexity } = await import('@ai-sdk/perplexity');
      return (apiKey, baseUrl, options) => {
        const sdk = createPerplexity({ apiKey, baseURL: baseUrl, ...options });
        return (modelId) => sdk(modelId) as unknown as LanguageModelV1;
      };
    }
    case 'azure': {
      const { createAzure } = await import('@ai-sdk/azure');
      return (apiKey, _baseUrl, options) => {
        const sdk = createAzure({ apiKey, ...options });
        return (modelId) => sdk(modelId) as unknown as LanguageModelV1;
      };
    }
    case 'google-vertex': {
      const { createVertex } = await import('@ai-sdk/google-vertex');
      return (_apiKey, _baseUrl, options) => {
        const sdk = createVertex({ ...options });
        return (modelId) => sdk(modelId) as unknown as LanguageModelV1;
      };
    }
    case 'ollama': {
      const { createOllama } = await import('ollama-ai-provider-v2');
      return (_apiKey, baseUrl, options) => {
        const sdk = createOllama({ baseURL: baseUrl, ...options });
        return (modelId) => sdk(modelId) as unknown as LanguageModelV1;
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

  const createProviderModel = await loadProviderFactory(config.provider);
  const modelFactory = createProviderModel(config.apiKey, config.baseUrl, config.options);

  return createFetchLLMProvider({
    name,
    createModel: (modelId?: string) => modelFactory(resolveModel(modelId)),
  });
}

/** Fallback OpenAI-compatible provider for unknown provider ids. */
async function createOpenAICompatibleProvider(config: Omit<LLMProviderConfig, 'provider'> & { provider: string }): Promise<ILLMProvider> {
  const name = config.name ?? config.provider;
  const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');

  function resolveModel(modelId?: string): string {
    return modelId ?? config.model ?? 'gpt-4o-mini';
  }

  const sdk = createOpenAICompatible({
    name: config.provider,
    baseURL: config.baseUrl ?? 'https://api.openai.com/v1',
    apiKey: config.apiKey,
    ...config.options,
  });

  return createFetchLLMProvider({
    name,
    createModel: (modelId?: string) => sdk(resolveModel(modelId)) as unknown as LanguageModelV1,
  });
}

// ─── Convenience per-provider factories ────────────────────────────────

type ProviderConfigWithoutId = Omit<LLMProviderConfig, 'provider'>;

/** Convenience factory for OpenAI. */
export function createOpenaiProvider(config: ProviderConfigWithoutId = {}): Promise<ILLMProvider> {
  return createLLMProvider({ provider: 'openai', ...config });
}

/** Convenience factory for Anthropic. */
export function createAnthropicProvider(config: ProviderConfigWithoutId = {}): Promise<ILLMProvider> {
  return createLLMProvider({ provider: 'anthropic', ...config });
}

/** Convenience factory for Google Generative AI. */
export function createGoogleProvider(config: ProviderConfigWithoutId = {}): Promise<ILLMProvider> {
  return createLLMProvider({ provider: 'google', ...config });
}

/** Convenience factory for DeepSeek. */
export function createDeepseekProvider(config: ProviderConfigWithoutId = {}): Promise<ILLMProvider> {
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
export function createTogetheraiProvider(config: ProviderConfigWithoutId = {}): Promise<ILLMProvider> {
  return createLLMProvider({ provider: 'togetherai', ...config });
}

/** Convenience factory for Perplexity. */
export function createPerplexityProvider(config: ProviderConfigWithoutId = {}): Promise<ILLMProvider> {
  return createLLMProvider({ provider: 'perplexity', ...config });
}

/** Convenience factory for Azure OpenAI. */
export function createAzureProvider(config: ProviderConfigWithoutId = {}): Promise<ILLMProvider> {
  return createLLMProvider({ provider: 'azure', ...config });
}

/** Convenience factory for Google Vertex. */
export function createGoogleVertexProvider(config: ProviderConfigWithoutId = {}): Promise<ILLMProvider> {
  return createLLMProvider({ provider: 'google-vertex', ...config });
}

/** Convenience factory for Ollama. */
export function createOllamaProvider(config: ProviderConfigWithoutId = {}): Promise<ILLMProvider> {
  return createLLMProvider({ provider: 'ollama', ...config });
}

// ─── Host config mapping ───────────────────────────────────────────────

/**
 * Resolve the default model name from a host config entry.
 * Uses the first key in `entry.models` if present, otherwise falls back
 * to the provider-specific default.
 */
export function resolveProviderModelId(entry: ConfiguredProviderEntry): string {
  const firstModelKey = entry.models ? Object.keys(entry.models)[0] : undefined;
  if (firstModelKey) {
    return `${entry.name}/${firstModelKey}`;
  }
  return entry.name;
}

/**
 * Convert a loose host config entry into an `ILLMProvider` via the core registry.
 * Provider id is taken from `entry.name`. Model id is inferred from `entry.models`
 * or the provider-specific default.
 *
 * Unknown provider names fall back to OpenAI-compatible mode, preserving CLI/Desktop
 * behavior where arbitrary OpenAI-compatible endpoints can be configured with any name.
 */
export function createProviderFromEntry(entry: ConfiguredProviderEntry): Promise<ILLMProvider> {
  const providerId = entry.name as LLMProviderId;
  const firstModelKey = entry.models ? Object.keys(entry.models)[0] : undefined;
  const firstModelName = firstModelKey ? entry.models?.[firstModelKey]?.name : undefined;
  const configWithoutProvider = {
    name: entry.name,
    apiKey: entry.apiKey,
    baseUrl: entry.baseUrl,
    model: firstModelName,
    options: entry.options,
  };

  if (!defaultModels[providerId]) {
    return createOpenAICompatibleProvider({ provider: entry.name, ...configWithoutProvider });
  }

  return createLLMProvider({
    provider: providerId,
    ...configWithoutProvider,
  });
}
