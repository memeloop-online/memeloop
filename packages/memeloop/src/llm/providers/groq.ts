/**
 * Pre-built GROQ provider — wraps @ai-sdk/groq.
 *
 * Import from 'memeloop/groq' (bundles only @ai-sdk/groq).
 * Or inject your own via createFetchLLMProvider from 'memeloop'.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — provider package may be at a different AI SDK version than core
import { createGroq } from '@ai-sdk/groq';
import { createFetchLLMProvider, type FetchLLMProviderConfig } from '../fetchProvider.js';
import type { ILLMProvider } from '../../types.js';

// ─── Config ────────────────────────────────────────────────────────────

export interface GroqProviderConfig extends Omit<FetchLLMProviderConfig, 'createModel'> {
  /** Override the default API base URL. */
  baseUrl?: string;
  /** API key. */
  apiKey?: string;
}

// ─── Factory ───────────────────────────────────────────────────────────

/**
 * Create an ILLMProvider backed by GROQ.
 *
 * @example
 * ```ts
 * import { createGroqProvider } from 'memeloop/groq';
 * const provider = createGroqProvider({ name: 'my-groq', apiKey: '...' });
 * ```
 */
export function createGroqProvider(config: GroqProviderConfig): ILLMProvider {
  const sdk = createGroq({
    baseURL: config.baseUrl ?? 'https://api.groq.com/openai/v1',
    apiKey: config.apiKey,
  });
  return createFetchLLMProvider({
    name: config.name,
    // Provider packages may return LanguageModelV1..V4 — cast to satisfy core types
    createModel: (modelId: string) => sdk(modelId) as any,
  });
}
