/**
 * Pre-built PERPLEXITY provider — wraps @ai-sdk/perplexity.
 *
 * Import from 'memeloop/perplexity' (bundles only @ai-sdk/perplexity).
 * Or inject your own via createFetchLLMProvider from 'memeloop'.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — provider package may be at a different AI SDK version than core
import { createPerplexity } from '@ai-sdk/perplexity';
import { createFetchLLMProvider, type FetchLLMProviderConfig } from '../fetchProvider.js';
import type { ILLMProvider } from '../../types.js';

// ─── Config ────────────────────────────────────────────────────────────

export interface PerplexityProviderConfig extends Omit<FetchLLMProviderConfig, 'createModel'> {
  /** Override the default API base URL. */
  baseUrl?: string;
  /** API key. */
  apiKey?: string;
}

// ─── Factory ───────────────────────────────────────────────────────────

/**
 * Create an ILLMProvider backed by PERPLEXITY.
 *
 * @example
 * ```ts
 * import { createPerplexityProvider } from 'memeloop/perplexity';
 * const provider = createPerplexityProvider({ name: 'my-perplexity', apiKey: '...' });
 * ```
 */
export function createPerplexityProvider(config: PerplexityProviderConfig): ILLMProvider {
  const sdk = createPerplexity({
    baseURL: config.baseUrl ?? 'https://api.perplexity.ai',
    apiKey: config.apiKey,
  });
  return createFetchLLMProvider({
    name: config.name,
    // Provider packages may return LanguageModelV1..V4 — cast to satisfy core types
    createModel: (modelId: string) => sdk(modelId) as any,
  });
}
