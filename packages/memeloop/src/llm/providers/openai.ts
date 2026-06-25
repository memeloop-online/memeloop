/**
 * Pre-built OPENAI provider — wraps @ai-sdk/openai.
 *
 * Import from 'memeloop/openai' (bundles only @ai-sdk/openai).
 * Or inject your own via createFetchLLMProvider from 'memeloop'.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — provider package may be at a different AI SDK version than core
import { createOpenAI } from '@ai-sdk/openai';
import { createFetchLLMProvider, type FetchLLMProviderConfig } from '../fetchProvider.js';
import type { ILLMProvider } from '../../types.js';

// ─── Config ────────────────────────────────────────────────────────────

export interface OpenaiProviderConfig extends Omit<FetchLLMProviderConfig, 'createModel'> {
  /** Override the default API base URL. */
  baseUrl?: string;
  /** API key. */
  apiKey?: string;
}

// ─── Factory ───────────────────────────────────────────────────────────

/**
 * Create an ILLMProvider backed by OPENAI.
 *
 * @example
 * ```ts
 * import { createOpenaiProvider } from 'memeloop/openai';
 * const provider = createOpenaiProvider({ name: 'my-openai', apiKey: '...' });
 * ```
 */
export function createOpenaiProvider(config: OpenaiProviderConfig): ILLMProvider {
  const sdk = createOpenAI({
    baseURL: config.baseUrl ?? 'https://api.openai.com/v1',
    apiKey: config.apiKey,
  });
  return createFetchLLMProvider({
    name: config.name,
    // Provider packages may return LanguageModelV1..V4 — cast to satisfy core types
    createModel: (modelId: string) => sdk(modelId) as any,
  });
}
