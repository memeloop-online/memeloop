/**
 * TidGi `defineTool.ts` 逐行迁移；持久化改为 `AgentFrameworkContext.persistAgentMessage`（memeloop）。
 */
import type { ChatMessage } from '../conversation/index.js';
import { appendLocalMessageEvent } from '../loopAPI/agent-tool-loop/localMessageEvent.js';
import { findPromptById } from '../promptUtilities/promptConcat.js';
import { TOOL_PARAMETER_PARSE_ERROR_KEY } from '../promptUtilities/responsePatternUtility.js';
import type { ToolCallingMatch } from '../promptUtilities/responsePatternUtility.js';
import type { IPrompt } from '../promptUtilities/types.js';
import { safeErrorMessageFromUnknown } from '../safeError.js';
import { evaluateApproval } from './approval.js';
import type {
  AddToolResultOptions,
  InferToolSchema,
  InjectContentOptions,
  InjectToolListOptions,
  PostProcessHandlerContext,
  ResponseHandlerContext,
  ToolDefinition,
  ToolExecutionResult,
  ToolHandlerContext,
  ToolSchema,
} from './defineToolTypes.js';
import { executeToolCallsParallel, executeToolCallsSequential } from './parallelExecution.js';
import { schemaToToolContent } from './schemaToToolContent.js';
import type { AIResponseContext, DefineToolAgentFrameworkContext, PostProcessContext, PromptConcatHookContext, PromptConcatTool } from './types.js';

const MAX_TOOL_RESULT_CHARS = 32_000;

const logger = {
  debug: (..._a: unknown[]) => {},
  warn: (...a: unknown[]) => {
    console.warn('[memeloop.defineTool]', ...a);
  },
  error: (...a: unknown[]) => {
    console.error('[memeloop.defineTool]', ...a);
  },
};

function requestRuntimeToolApproval(input: {
  context: DefineToolAgentFrameworkContext;
  requestId?: string;
  approvalId: string;
  toolName: string;
  parameters: Record<string, unknown>;
  originalText?: string;
  timeoutMs?: number;
}): Promise<'allow' | 'deny'> {
  const broker = input.context.toolApprovals;
  if (!broker || !input.context.runtimeId) {
    throw new Error('Tool approval requires a runtime-scoped ToolApprovalBroker');
  }
  const conversationId = input.context.agent.id;
  return broker.requestApproval(
    {
      approvalId: input.approvalId,
      runtimeId: input.context.runtimeId,
      runId: input.requestId?.trim() || `${conversationId}:prompt-plugin`,
      conversationId,
      agentId: conversationId,
      toolName: input.toolName,
      parameters: input.parameters,
      originalText: input.originalText,
      created: new Date(),
    },
    {
      timeoutMs: input.timeoutMs ?? 60_000,
      signal: input.context.operationSignal,
    },
  );
}

export type {
  AddToolResultOptions,
  InferToolSchema,
  InjectContentOptions,
  InjectToolListOptions,
  PostProcessHandlerContext,
  ResponseHandlerContext,
  ToolDefinition,
  ToolExecutionResult,
  ToolHandlerContext,
  ToolSchema,
  ToolSchemaInput,
} from './defineToolTypes.js';

export function defineTool<
  TConfigSchema extends ToolSchema,
  TLLMToolSchemas extends Record<string, ToolSchema> = Record<string, ToolSchema>,
