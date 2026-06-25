/**
 * Pre-built MISTRAL provider — wraps @ai-sdk/mistral.
 *
 * Import from 'memeloop/mistral' (bundles only @ai-sdk/mistral).
 * Or inject your own via createFetchLLMProvider from 'memeloop'.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — provider package may be at a different AI SDK version than core
import { createMistral } from '@ai-sdk/mistral';
import { createFetchLLMProvider, type FetchLLMProviderConfig } from '../fetchProvider.js';
import type { ILLMProvider } from '../../types.js';

// ─── Config ────────────────────────────────────────────────────────────

export interface MistralProviderConfig extends Omit<FetchLLMProviderConfig, 'createModel'> {
  /** Override the default API base URL. */
  baseUrl?: string;
  /** API key. */
  apiKey?: string;
}

// ─── Factory ───────────────────────────────────────────────────────────

/**
 * Create an ILLMProvider backed by MISTRAL.
 *
 * @example
 * ```ts
 * import { createMistralProvider } from 'memeloop/mistral';
 * const provider = createMistralProvider({ name: 'my-mistral', apiKey: '...' });
 * ```
 */
export function createMistralProvider(config: MistralProviderConfig): ILLMProvider {
  const sdk = createMistral({
    baseURL: config.baseUrl ?? 'https://api.mistral.ai/v1',
    apiKey: config.apiKey,
  });
  return createFetchLLMProvider({
    name: config.name,
    // Provider packages may return LanguageModelV1..V4 — cast to satisfy core types
    createModel: (modelId: string) => sdk(modelId) as any,
  });
}
