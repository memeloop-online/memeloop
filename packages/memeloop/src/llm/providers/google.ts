/**
 * Pre-built GOOGLE provider — wraps @ai-sdk/google.
 *
 * Import from 'memeloop/google' (bundles only @ai-sdk/google).
 * Or inject your own via createFetchLLMProvider from 'memeloop'.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — provider package may be at a different AI SDK version than core
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createFetchLLMProvider, type FetchLLMProviderConfig } from '../fetchProvider.js';
import type { ILLMProvider } from '../../types.js';

// ─── Config ────────────────────────────────────────────────────────────

export interface GoogleProviderConfig extends Omit<FetchLLMProviderConfig, 'createModel'> {
  /** Override the default API base URL. */
  baseUrl?: string;
  /** API key. */
  apiKey?: string;
}

// ─── Factory ───────────────────────────────────────────────────────────

/**
 * Create an ILLMProvider backed by GOOGLE.
 *
 * @example
 * ```ts
 * import { createGoogleProvider } from 'memeloop/google';
 * const provider = createGoogleProvider({ name: 'my-google', apiKey: '...' });
 * ```
 */
export function createGoogleProvider(config: GoogleProviderConfig): ILLMProvider {
  const sdk = createGoogleGenerativeAI({
    baseURL: config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: config.apiKey,
  });
  return createFetchLLMProvider({
    name: config.name,
    // Provider packages may return LanguageModelV1..V4 — cast to satisfy core types
    createModel: (modelId: string) => sdk(modelId) as any,
  });
}
