/**
 * Pre-built AZURE provider — wraps @ai-sdk/azure.
 *
 * Import from 'memeloop/azure' (bundles only @ai-sdk/azure).
 * Or inject your own via createFetchLLMProvider from 'memeloop'.
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — provider package may be at a different AI SDK version than core
import { createAzure } from '@ai-sdk/azure';
import { createFetchLLMProvider, type FetchLLMProviderConfig } from '../fetchProvider.js';
import type { ILLMProvider } from '../../types.js';

// ─── Config ────────────────────────────────────────────────────────────

export interface AzureProviderConfig extends Omit<FetchLLMProviderConfig, 'createModel'> {
  /** API key or credential. */
  apiKey?: string;
  /** Additional provider-specific options. See @ai-sdk/azure docs. */
  options?: Record<string, unknown>;
}

// ─── Factory ───────────────────────────────────────────────────────────

/**
 * Create an ILLMProvider backed by AZURE.
 *
 * @example
 * ```ts
 * import { createAzureProvider } from 'memeloop/azure';
 * const provider = createAzureProvider({ name: 'my-azure', apiKey: '...' });
 * ```
 */
export function createAzureProvider(config: AzureProviderConfig): ILLMProvider {
  const sdk = createAzure({
    apiKey: config.apiKey,
    ...config.options,
  });
  return createFetchLLMProvider({
    name: config.name,
    // Provider packages may return LanguageModelV1..V4 — cast to satisfy core types
    createModel: (modelId: string) => sdk(modelId) as any,
  });
}
