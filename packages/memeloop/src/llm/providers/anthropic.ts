/**
 * Pre-built ANTHROPIC provider — wraps @ai-sdk/anthropic.
 *
 * Import from 'memeloop/anthropic' (bundles only @ai-sdk/anthropic).
 * Or inject your own via createFetchLLMProvider from 'memeloop'.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — provider package may be at a different AI SDK version than core
import { createAnthropic } from '@ai-sdk/anthropic';
import { createFetchLLMProvider, type FetchLLMProviderConfig } from '../fetchProvider.js';
import type { ILLMProvider } from '../../types.js';

// ─── Config ────────────────────────────────────────────────────────────

export interface AnthropicProviderConfig extends Omit<FetchLLMProviderConfig, 'createModel'> {
  /** Override the default API base URL. */
  baseUrl?: string;
  /** API key. */
  apiKey?: string;
}

// ─── Factory ───────────────────────────────────────────────────────────

/**
 * Create an ILLMProvider backed by ANTHROPIC.
 *
 * @example
 * ```ts
 * import { createAnthropicProvider } from 'memeloop/anthropic';
 * const provider = createAnthropicProvider({ name: 'my-anthropic', apiKey: '...' });
 * ```
 */
export function createAnthropicProvider(config: AnthropicProviderConfig): ILLMProvider {
  const sdk = createAnthropic({
    baseURL: config.baseUrl ?? 'https://api.anthropic.com/v1',
    apiKey: config.apiKey,
  });
  return createFetchLLMProvider({
    name: config.name,
    // Provider packages may return LanguageModelV1..V4 — cast to satisfy core types
    createModel: (modelId: string) => sdk(modelId) as any,
  });
}
