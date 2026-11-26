/**
 * TidGi `defineToolTypes.ts` 迁移（路径改为 memeloop）。
 */
import type { PortableLlmJsonValue } from '../llm/request.js';
import type { findPromptById } from '../promptUtilities/promptConcat.js';
import type { ToolCallingMatch } from '../promptUtilities/responsePatternUtility.js';
import type { IPrompt } from '../promptUtilities/types.js';
import type { AIResponseContext, DefineToolAgentFrameworkContext, PostProcessContext, PromptConcatHookContext, PromptConcatHooks, PromptConcatTool } from './types.js';

/**
 * Structural parser contract used at the public tool boundary.
 *
 * Do not expose a concrete validation-library class here.  Zod (and other
 * schema libraries) intentionally carry package-local/private members, so a
 * concrete library-class annotation makes a tool created with a different
 * patch/copy of the same library fail downstream type-checking.  The runtime
 * still accepts and validates the concrete schema instance before executing a
 * tool.
 */
export interface ToolSchema<TOutput = unknown> {
  readonly parse: (data: unknown) => TOutput;
}

/** Detached JSON Schema accepted by prompt/tool-description helpers. */
export type PortableToolJsonSchema = Record<string, PortableLlmJsonValue>;

/** A parser schema or an already detached JSON Schema at a public boundary. */
export type ToolSchemaInput = ToolSchema | PortableToolJsonSchema;

/** Portable result shape for schemas that expose a non-throwing parser. */
export type ToolSchemaSafeParseResult<TOutput> =
  | { readonly success: true; readonly data: TOutput }
  | { readonly success: false; readonly error: unknown };

/** Optional convenience contract used by Core's exported builtin schemas. */
export interface ToolSchemaWithSafeParse<TOutput = unknown> extends ToolSchema<TOutput> {
  readonly safeParse: (data: unknown) => ToolSchemaSafeParseResult<TOutput>;
}

/** Infer the parsed value from any structurally compatible tool schema. */
export type InferToolSchema<TSchema extends ToolSchema> = TSchema extends ToolSchema<infer TOutput> ? TOutput : never;

export interface ToolDefinition<
  TConfigSchema extends ToolSchema = ToolSchema,
  TLLMToolSchemas extends Record<string, ToolSchema> = Record<string, ToolSchema>,
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

export interface ToolHandlerContext<TConfigSchema extends ToolSchema> {
  config: InferToolSchema<TConfigSchema>;
  toolConfig: PromptConcatHookContext['toolConfig'];
  prompts: IPrompt[];
  messages: PromptConcatHookContext['messages'];
  agentFrameworkContext: DefineToolAgentFrameworkContext;
  findPrompt: (id: string) => ReturnType<typeof findPromptById>;
  injectToolList: (options: InjectToolListOptions) => void;
  injectContent: (options: InjectContentOptions) => void;
  registerModelTool: PromptConcatHookContext['registerModelTool'];
}

export interface ResponseHandlerContext<
  TConfigSchema extends ToolSchema,
  TLLMToolSchemas extends Record<string, ToolSchema>,
> extends Omit<ToolHandlerContext<TConfigSchema>, 'prompts' | 'config'> {
  config: InferToolSchema<TConfigSchema> | undefined;
  response: AIResponseContext['response'];
  toolCall: ToolCallingMatch | null;
  allToolCalls: Array<ToolCallingMatch & { found: true }>;
  isParallel: boolean;
  agentFrameworkConfig: AIResponseContext['agentFrameworkConfig'];
  executeToolCall: <TToolName extends keyof TLLMToolSchemas>(
    toolName: TToolName,
    executor: (
      parameters: InferToolSchema<TLLMToolSchemas[TToolName]>,
      signal: AbortSignal,
    ) => Promise<ToolExecutionResult>,
  ) => Promise<boolean>;
  executeAllMatchingToolCalls: <TToolName extends keyof TLLMToolSchemas>(
    toolName: TToolName,
    executor: (
      parameters: InferToolSchema<TLLMToolSchemas[TToolName]>,
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

export interface PostProcessHandlerContext<TConfigSchema extends ToolSchema> extends
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
  toolSchemas?: readonly ToolSchemaInput[];
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
  TConfigSchema extends ToolSchema = ToolSchema,
  TLLMToolSchemas extends Record<string, ToolSchema> = Record<string, ToolSchema>,
> {
  tool: PromptConcatTool;
  toolId: string;
  configSchema: TConfigSchema;
  llmToolSchemas: TLLMToolSchemas | undefined;
  displayName: string;
  description: string;
}
