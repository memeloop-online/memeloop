/**
 * Provider-agnostic LLM provider — wraps a current Vercel AI SDK LanguageModel.
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

import type { JSONValue, LanguageModel } from 'ai';
import { generateText, streamText } from 'ai';

import type { ILLMProvider } from '../types.js';

export interface FetchLLMChatRequest {
  messages?: Array<{ role: string; content: string }>;
  model?: string;
  stream?: boolean;
  /** Legacy OpenAI-compatible spelling retained for host adapters. */
  max_tokens?: number;
  /** AI SDK spelling. Takes precedence over max_tokens. */
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  providerOptions?: Record<string, Record<string, JSONValue>>;
  system?: string;
  abortSignal?: AbortSignal;
}

export function resolveFetchLLMCallSettings(body: FetchLLMChatRequest): {
  maxOutputTokens: number | undefined;
  temperature: number | undefined;
  topP: number | undefined;
  providerOptions: Record<string, Record<string, JSONValue>> | undefined;
  abortSignal: AbortSignal | undefined;
} {
  return {
    maxOutputTokens: body.maxOutputTokens ?? body.max_tokens,
    temperature: body.temperature,
    topP: body.topP,
    providerOptions: body.providerOptions,
    abortSignal: body.abortSignal,
  };
}

// ─── Config ────────────────────────────────────────────────────────────

export interface FetchLLMProviderConfig {
  /** Display name. */
  name: string;
  /** Serializable default model identity for scheduling and audit records. */
  modelId?: string;
  /**
   * Factory: given an optional model id, return a LanguageModel from any @ai-sdk/* provider.
   * The factory is responsible for picking a default model when `modelId` is omitted.
   */
  createModel: (modelId?: string) => LanguageModel;
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
    model: config.createModel,
    async chat(request: unknown) {
      const body = (typeof request === 'object' && request !== null ? request : {}) as FetchLLMChatRequest;

      const model = config.createModel(body.model);
      const specificationVersion = (
        model as { specificationVersion?: unknown } | null
      )?.specificationVersion;
      if (
        model === null ||
        typeof model !== 'object' ||
        !['v2', 'v3', 'v4'].includes(String(specificationVersion))
      ) {
        throw new Error(
          `LLM provider '${config.name}' returned an incompatible AI SDK model for '${
            typeof body.model === 'string' ? body.model : (config.modelId ?? 'default')
          }' (expected specificationVersion v2, v3, or v4; received ${String(specificationVersion)})`,
        );
      }

      const systemMessages = (body.messages ?? [])
        .filter((message) => message.role === 'system')
        .map((message) => message.content);
      const messages = (body.messages ?? [])
        .filter((message) => message.role !== 'system')
        .map((message) => {
          // AI SDK model messages do not accept a bare textual tool role.
          // MemeLoop stores tool results as role='tool'; promote them to user
          // messages while preserving the result text in conversation history.
          const role = message.role === 'tool' ? 'user' : (message.role as 'user' | 'assistant');
          return {
            role,
            content: message.content,
          };
        });

      const system = body.system ?? (
        systemMessages.length > 0 ? systemMessages.join('\n\n') : undefined
      );
      const { abortSignal, maxOutputTokens, providerOptions, temperature, topP } = resolveFetchLLMCallSettings(body);

      if (body.stream !== false) {
        let streamingError: unknown;
        const result = streamText({
          model,
          instructions: system,
          messages,
          maxOutputTokens,
          temperature,
          topP,
          providerOptions,
          abortSignal,
          onError: ({ error }) => {
            streamingError = error;
          },
        });
        return (async function*() {
          for await (const chunk of result.textStream) {
            yield chunk;
          }
          if (streamingError !== undefined) {
            throw streamingError instanceof Error
              ? streamingError
              : new Error('The model stream failed', { cause: streamingError });
          }
        })();
      }

      const result = await generateText({
        model,
        instructions: system,
        messages,
        maxOutputTokens,
        temperature,
        topP,
        providerOptions,
        abortSignal,
      });
      return result.text;
    },
  };
}
