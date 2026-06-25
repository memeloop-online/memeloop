/**
 * Pre-built XAI provider — wraps @ai-sdk/xai.
 *
 * Import from 'memeloop/xai' (bundles only @ai-sdk/xai).
 * Or inject your own via createFetchLLMProvider from 'memeloop'.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — provider package may be at a different AI SDK version than core
import { createXai } from '@ai-sdk/xai';
import { createFetchLLMProvider, type FetchLLMProviderConfig } from '../fetchProvider.js';
import type { ILLMProvider } from '../../types.js';

// ─── Config ────────────────────────────────────────────────────────────

export interface XaiProviderConfig extends Omit<FetchLLMProviderConfig, 'createModel'> {
  /** Override the default API base URL. */
  baseUrl?: string;
  /** API key. */
  apiKey?: string;
}

// ─── Factory ───────────────────────────────────────────────────────────

/**
 * Create an ILLMProvider backed by XAI.
 *
 * @example
 * ```ts
 * import { createXaiProvider } from 'memeloop/xai';
 * const provider = createXaiProvider({ name: 'my-xai', apiKey: '...' });
 * ```
 */
export function createXaiProvider(config: XaiProviderConfig): ILLMProvider {
  const sdk = createXai({
    baseURL: config.baseUrl ?? 'https://api.x.ai/v1',
    apiKey: config.apiKey,
  });
  return createFetchLLMProvider({
    name: config.name,
    // Provider packages may return LanguageModelV1..V4 — cast to satisfy core types
    createModel: (modelId: string) => sdk(modelId) as any,
  });
}
