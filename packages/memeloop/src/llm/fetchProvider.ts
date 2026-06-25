/**
 * Provider-agnostic LLM provider — wraps any Vercel AI SDK LanguageModelV1.
 *
 * The core does NOT depend on @ai-sdk/openai or any specific provider.
 * Hosts inject their own `createModel` factory:
 *
 *   import { createOpenAI } from '@ai-sdk/openai';
 *   const openai = createOpenAI({ baseURL: '...', apiKey: '...' });
 *   const provider = createAILLMProvider({
 *     name: 'openai',
 *     createModel: (id) => openai(id),
 *   });
 *
 * Or for Anthropic:
 *   import { createAnthropic } from '@ai-sdk/anthropic';
 *   const anthropic = createAnthropic({ apiKey: '...' });
 *   const provider = createAILLMProvider({
 *     name: 'claude',
 *     createModel: (id) => anthropic(id),
 *   });
 *
 * Works with every @ai-sdk/* provider: openai, anthropic, google, deepseek,
 * cohere, mistral, azure, bedrock, groq, ollama, openrouter, together, etc.
 */

import type { LanguageModelV1 } from 'ai';
import { generateText, streamText } from 'ai';

import type { ILLMProvider } from '../types.js';

// ─── Config ────────────────────────────────────────────────────────────

export interface FetchLLMProviderConfig {
  /** Display name. */
  name: string;
  /** Factory: given a model id, return a LanguageModelV1 from any @ai-sdk/* provider. */
  createModel: (modelId: string) => LanguageModelV1;
}

// ─── Factory ───────────────────────────────────────────────────────────

/**
 * Create an `ILLMProvider` that delegates to the Vercel AI SDK.
 *
 * Provider-agnostic — hosts supply their own `createModel` factory.
 * Supports every @ai-sdk/* provider (OpenAI, Anthropic, Google, DeepSeek,
 * Groq, Ollama, OpenRouter, Together, Bedrock, Azure, Mistral, Cohere…).
 *
 * @example
 * ```ts
 * import { createOpenAI } from '@ai-sdk/openai';
 * const openai = createOpenAI({ baseURL: 'https://api.openai.com/v1', apiKey });
 * const provider = createAILLMProvider({
 *   name: 'openai',
 *   createModel: (modelId) => openai(modelId),
 * });
 * ```
 */
export function createFetchLLMProvider(config: FetchLLMProviderConfig): ILLMProvider {
  return {
    name: config.name,
    // Store the factory so hosts can introspect or extend
    model: config.createModel as unknown as LanguageModelV1,
    async chat(request: unknown) {
      const body = (typeof request === 'object' && request !== null ? request : {}) as {
        messages?: Array<{ role: string; content: string }>;
        model?: string;
        stream?: boolean;
        max_tokens?: number;
        temperature?: number;
      };

      const model = config.createModel(body.model ?? 'gpt-4o-mini');

      const messages = (body.messages ?? []).map((message) => ({
        role: message.role as 'system' | 'user' | 'assistant',
        content: message.content,
      }));

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
