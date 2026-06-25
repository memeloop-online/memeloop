/**
 * AI SDK-based LLM provider — wraps @ai-sdk/openai for any OpenAI-compatible API.
 *
 * Zero custom HTTP/SSE code. Streaming, tool calls, and error handling
 * are delegated to the Vercel AI SDK (`ai` + `@ai-sdk/openai`).
 */

import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV1 } from 'ai';
import { generateText, streamText } from 'ai';

import type { ILLMProvider } from '../types.js';

// ─── Config ────────────────────────────────────────────────────────────

export interface FetchLLMProviderConfig {
  /** Display name, e.g. "cloud-proxy" or "openai". */
  name: string;
  /** Base URL of the OpenAI-compatible API (e.g. "https://api.openai.com/v1"). */
  baseUrl: string;
  /** Bearer token. Omit for unauthenticated endpoints. */
  apiKey?: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Provider baseUrl is required');
  // Strip /chat/completions suffix if present — AI SDK appends its own paths
  return trimmed.replace(/\/chat\/completions$/i, '');
}

// ─── Factory ───────────────────────────────────────────────────────────

/**
 * Create an `ILLMProvider` backed by the Vercel AI SDK.
 *
 * - `provider.model` — the `LanguageModelV1` instance (usable with `generateText` / `streamText`)
 * - `provider.chat(request)` — streams text deltas via `streamText`, falls back to `generateText` for non-streaming
 *
 * @example
 * ```ts
 * const provider = createFetchLLMProvider({
 *   name: 'cloud-proxy',
 *   baseUrl: 'https://cloud.example.com/v1',
 *   apiKey: 'sk-...',
 * });
 * ```
 */
export function createFetchLLMProvider(config: FetchLLMProviderConfig): ILLMProvider {
  const baseURL = normalizeBaseUrl(config.baseUrl);

  const sdk = createOpenAI({
    baseURL,
    apiKey: config.apiKey,
  });

  return {
    name: config.name,
    model: sdk as unknown as LanguageModelV1,
    async chat(request: unknown) {
      const body = (typeof request === 'object' && request !== null ? request : {}) as {
        messages?: Array<{ role: string; content: string }>;
        model?: string;
        stream?: boolean;
        max_tokens?: number;
        temperature?: number;
      };

      const messages = (body.messages ?? []).map((message) => ({
        role: message.role as 'system' | 'user' | 'assistant',
        content: message.content,
      }));

      const model = sdk(body.model ?? 'gpt-4o-mini');

      if (body.stream !== false) {
        const result = streamText({ model, messages });
        return (async function*() {
          for await (const chunk of result.textStream) {
            yield chunk;
          }
        })();
      }

      const result = await generateText({ model, messages });
      return result.text;
    },
  };
}
