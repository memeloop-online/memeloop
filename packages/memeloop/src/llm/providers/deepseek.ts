/**
 * Pre-built DEEPSEEK provider — wraps @ai-sdk/deepseek.
 *
 * Import from 'memeloop/deepseek' (bundles only @ai-sdk/deepseek).
 * Or inject your own via createFetchLLMProvider from 'memeloop'.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — provider package may be at a different AI SDK version than core
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createFetchLLMProvider, type FetchLLMProviderConfig } from '../fetchProvider.js';
import type { ILLMProvider } from '../../types.js';

// ─── Config ────────────────────────────────────────────────────────────

export interface DeepseekProviderConfig extends Omit<FetchLLMProviderConfig, 'createModel'> {
  /** Override the default API base URL. */
  baseUrl?: string;
  /** API key. */
  apiKey?: string;
}

// ─── Factory ───────────────────────────────────────────────────────────

/**
 * Create an ILLMProvider backed by DEEPSEEK.
 *
 * @example
 * ```ts
 * import { createDeepseekProvider } from 'memeloop/deepseek';
 * const provider = createDeepseekProvider({ name: 'my-deepseek', apiKey: '...' });
 * ```
 */
export function createDeepseekProvider(config: DeepseekProviderConfig): ILLMProvider {
  const sdk = createDeepSeek({
    baseURL: config.baseUrl ?? 'https://api.deepseek.com/v1',
    apiKey: config.apiKey,
  });
  return createFetchLLMProvider({
    name: config.name,
    // Provider packages may return LanguageModelV1..V4 — cast to satisfy core types
    createModel: (modelId: string) => sdk(modelId) as any,
  });
}
