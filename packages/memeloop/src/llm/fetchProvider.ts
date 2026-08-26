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

import type { JSONValue, LanguageModel, ModelMessage, ToolModelMessage } from 'ai';

import type { ILLMProvider } from '../types.js';
import { assertPortableLlmRequest, type PortableLlmFileData, type PortableLlmMessage, type PortableLlmRequest } from './request.js';
import type { PortableLlmStreamPart } from './response.js';
import { toPortableGenerateResultParts } from './sdkGenerateResultTranslator.js';
import { translateSdkFullStream } from './sdkStreamTranslator.js';

export type FetchLLMChatRequest = PortableLlmRequest;
export type * from './request.js';

export function resolveFetchLLMCallSettings(body: FetchLLMChatRequest): {
  maxOutputTokens: number | undefined;
  temperature: number | undefined;
  topP: number | undefined;
  providerOptions: Record<string, Record<string, JSONValue>> | undefined;
  signal: AbortSignal | undefined;
} {
  return {
    maxOutputTokens: body.maxOutputTokens,
    temperature: body.temperature,
    topP: body.topP,
    providerOptions: body.providerOptions,
    signal: body.signal,
  };
}

// ─── Config ────────────────────────────────────────────────────────────

export interface FetchLLMProviderConfig {
  /** Display name. */
  name: string;
  /** Serializable default model identity for scheduling and audit records. */
  modelId?: string;
  /** Exact wire API implemented by this adapter instance. */
  apiMode: 'chat-completions' | 'responses';
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
      assertPortableLlmRequest(request);
      const body = request;
      if (body.providerId !== config.name) {
        throw new Error(
          `LLM request provider '${body.providerId}' cannot be handled by '${config.name}'`,
        );
      }
      if (body.apiMode !== config.apiMode) {
        throw new Error(
          `LLM request apiMode '${body.apiMode}' cannot be handled by '${config.name}' ` +
            `adapter '${config.apiMode}'`,
        );
      }

      const model = config.createModel(body.wireModelId);
      const specificationVersion = model === null || typeof model !== 'object'
        ? undefined
        : readDataProperty(model, 'specificationVersion');
      if (
        model === null ||
        typeof model !== 'object' ||
        typeof specificationVersion !== 'string' ||
        !['v2', 'v3', 'v4'].includes(specificationVersion)
      ) {
        throw new Error(
          `LLM provider '${config.name}' returned an incompatible AI SDK model for '${body.wireModelId}' (expected specificationVersion v2, v3, or v4; received ${
            describePrimitive(specificationVersion)
          })`,
        );
      }

      const systemMessages = body.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content);
      const messages = body.messages
        .filter((message) => message.role !== 'system')
        .map(toAiSdkMessage);

      const instructions = systemMessages.length > 0 ? systemMessages.join('\n\n') : undefined;
      const { maxOutputTokens, providerOptions, signal, temperature, topP } = resolveFetchLLMCallSettings(body);
      // `ai` is ESM-only. Keep it behind the async chat boundary so portable
      // CommonJS entry points and Jest can load without evaluating the SDK.
      const { generateText, jsonSchema, Output, streamText } = await import('ai');
      const output = body.output
        ? Output.object({
          schema: jsonSchema(body.output.schema),
          ...(body.output.name === undefined ? {} : { name: body.output.name }),
          ...(body.output.description === undefined
            ? {}
            : { description: body.output.description }),
        })
        : undefined;
      const tools = body.tools === undefined
        ? undefined
        : Object.fromEntries(body.tools.map(tool => [tool.name, {
          description: tool.description,
          inputSchema: jsonSchema(tool.inputSchema),
        }]));
      const toolChoice = typeof body.toolChoice === 'object'
        ? { type: 'tool' as const, toolName: body.toolChoice.toolName }
        : body.toolChoice;

      if (body.stream !== false) {
        let streamingError: unknown;
        const result = streamText({
          model,
          instructions,
          messages,
          tools,
          toolChoice,
          maxOutputTokens,
          temperature,
          topP,
          providerOptions,
          abortSignal: signal,
          output,
          onError: ({ error }) => {
            streamingError = error;
          },
        });
        return (async function*() {
          for await (
            const portable of translateSdkFullStream(result.stream, {
              signal,
              getStreamingError: () => streamingError,
            })
          ) {
            yield portable;
          }
        })();
      }

      const result = await generateText({
        model,
        instructions,
        messages,
        tools,
        toolChoice,
        maxOutputTokens,
        temperature,
        topP,
        providerOptions,
        abortSignal: signal,
        output,
      });
      signal?.throwIfAborted();
      const parts = toPortableGenerateResultParts(result, body.output !== undefined);
      return (async function*(): AsyncGenerator<PortableLlmStreamPart, void, unknown> {
        for (const part of parts) {
          signal?.throwIfAborted();
          yield part;
        }
      })();
    },
  };
}

function readDataProperty(value: object, key: string): unknown {
  let current: object | null = value;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      if ('get' in descriptor || 'set' in descriptor) {
        throw new TypeError(`AI SDK model '${key}' must be a data property`);
      }
      return descriptor.value;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function describePrimitive(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `${value}`;
  }
  return typeof value;
}

function toAiSdkMessage(message: Exclude<PortableLlmMessage, { role: 'system' }>): ModelMessage {
  if (typeof message.content === 'string') return message as ModelMessage;
  if (message.role === 'tool') {
    const content: ToolModelMessage['content'] = message.content.map(part => ({
      type: 'tool-result' as const,
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      output: part.output,
    }));
    return {
      role: 'tool',
      content,
    };
  }
  if (message.role === 'user') {
    return {
      role: 'user',
      content: message.content.map(part => {
        if (part.type === 'text') return part;
        if (part.type === 'image') {
          return {
            type: 'image' as const,
            image: toAiSdkImageData(part.data),
            ...(part.mediaType === undefined ? {} : { mediaType: part.mediaType }),
          };
        }
        return {
          type: 'file' as const,
          data: toAiSdkFileData(part.data),
          mediaType: part.mediaType,
          ...(part.filename === undefined ? {} : { filename: part.filename }),
        };
      }),
    } as ModelMessage;
  }
  return {
    role: 'assistant',
    content: message.content.map(part => {
      if (part.type === 'text' || part.type === 'reasoning') return part;
      if (part.type === 'tool-call') {
        return {
          type: 'tool-call' as const,
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        };
      }
      return {
        type: 'file' as const,
        data: toAiSdkFileData(part.data),
        mediaType: part.mediaType,
        ...(part.filename === undefined ? {} : { filename: part.filename }),
      };
    }),
  } as ModelMessage;
}

function toAiSdkImageData(data: PortableLlmFileData): Uint8Array | URL | Record<string, string> {
  switch (data.type) {
    case 'bytes':
      return data.bytes;
    case 'url':
      return new URL(data.url);
    case 'provider-reference':
      return { [data.provider]: data.id };
    case 'text':
      throw new TypeError('image parts cannot use inline text data');
  }
}

function toAiSdkFileData(data: PortableLlmFileData):
  | { type: 'data'; data: Uint8Array }
  | { type: 'url'; url: URL }
  | { type: 'reference'; reference: Record<string, string> }
  | { type: 'text'; text: string }
{
  switch (data.type) {
    case 'bytes':
      return { type: 'data', data: data.bytes };
    case 'url':
      return { type: 'url', url: new URL(data.url) };
    case 'provider-reference':
      return { type: 'reference', reference: { [data.provider]: data.id } };
    case 'text':
      return { type: 'text', text: data.text };
  }
}