>(
  definition: ToolDefinition<TConfigSchema, TLLMToolSchemas>,
  options?: { pluginRegistry?: Map<string, PromptConcatTool> },
): {
  tool: PromptConcatTool;
  toolId: string;
  configSchema: TConfigSchema;
  llmToolSchemas: TLLMToolSchemas | undefined;
  displayName: string;
  description: string;
} {
  const {
    toolId,
    configSchema,
    llmToolSchemas,
    onProcessPrompts,
    onResponseComplete,
    onPostProcess,
  } = definition;
  const parameterKey = `${toolId}Param`;

  const tool: PromptConcatTool = (hooks) => {
    if (onProcessPrompts) {
      hooks.processPrompts.tapAsync(`${toolId}-processPrompts`, async (context, callback) => {
        try {
          const { toolConfig, prompts, messages, agentFrameworkContext, registerModelTool } = context as PromptConcatHookContext;
          agentFrameworkContext.operationSignal?.throwIfAborted();

          if (toolConfig.toolId !== toolId) {
            callback();
            return;
          }

          if (toolConfig.enabled === false) {
            callback();
            return;
          }

          const rawConfig: unknown = toolConfig[parameterKey];
          if (!rawConfig) {
            callback();
            return;
          }

          const config = configSchema.parse(rawConfig) as InferToolSchema<TConfigSchema>;

          const handlerContext: ToolHandlerContext<TConfigSchema> = {
            config,
            toolConfig,
            prompts: prompts,
            messages,
            agentFrameworkContext,
            registerModelTool,

            findPrompt: (id: string) => findPromptById(prompts, id),

            injectToolList: (options: InjectToolListOptions) => {
              const target = findPromptById(prompts, options.targetId);
              if (!target) {
                logger.warn(`Target prompt not found for tool list injection`, {
                  targetId: options.targetId,
                  toolId,
                });
                return;
              }

              const schemas = options.toolSchemas ?? (llmToolSchemas ? Object.values(llmToolSchemas) : []);
              const toolContent = schemas.map((schema) => schemaToToolContent(schema)).join('\n\n');

              const pluginIndex = (context as PromptConcatHookContext).pluginIndex;
              const source = pluginIndex !== undefined ? ['plugins', toolConfig.id] : undefined;

              const toolPrompt: IPrompt = {
                id: `${toolId}-tool-list-${crypto.randomUUID()}`,
                text: toolContent,
                caption: options.caption ?? `${definition.displayName} Tools`,
                enabled: true,
                source,
              };

              if (options.position === 'child') {
                if (!target.prompt.children) {
                  target.prompt.children = [];
                }
                target.prompt.children.push(toolPrompt);
              } else if (options.position === 'before') {
                target.parent.splice(target.index, 0, toolPrompt);
              } else {
                target.parent.splice(target.index + 1, 0, toolPrompt);
              }
            },

            injectContent: (options: InjectContentOptions) => {
              const target = findPromptById(prompts, options.targetId);
              if (!target) {
                logger.warn(`Target prompt not found for content injection`, {
                  targetId: options.targetId,
                  toolId,
                });
                return;
              }

              const pluginIndex = (context as PromptConcatHookContext).pluginIndex;
              const source = pluginIndex !== undefined ? ['plugins', toolConfig.id] : undefined;

              const contentPrompt: IPrompt = {
                id: options.id ?? `${toolId}-content-${crypto.randomUUID()}`,
                text: options.content,
                caption: options.caption ?? 'Injected Content',
                enabled: true,
                source,
              };

              if (options.position === 'child') {
                if (!target.prompt.children) {
                  target.prompt.children = [];
                }
                target.prompt.children.push(contentPrompt);
              } else if (options.position === 'before') {
                target.parent.splice(target.index, 0, contentPrompt);
              } else {
                target.parent.splice(target.index + 1, 0, contentPrompt);
              }
            },
          };

          await onProcessPrompts(handlerContext);
          agentFrameworkContext.operationSignal?.throwIfAborted();
          callback();
        } catch (error) {
          logger.error(
            `Error in ${toolId} processPrompts handler`,
            safeErrorMessageFromUnknown(error, { fallback: 'Prompt handler failed' }),
          );
          callback();
        }
      });
    }

    if (onResponseComplete) {
      hooks.responseComplete.tapAsync(`${toolId}-responseComplete`, async (context, callback) => {
        try {
          const {
            agentFrameworkContext,
            response,
            toolCalls,
            isParallel,
            agentFrameworkConfig,
            requestId,
            toolConfig: directToolConfig,
          } = context as AIResponseContext & {
            toolConfig?: PromptConcatHookContext['toolConfig'];
            actions?: { yieldNextRoundTo?: 'human' | 'self' };
          };

          const configuredToolConfig = agentFrameworkConfig?.plugins?.find(
            (p) => p.toolId === toolId,
          );
          const ourToolConfig = configuredToolConfig ??
            (directToolConfig?.toolId === toolId ? directToolConfig : undefined);

          if (!ourToolConfig) {
            callback();
            return;
          }

          if (ourToolConfig.enabled === false) {
            callback();
            return;
          }

          // A native provider tool call commonly completes with no assistant
          // text.  The canonical call list is authoritative, so empty text is
          // only a no-op when there are no calls either.
          if (response.status !== 'done' || (response.content.length === 0 && toolCalls.length === 0)) {
            callback();
            return;
          }

          // The loop owns protocol parsing and native-stream normalization.
          // Plugins consume that one canonical call list and never re-parse
          // assistant text or manufacture a second tool-call identity.
          const allCalls = toolCalls;
          const toolCall = allCalls.length > 0 ? allCalls[0] : null;

          const rawConfig: unknown = ourToolConfig[parameterKey];
          let config: InferToolSchema<TConfigSchema> | undefined;
          if (rawConfig) {
            try {
              config = configSchema.parse(rawConfig) as InferToolSchema<TConfigSchema>;
            } catch (parseError) {
              logger.warn(`Failed to parse config for ${toolId}`, parseError);
            }
          }

          const pendingMessageWrites: Array<() => Promise<void>> = [];

          const handlerContext: ResponseHandlerContext<TConfigSchema, TLLMToolSchemas> = {
            config,
            toolConfig: ourToolConfig,
            messages: agentFrameworkContext.agent.messages,
            agentFrameworkContext,
            response,
            toolCall,
            allToolCalls: allCalls,
            isParallel,
            agentFrameworkConfig,
            hooks,
            requestId,

            findPrompt: () => undefined,

            injectToolList: () => {
              logger.warn('injectToolList is not available in response phase');
            },

            injectContent: () => {
              logger.warn('injectContent is not available in response phase');
            },

            registerModelTool: () => {
              logger.warn('registerModelTool is not available in response phase');
            },

            executeToolCall: async <TToolName extends keyof TLLMToolSchemas>(
              toolName: TToolName,
              executor: (
                parameters: InferToolSchema<TLLMToolSchemas[TToolName]>,
                signal: AbortSignal,
              ) => Promise<ToolExecutionResult>,
            ): Promise<boolean> => {
              const toolNameString = String(toolName);
              if (!toolCall || toolCall.toolId !== toolNameString) {
                return false;
              }

              const toolSchema = llmToolSchemas?.[toolName];
              if (!toolSchema) {
                logger.error(`No schema found for tool: ${toolNameString}`);
                return false;
              }

              try {
                agentFrameworkContext.operationSignal?.throwIfAborted();
                const parameterParseError = toolCall.parameters[TOOL_PARAMETER_PARSE_ERROR_KEY];
                if (typeof parameterParseError === 'string') {
                  throw new Error(parameterParseError);
                }
                const validatedParameters = toolSchema.parse(
                  toolCall.parameters,
                ) as InferToolSchema<TLLMToolSchemas[TToolName]>;

                const approvalConfig = ourToolConfig.approval;
                const decision = evaluateApproval(
                  approvalConfig,
                  toolNameString,
                  validatedParameters as Record<string, unknown>,
                );
                if (decision === 'deny') {
                  handlerContext.addToolResult({
                    toolName: toolNameString,
                    parameters: validatedParameters,
                    result: 'Tool execution denied by approval policy.',
                    isError: true,
                    duration: 2,
                  });
                  handlerContext.yieldToSelf();
                  return true;
                }
                if (decision === 'pending') {
                  const approvalId = `approval-${crypto.randomUUID()}`;
                  const userDecision = await requestRuntimeToolApproval({
                    context: agentFrameworkContext,
                    requestId,
                    approvalId,
                    toolName: toolNameString,
                    parameters: validatedParameters as Record<string, unknown>,
                    originalText: toolCall.originalText,
                    timeoutMs: approvalConfig?.timeoutMs,
                  });
                  if (userDecision === 'deny') {
                    handlerContext.addToolResult({
                      toolName: toolNameString,
                      parameters: validatedParameters,
                      result: 'Tool execution denied by user.',
                      isError: true,
                      duration: 2,
                    });
                    handlerContext.yieldToSelf();
                    return true;
                  }
                }

                const operationSignal = agentFrameworkContext.operationSignal ?? new AbortController().signal;
                const result = await executor(validatedParameters, operationSignal);
                operationSignal.throwIfAborted();

                const toolResultDuration = (config as { toolResultDuration?: number } | undefined)?.toolResultDuration ?? 1;
                handlerContext.addToolResult({
                  toolName: toolNameString,
                  parameters: validatedParameters,
                  result: result.success
                    ? (result.data ?? 'Success')
                    : (result.error ?? 'Unknown error'),
                  isError: !result.success,
                  duration: toolResultDuration,
                });

                handlerContext.yieldToSelf();

                await hooks.toolExecuted.promise({
                  agentFrameworkContext,
                  toolResult: result,
                  toolInfo: {
                    toolId: toolNameString,
                    parameters: validatedParameters as Record<string, unknown>,
                    originalText: toolCall.originalText,
                  },
                  requestId,
                });

                return true;
              } catch (error) {
                if (agentFrameworkContext.operationSignal?.aborted) {
                  agentFrameworkContext.operationSignal.throwIfAborted();
                }
                const message = safeErrorMessageFromUnknown(error, {
                  fallback: 'Tool execution failed',
                });
                logger.error(`Tool execution failed: ${toolNameString}`, message);

                handlerContext.addToolResult({
                  toolName: toolNameString,
                  parameters: toolCall.parameters,
                  result: message,
                  isError: true,
                  duration: 2,
                });

                handlerContext.yieldToSelf();

                await hooks.toolExecuted.promise({
                  agentFrameworkContext,
                  toolResult: {
                    success: false,
                    error: message,
                  },
                  toolInfo: {
                    toolId: toolNameString,
                    parameters: toolCall.parameters || {},
                  },
                });

                return true;
              }
            },

            addToolResult: (options: AddToolResultOptions) => {
              let resultContent = options.result;
              if (resultContent.length > MAX_TOOL_RESULT_CHARS) {
                const truncated = resultContent.slice(0, MAX_TOOL_RESULT_CHARS);
                resultContent = `${truncated}\n\n[... truncated — result was ${options.result.length} chars, showing first ${MAX_TOOL_RESULT_CHARS}]`;
              }

              const payload: unknown = (() => {
                try {
                  return JSON.parse(resultContent) as unknown;
                } catch {
                  return undefined;
                }
              })();

              pendingMessageWrites.push(async () => {
                const conversationId = agentFrameworkContext.agent.id;
                const latestAiMessage = agentFrameworkContext.agent.messages
                  .filter((message) => message.role === 'assistant')
                  .at(-1);
                if (!latestAiMessage?.turnId) {
                  throw new Error('Tool result requires a user-rooted assistant turnId');
                }
                const messageId = `tool-result-${crypto.randomUUID()}`;
                const toolResultMessage: ChatMessage = await appendLocalMessageEvent(
                  agentFrameworkContext,
                  {
                    conversationId,
                    message: {
                      messageId,
                      turnId: latestAiMessage.turnId,
                      role: 'tool',
                      content: resultContent,
                      parts: [
                        {
                          type: 'tool-result',
                          ...((options.toolCallId ?? toolCall?.toolCallId)
                            ? { toolCallId: options.toolCallId ?? toolCall!.toolCallId }
                            : {}),
                          toolName: options.toolName,
                          parameters: options.parameters,
                          result: resultContent,
                          isError: options.isError ?? false,
                          ...(payload === undefined ? {} : { payload }),
                        },
                      ],
                      duration: options.duration ?? 1,
                      metadata: {
                        isToolResult: true,
                        isError: options.isError ?? false,
                        toolId: options.toolName,
                        toolParameters: options.parameters,
                        isPersisted: false,
                        isComplete: true,
                      },
                    },
                  },
                );

                agentFrameworkContext.agent.messages.push(toolResultMessage);
                toolResultMessage.metadata = {
                  ...toolResultMessage.metadata,
                  isPersisted: true,
                };
              });
            },

            yieldToSelf: () => {
              const context_ = context as { actions?: { yieldNextRoundTo?: 'human' | 'self' } };
              if (!context_.actions) {
                context_.actions = {};
              }
              context_.actions.yieldNextRoundTo = 'self';
            },

            yieldToHuman: () => {
              const context_ = context as { actions?: { yieldNextRoundTo?: 'human' | 'self' } };
              if (!context_.actions) {
                context_.actions = {};
              }
              context_.actions.yieldNextRoundTo = 'human';
            },

            executeAllMatchingToolCalls: async <TToolName extends keyof TLLMToolSchemas>(
              toolName: TToolName,
              executor: (
                parameters: InferToolSchema<TLLMToolSchemas[TToolName]>,
                signal: AbortSignal,
              ) => Promise<ToolExecutionResult>,
              options?: { timeoutMs?: number },
            ): Promise<number> => {
              const toolNameString = String(toolName);
              const matchingCalls = allCalls.filter((call) => call.toolId === toolNameString);
              if (matchingCalls.length === 0) return 0;

              const toolSchema = llmToolSchemas?.[toolName];
              if (!toolSchema) {
                logger.error(`No schema found for tool: ${toolNameString}`);
                return 0;
              }

              const toolResultDuration = (config as { toolResultDuration?: number } | undefined)?.toolResultDuration ?? 1;

              const entries: Array<{
                call: ToolCallingMatch & { found: true };
                executor: (
                  parameters: Record<string, unknown>,
                  signal: AbortSignal,
                ) => Promise<ToolExecutionResult>;
                timeoutMs?: number;
              }> = [];

              const approvalConfig = ourToolConfig.approval;
              const batchDecision = evaluateApproval(
                approvalConfig,
                toolNameString,
                matchingCalls[0]?.parameters ?? {},
              );
              if (batchDecision === 'deny') {
                for (const call of matchingCalls) {
                  handlerContext.addToolResult({
                    toolCallId: call.toolCallId,
                    toolName: toolNameString,
                    parameters: call.parameters,
                    result: 'Tool execution denied by approval policy.',
                    isError: true,
                    duration: toolResultDuration,
                  });
                }
                handlerContext.yieldToSelf();
                return matchingCalls.length;
              }
              if (batchDecision === 'pending') {
                const approvalId = `approval-batch-${crypto.randomUUID()}`;
                const userDecision = await requestRuntimeToolApproval({
                  context: agentFrameworkContext,
                  requestId,
                  approvalId,
                  toolName: toolNameString,
                  parameters: {
                    _batchSize: matchingCalls.length,
                    _firstCallParams: matchingCalls[0]?.parameters,
                  },
                  timeoutMs: approvalConfig?.timeoutMs,
                });
                if (userDecision === 'deny') {
                  for (const call of matchingCalls) {
                    handlerContext.addToolResult({
                      toolCallId: call.toolCallId,
                      toolName: toolNameString,
                      parameters: call.parameters,
                      result: 'Tool execution denied by user.',
                      isError: true,
                      duration: toolResultDuration,
                    });
                  }
                  handlerContext.yieldToSelf();
                  return matchingCalls.length;
                }
              }

              for (const call of matchingCalls) {
                try {
                  const validatedParameters = toolSchema.parse(call.parameters) as InferToolSchema<
                    TLLMToolSchemas[TToolName]
                  >;
                  entries.push({
                    call,
                    executor: async (_parameters, signal) => executor(validatedParameters, signal),
                    timeoutMs: options?.timeoutMs,
                  });
                } catch (validationError) {
                  handlerContext.addToolResult({
                    toolCallId: call.toolCallId,
                    toolName: toolNameString,
                    parameters: call.parameters,
                    result: `Parameter validation failed: ${safeErrorMessageFromUnknown(validationError, { fallback: 'Invalid parameters' })}`,
                    isError: true,
                    duration: toolResultDuration,
                  });
                }
              }

              if (entries.length === 0) return matchingCalls.length;

              let results: Array<{
                call: ToolCallingMatch & { found: true };
                status: string;
                result?: ToolExecutionResult;
                error?: string;
              }>;
              if (isParallel) {
                results = await executeToolCallsParallel(
                  entries,
                  undefined,
                  agentFrameworkContext.operationSignal,
                );
              } else {
                results = await executeToolCallsSequential(
                  entries,
                  agentFrameworkContext.operationSignal,
                );
              }

              for (const result of results) {
                const isError = result.status !== 'fulfilled' ||
                  (result.result !== undefined && !result.result.success);
                const resultText = result.status === 'timeout'
                  ? (result.error ?? 'Tool execution timed out')
                  : result.status === 'rejected'
                  ? (result.error ?? 'Tool execution failed')
                  : result.result?.success
                  ? (result.result.data ?? 'Success')
                  : (result.result?.error ?? 'Unknown error');

                handlerContext.addToolResult({
                  toolCallId: result.call.toolCallId,
                  toolName: toolNameString,
                  parameters: result.call.parameters,
                  result: resultText,
                  isError,
                  duration: toolResultDuration,
                });

                await hooks.toolExecuted.promise({
                  agentFrameworkContext,
                  toolResult: result.result ?? { success: false, error: resultText },
                  toolInfo: {
                    toolId: toolNameString,
                    parameters: result.call.parameters ?? {},
                    originalText: result.call.originalText,
                  },
                  requestId,
                });
              }

              handlerContext.yieldToSelf();
              return matchingCalls.length;
            },
          };

          await onResponseComplete(handlerContext);
          agentFrameworkContext.operationSignal?.throwIfAborted();
          await Promise.all(pendingMessageWrites.map((write) => write()));
          callback();
        } catch (error) {
          logger.error(
            `Error in ${toolId} responseComplete handler`,
            safeErrorMessageFromUnknown(error, { fallback: 'Response handler failed' }),
          );
          callback();
        }
      });
    }

    if (onPostProcess) {
      hooks.postProcess.tapAsync(
        `${toolId}-postProcess`,
        async (context: PostProcessContext, callback) => {
          try {
            const { toolConfig, prompts, messages, agentFrameworkContext, llmResponse, responses } = context;
            agentFrameworkContext.operationSignal?.throwIfAborted();

            if (toolConfig.toolId !== toolId) {
              callback();
              return;
            }

            if (toolConfig.enabled === false) {
              callback();
              return;
            }

            const rawConfig: unknown = toolConfig[parameterKey];
            if (!rawConfig) {
              callback();
              return;
            }

            const config = configSchema.parse(rawConfig) as InferToolSchema<TConfigSchema>;

            const handlerContext: PostProcessHandlerContext<TConfigSchema> = {
              config,
              toolConfig,
              prompts: prompts,
              messages,
              agentFrameworkContext,
              llmResponse,
              responses,

              findPrompt: (id: string) => findPromptById(prompts, id),

              injectToolList: () => {
                logger.warn('injectToolList is not recommended in postProcess phase');
              },

              injectContent: () => {
                logger.warn('injectContent is not recommended in postProcess phase');
              },

              registerModelTool: () => {
                logger.warn('registerModelTool is not available in postProcess phase');
              },
            };

            await onPostProcess(handlerContext);
            agentFrameworkContext.operationSignal?.throwIfAborted();
            callback();
          } catch (error) {
            logger.error(
              `Error in ${toolId} postProcess handler`,
              safeErrorMessageFromUnknown(error, { fallback: 'Post-process handler failed' }),
            );
            callback();
          }
        },
      );
    }
  };

  const destination = options?.pluginRegistry;
  if (destination) {
    if (destination.has(toolId)) {
      throw new Error(`Prompt plugin already registered: ${toolId}`);
    }
    destination.set(toolId, tool);
  }

  return {
    tool,
    toolId,
    configSchema,
    llmToolSchemas,
    displayName: definition.displayName,
    description: definition.description,
  };
}
