/**
 * Provider-agnostic LLM provider — wraps any Vercel AI SDK LanguageModelV1.
 *
 * The core does NOT depend on @ai-sdk/openai or any specific provider.
 * Hosts inject their own `createModel` factory:
 *
 *   import { createOpenAI } from '@ai-sdk/openai';
 *   const openai = createOpenAI({ baseURL: '...', apiKey: '...' });
 *   const provider = createFetchLLMProvider({
 *     name: 'openai',
 *     createModel: (id) => openai(id ?? 'gpt-4o-mini'),
 *   });
 *
 * Or for Anthropic:
 *   import { createAnthropic } from '@ai-sdk/anthropic';
 *   const anthropic = createAnthropic({ apiKey: '...' });
 *   const provider = createFetchLLMProvider({
 *     name: 'claude',
 *     createModel: (id) => anthropic(id ?? 'claude-3-5-sonnet-20241022'),
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
  /** Serializable default model identity for scheduling and audit records. */
  modelId?: string;
  /**
   * Factory: given an optional model id, return a LanguageModelV1 from any @ai-sdk/* provider.
   * The factory is responsible for picking a default model when `modelId` is omitted.
   */
  createModel: (modelId?: string) => LanguageModelV1;
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
 * const provider = createFetchLLMProvider({
 *   name: 'openai',
 *   createModel: (modelId) => openai(modelId ?? 'gpt-4o-mini'),
 * });
 * ```
 */
export function createFetchLLMProvider(config: FetchLLMProviderConfig): ILLMProvider {
  return {
    name: config.name,
    ...(config.modelId !== undefined ? { modelId: config.modelId } : {}),
    // Store the factory so hosts can introspect or extend
    model: config.createModel as unknown as LanguageModelV1,
    async chat(request: unknown) {
      const body = (typeof request === 'object' && request !== null ? request : {}) as {
        messages?: Array<{ role: string; content: string }>;
        model?: string;
        stream?: boolean;
        max_tokens?: number;
        temperature?: number;
        system?: string;
        abortSignal?: AbortSignal;
      };

      const model = config.createModel(body.model);

      const messages = (body.messages ?? []).map((message) => {
        // Vercel AI SDK's CoreMessage does not accept a bare 'tool' role.
        // MemeLoop stores tool results as role='tool'; promote them to user
        // messages so the provider receives valid CoreMessages while still
        // preserving the tool-result text in the conversation history.
        const role = message.role === 'tool' ? 'user' : message.role as 'system' | 'user' | 'assistant';
        return {
          role,
          content: message.content,
        };
      });

      const system = body.system;
      const temperature = body.temperature;
      const abortSignal = body.abortSignal;

      if (body.stream !== false) {
        const result = streamText({ model, system, messages, temperature, abortSignal });
        return (async function*() {
          for await (const chunk of result.textStream) {
            yield chunk;
          }
        })();
      }

      const result = await generateText({ model, system, messages, temperature, abortSignal });
      return result.text;
    },
  };
}
