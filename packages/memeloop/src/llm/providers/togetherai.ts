/**
 * Pre-built TOGETHERAI provider — wraps @ai-sdk/togetherai.
 *
 * Import from 'memeloop/togetherai' (bundles only @ai-sdk/togetherai).
 * Or inject your own via createFetchLLMProvider from 'memeloop'.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — provider package may be at a different AI SDK version than core
import { createTogetherAI } from '@ai-sdk/togetherai';
import { createFetchLLMProvider, type FetchLLMProviderConfig } from '../fetchProvider.js';
import type { ILLMProvider } from '../../types.js';

// ─── Config ────────────────────────────────────────────────────────────

export interface TogetheraiProviderConfig extends Omit<FetchLLMProviderConfig, 'createModel'> {
  /** Override the default API base URL. */
  baseUrl?: string;
  /** API key. */
  apiKey?: string;
}

// ─── Factory ───────────────────────────────────────────────────────────

/**
 * Create an ILLMProvider backed by TOGETHERAI.
 *
 * @example
 * ```ts
 * import { createTogetheraiProvider } from 'memeloop/togetherai';
 * const provider = createTogetheraiProvider({ name: 'my-togetherai', apiKey: '...' });
 * ```
 */
export function createTogetheraiProvider(config: TogetheraiProviderConfig): ILLMProvider {
  const sdk = createTogetherAI({
    baseURL: config.baseUrl ?? 'https://api.together.xyz/v1',
    apiKey: config.apiKey,
  });
  return createFetchLLMProvider({
    name: config.name,
    // Provider packages may return LanguageModelV1..V4 — cast to satisfy core types
    createModel: (modelId: string) => sdk(modelId) as any,
  });
}
