/**
 * Pre-built, config-driven LLM providers.
 *
 * Bundles every major @ai-sdk/* provider into a single entry point so hosts
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
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createCohere } from '@ai-sdk/cohere';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createVertex } from '@ai-sdk/google-vertex';
import { createGroq } from '@ai-sdk/groq';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import { createPerplexity } from '@ai-sdk/perplexity';
import { createTogetherAI } from '@ai-sdk/togetherai';
import { createXai } from '@ai-sdk/xai';
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
  | 'google-vertex';

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
};

// ─── Unified factory ───────────────────────────────────────────────────

/**
 * Create an `ILLMProvider` from a config-driven provider id.
 *
 * Switches implementation based on `config.provider`.
 * All provider-specific SDK packages are bundled into this entry point,
 * so consumers do not need to install them separately.
 */
export function createLLMProvider(config: LLMProviderConfig): ILLMProvider {
  const name = config.name ?? config.provider;

  function resolveModel(modelId?: string): string {
    return modelId ?? config.model ?? defaultModels[config.provider];
  }

  function createModel(modelId?: string): LanguageModelV1 {
    const model = resolveModel(modelId);
    const apiKey = config.apiKey;
    const baseURL = config.baseUrl;
    const options = config.options;

    switch (config.provider) {
      case 'openai': {
        const sdk = createOpenAI({ apiKey, baseURL, ...options });
        return sdk(model) as unknown as LanguageModelV1;
      }
      case 'anthropic': {
        const sdk = createAnthropic({ apiKey, baseURL, ...options });
        return sdk(model) as unknown as LanguageModelV1;
      }
      case 'google': {
        const sdk = createGoogleGenerativeAI({ apiKey, baseURL, ...options });
        return sdk(model) as unknown as LanguageModelV1;
      }
      case 'deepseek': {
        const sdk = createDeepSeek({ apiKey, baseURL, ...options });
        return sdk(model) as unknown as LanguageModelV1;
      }
      case 'groq': {
        const sdk = createGroq({ apiKey, baseURL, ...options });
        return sdk(model) as unknown as LanguageModelV1;
      }
      case 'mistral': {
        const sdk = createMistral({ apiKey, baseURL, ...options });
        return sdk(model) as unknown as LanguageModelV1;
      }
      case 'cohere': {
        const sdk = createCohere({ apiKey, baseURL, ...options });
        return sdk(model) as unknown as LanguageModelV1;
      }
      case 'xai': {
        const sdk = createXai({ apiKey, baseURL, ...options });
        return sdk(model) as unknown as LanguageModelV1;
      }
      case 'togetherai': {
        const sdk = createTogetherAI({ apiKey, baseURL, ...options });
        return sdk(model) as unknown as LanguageModelV1;
      }
      case 'perplexity': {
        const sdk = createPerplexity({ apiKey, baseURL, ...options });
        return sdk(model) as unknown as LanguageModelV1;
      }
      case 'azure': {
        const sdk = createAzure({ apiKey, ...options });
        return sdk(model) as unknown as LanguageModelV1;
      }
      case 'google-vertex': {
        const sdk = createVertex({ ...options });
        return sdk(model) as unknown as LanguageModelV1;
      }
      default: {
        const exhaustive: never = config.provider;
        throw new Error(`Unsupported provider: ${String(exhaustive)}`);
      }
    }
  }

  return createFetchLLMProvider({ name, createModel });
}

// ─── Convenience per-provider factories ────────────────────────────────

type ProviderConfigWithoutId = Omit<LLMProviderConfig, 'provider'>;

/** Convenience factory for OpenAI. */
export function createOpenaiProvider(config: ProviderConfigWithoutId = {}): ILLMProvider {
  return createLLMProvider({ provider: 'openai', ...config });
}

/** Convenience factory for Anthropic. */
export function createAnthropicProvider(config: ProviderConfigWithoutId = {}): ILLMProvider {
  return createLLMProvider({ provider: 'anthropic', ...config });
}

/** Convenience factory for Google Generative AI. */
export function createGoogleProvider(config: ProviderConfigWithoutId = {}): ILLMProvider {
  return createLLMProvider({ provider: 'google', ...config });
}

/** Convenience factory for DeepSeek. */
export function createDeepseekProvider(config: ProviderConfigWithoutId = {}): ILLMProvider {
  return createLLMProvider({ provider: 'deepseek', ...config });
}

/** Convenience factory for Groq. */
export function createGroqProvider(config: ProviderConfigWithoutId = {}): ILLMProvider {
  return createLLMProvider({ provider: 'groq', ...config });
}

/** Convenience factory for Mistral. */
export function createMistralProvider(config: ProviderConfigWithoutId = {}): ILLMProvider {
  return createLLMProvider({ provider: 'mistral', ...config });
}

/** Convenience factory for Cohere. */
export function createCohereProvider(config: ProviderConfigWithoutId = {}): ILLMProvider {
  return createLLMProvider({ provider: 'cohere', ...config });
}

/** Convenience factory for xAI. */
export function createXaiProvider(config: ProviderConfigWithoutId = {}): ILLMProvider {
  return createLLMProvider({ provider: 'xai', ...config });
}

/** Convenience factory for Together AI. */
export function createTogetheraiProvider(config: ProviderConfigWithoutId = {}): ILLMProvider {
  return createLLMProvider({ provider: 'togetherai', ...config });
}

/** Convenience factory for Perplexity. */
export function createPerplexityProvider(config: ProviderConfigWithoutId = {}): ILLMProvider {
  return createLLMProvider({ provider: 'perplexity', ...config });
}

/** Convenience factory for Azure OpenAI. */
export function createAzureProvider(config: ProviderConfigWithoutId = {}): ILLMProvider {
  return createLLMProvider({ provider: 'azure', ...config });
}

/** Convenience factory for Google Vertex. */
export function createGoogleVertexProvider(config: ProviderConfigWithoutId = {}): ILLMProvider {
  return createLLMProvider({ provider: 'google-vertex', ...config });
}
