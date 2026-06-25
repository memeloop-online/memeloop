/**
 * Pre-built COHERE provider — wraps @ai-sdk/cohere.
 *
 * Import from 'memeloop/cohere' (bundles only @ai-sdk/cohere).
 * Or inject your own via createFetchLLMProvider from 'memeloop'.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — provider package may be at a different AI SDK version than core
import { createCohere } from '@ai-sdk/cohere';
import { createFetchLLMProvider, type FetchLLMProviderConfig } from '../fetchProvider.js';
import type { ILLMProvider } from '../../types.js';

// ─── Config ────────────────────────────────────────────────────────────

export interface CohereProviderConfig extends Omit<FetchLLMProviderConfig, 'createModel'> {
  /** Override the default API base URL. */
  baseUrl?: string;
  /** API key. */
  apiKey?: string;
}

// ─── Factory ───────────────────────────────────────────────────────────

/**
 * Create an ILLMProvider backed by COHERE.
 *
 * @example
 * ```ts
 * import { createCohereProvider } from 'memeloop/cohere';
 * const provider = createCohereProvider({ name: 'my-cohere', apiKey: '...' });
 * ```
 */
export function createCohereProvider(config: CohereProviderConfig): ILLMProvider {
  const sdk = createCohere({
    baseURL: config.baseUrl ?? 'https://api.cohere.com/v1',
    apiKey: config.apiKey,
  });
  return createFetchLLMProvider({
    name: config.name,
    // Provider packages may return LanguageModelV1..V4 — cast to satisfy core types
    createModel: (modelId: string) => sdk(modelId) as any,
  });
}
