/**
 * TidGi `defineToolTypes.ts` 迁移（路径改为 memeloop）。
 */
import type { z } from 'zod';

import type { findPromptById } from '../promptUtilities/promptConcat.js';
import type { ToolCallingMatch } from '../promptUtilities/responsePatternUtility.js';
import type { IPrompt } from '../promptUtilities/types.js';
import type { AIResponseContext, DefineToolAgentFrameworkContext, PostProcessContext, PromptConcatHookContext, PromptConcatHooks, PromptConcatTool } from './types.js';

export interface ToolDefinition<
  TConfigSchema extends z.ZodType = z.ZodType,
  TLLMToolSchemas extends Record<string, z.ZodType> = Record<string, z.ZodType>,
> {
  toolId: string;
  displayName: string;
  description: string;
  configSchema: TConfigSchema;
  llmToolSchemas?: TLLMToolSchemas;
  onProcessPrompts?: (context: ToolHandlerContext<TConfigSchema>) => Promise<void> | void;
  onResponseComplete?: (
    context: ResponseHandlerContext<TConfigSchema, TLLMToolSchemas>,
  ) => Promise<void> | void;
  onPostProcess?: (context: PostProcessHandlerContext<TConfigSchema>) => Promise<void> | void;
}

export interface ToolHandlerContext<TConfigSchema extends z.ZodType> {
  config: z.infer<TConfigSchema>;
  toolConfig: PromptConcatHookContext['toolConfig'];
  prompts: IPrompt[];
  messages: PromptConcatHookContext['messages'];
  agentFrameworkContext: DefineToolAgentFrameworkContext;
  findPrompt: (id: string) => ReturnType<typeof findPromptById>;
  injectToolList: (options: InjectToolListOptions) => void;
  injectContent: (options: InjectContentOptions) => void;
}

export interface ResponseHandlerContext<
  TConfigSchema extends z.ZodType,
  TLLMToolSchemas extends Record<string, z.ZodType>,
> extends Omit<ToolHandlerContext<TConfigSchema>, 'prompts' | 'config'> {
  config: z.infer<TConfigSchema> | undefined;
  response: AIResponseContext['response'];
  toolCall: ToolCallingMatch | null;
  allToolCalls: Array<ToolCallingMatch & { found: true }>;
  isParallel: boolean;
  agentFrameworkConfig: AIResponseContext['agentFrameworkConfig'];
  executeToolCall: <TToolName extends keyof TLLMToolSchemas>(
    toolName: TToolName,
    executor: (
      parameters: z.infer<TLLMToolSchemas[TToolName]>,
      signal: AbortSignal,
    ) => Promise<ToolExecutionResult>,
  ) => Promise<boolean>;
  executeAllMatchingToolCalls: <TToolName extends keyof TLLMToolSchemas>(
    toolName: TToolName,
    executor: (
      parameters: z.infer<TLLMToolSchemas[TToolName]>,
      signal: AbortSignal,
    ) => Promise<ToolExecutionResult>,
    options?: { timeoutMs?: number },
  ) => Promise<number>;
  addToolResult: (options: AddToolResultOptions) => void;
  yieldToSelf: () => void;
  yieldToHuman: () => void;
  hooks: PromptConcatHooks;
  requestId?: string;
}

export interface PostProcessHandlerContext<TConfigSchema extends z.ZodType> extends
  Omit<
    ToolHandlerContext<TConfigSchema>,
    never
  >
{
  llmResponse: string;
  responses: PostProcessContext['responses'];
}

export interface InjectToolListOptions {
  targetId: string;
  position: 'before' | 'after' | 'child';
  toolSchemas?: z.ZodType[];
  caption?: string;
}

export interface InjectContentOptions {
  targetId: string;
  position: 'before' | 'after' | 'child';
  content: string;
  caption?: string;
  id?: string;
}

export interface AddToolResultOptions {
  toolCallId?: string;
  toolName: string;
  parameters: unknown;
  result: string;
  isError?: boolean;
  duration?: number;
}

export interface ToolExecutionResult {
  success: boolean;
  data?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface DefinedTool<
  TConfigSchema extends z.ZodType = z.ZodType,
  TLLMToolSchemas extends Record<string, z.ZodType> = Record<string, z.ZodType>,
> {
  tool: PromptConcatTool;
  toolId: string;
  configSchema: TConfigSchema;
  llmToolSchemas: TLLMToolSchemas | undefined;
  displayName: string;
  description: string;
}
