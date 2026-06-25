/**
 * Pre-built GOOGLE-VERTEX provider — wraps @ai-sdk/google-vertex.
 *
 * Import from 'memeloop/google-vertex' (bundles only @ai-sdk/google-vertex).
 * Or inject your own via createFetchLLMProvider from 'memeloop'.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — provider package may be at a different AI SDK version than core
import { createVertex } from '@ai-sdk/google-vertex';
import { createFetchLLMProvider, type FetchLLMProviderConfig } from '../fetchProvider.js';
import type { ILLMProvider } from '../../types.js';

// ─── Config ────────────────────────────────────────────────────────────

export interface GoogleVertexProviderConfig extends Omit<FetchLLMProviderConfig, 'createModel'> {
  /** API key or credential. */
  apiKey?: string;
  /** Additional provider-specific options. See @ai-sdk/google-vertex docs. */
  options?: Record<string, unknown>;
}

// ─── Factory ───────────────────────────────────────────────────────────

/**
 * Create an ILLMProvider backed by GOOGLE-VERTEX.
 *
 * @example
 * ```ts
 * import { createGoogleVertexProvider } from 'memeloop/google-vertex';
 * const provider = createGoogleVertexProvider({ name: 'my-google-vertex', apiKey: '...' });
 * ```
 */
export function createGoogleVertexProvider(config: GoogleVertexProviderConfig): ILLMProvider {
  const sdk = createVertex({
    apiKey: config.apiKey,
    ...config.options,
  });
  return createFetchLLMProvider({
    name: config.name,
    // Provider packages may return LanguageModelV1..V4 — cast to satisfy core types
    createModel: (modelId: string) => sdk(modelId) as any,
  });
}
