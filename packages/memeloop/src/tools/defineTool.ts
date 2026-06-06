/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TidGi `defineTool.ts` 逐行迁移；持久化改为 `AgentFrameworkContext.persistAgentMessage`（memeloop）。
 */
import type { z } from "zod";

import { matchAllToolCallings } from "../prompt/responsePatternUtility.js";
import type { ToolCallingMatch } from "../prompt/responsePatternUtility.js";
import { findPromptById } from "../prompt/promptConcat.js";
import type { IPrompt } from "../prompt/types.js";
import { evaluateApproval, requestApproval } from "./approval.js";
import type {
  AddToolResultOptions,
  InjectContentOptions,
  InjectToolListOptions,
  PostProcessHandlerContext,
  ResponseHandlerContext,
  ToolDefinition,
  ToolExecutionResult,
  ToolHandlerContext,
} from "./defineToolTypes.js";
import { executeToolCallsParallel, executeToolCallsSequential } from "./parallelExecution.js";
import { getActivePluginRegistry } from "./pluginRegistry.js";
import { schemaToToolContent } from "./schemaToToolContent.js";
import type { AIResponseContext, PromptConcatHookContext, PromptConcatTool } from "./types.js";
import type { ChatMessage } from "../protocol/index.js";

const MAX_TOOL_RESULT_CHARS = 32_000;

const logger = {
  debug: (..._a: unknown[]) => {},
  warn: (...a: unknown[]) => console.warn("[memeloop.defineTool]", ...a),
  error: (...a: unknown[]) => console.error("[memeloop.defineTool]", ...a),
};

export type {
  AddToolResultOptions,
  InjectContentOptions,
  InjectToolListOptions,
  PostProcessHandlerContext,
  ResponseHandlerContext,
  ToolDefinition,
  ToolExecutionResult,
  ToolHandlerContext,
} from "./defineToolTypes.js";

export function defineTool<
  TConfigSchema extends z.ZodType,
  TLLMToolSchemas extends Record<string, z.ZodType> = Record<string, z.ZodType>,
>(
  definition: ToolDefinition<TConfigSchema, TLLMToolSchemas>,
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
          const { toolConfig, prompts, messages, agentFrameworkContext } =
            context as PromptConcatHookContext;

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

          const config = configSchema.parse(rawConfig) as z.infer<TConfigSchema>;

          const handlerContext: ToolHandlerContext<TConfigSchema> = {
            config,
            toolConfig,
            prompts: prompts as IPrompt[],
            messages,
            agentFrameworkContext,

            findPrompt: (id: string) =>
              findPromptById(prompts as Parameters<typeof findPromptById>[0], id),

            injectToolList: (options: InjectToolListOptions) => {
              const target = findPromptById(
                prompts as Parameters<typeof findPromptById>[0],
                options.targetId,
              );
              if (!target) {
                logger.warn(`Target prompt not found for tool list injection`, {
                  targetId: options.targetId,
                  toolId,
                });
                return;
              }

              const schemas =
                options.toolSchemas ?? (llmToolSchemas ? Object.values(llmToolSchemas) : []);
              const toolContent = schemas
                .map((schema) => schemaToToolContent(schema as z.ZodType))
                .join("\n\n");

              const pluginIndex = (context as PromptConcatHookContext).pluginIndex;
              const source = pluginIndex !== undefined ? ["plugins", toolConfig.id] : undefined;

              const toolPrompt: IPrompt = {
                id: `${toolId}-tool-list-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                text: toolContent,
                caption: options.caption ?? `${definition.displayName} Tools`,
                enabled: true,
                source,
              };

              if (options.position === "child") {
                if (!target.prompt.children) {
                  target.prompt.children = [];
                }
                target.prompt.children.push(toolPrompt);
              } else if (options.position === "before") {
                target.parent.splice(target.index, 0, toolPrompt);
              } else {
                target.parent.splice(target.index + 1, 0, toolPrompt);
              }
            },

            injectContent: (options: InjectContentOptions) => {
              const target = findPromptById(
                prompts as Parameters<typeof findPromptById>[0],
                options.targetId,
              );
              if (!target) {
                logger.warn(`Target prompt not found for content injection`, {
                  targetId: options.targetId,
                  toolId,
                });
                return;
              }

              const pluginIndex = (context as PromptConcatHookContext).pluginIndex;
              const source = pluginIndex !== undefined ? ["plugins", toolConfig.id] : undefined;

              const contentPrompt: IPrompt = {
                id:
                  options.id ??
                  `${toolId}-content-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                text: options.content,
                caption: options.caption ?? "Injected Content",
                enabled: true,
                source,
              };

              if (options.position === "child") {
                if (!target.prompt.children) {
                  target.prompt.children = [];
                }
                target.prompt.children.push(contentPrompt);
              } else if (options.position === "before") {
                target.parent.splice(target.index, 0, contentPrompt);
              } else {
                target.parent.splice(target.index + 1, 0, contentPrompt);
              }
            },
          };

          await onProcessPrompts(handlerContext);
          callback();
        } catch (error) {
          logger.error(`Error in ${toolId} processPrompts handler`, error);
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
            agentFrameworkConfig,
            requestId,
            toolConfig: directToolConfig,
          } = context as AIResponseContext & {
            toolConfig?: PromptConcatHookContext["toolConfig"];
            actions?: { yieldNextRoundTo?: "human" | "self" };
          };

          const configuredToolConfig = agentFrameworkConfig?.plugins?.find(
            (p) => p.toolId === toolId,
          );
          const ourToolConfig =
            configuredToolConfig ??
            (directToolConfig?.toolId === toolId ? directToolConfig : undefined);

          if (!ourToolConfig) {
            callback();
            return;
          }

          if (ourToolConfig.enabled === false) {
            callback();
            return;
          }

          if (response.status !== "done" || !response.content) {
            callback();
            return;
          }

          const { calls: allCalls, parallel: isParallel } = matchAllToolCallings(response.content);
          const toolCall = allCalls.length > 0 ? allCalls[0] : null;

          const rawConfig: unknown = ourToolConfig[parameterKey];
          let config: z.infer<TConfigSchema> | undefined;
          if (rawConfig) {
            try {
              config = configSchema.parse(rawConfig) as z.infer<TConfigSchema>;
            } catch (parseError) {
              logger.warn(`Failed to parse config for ${toolId}`, parseError);
            }
          }

          const persist = agentFrameworkContext.persistAgentMessage;

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
              logger.warn("injectToolList is not available in response phase");
            },

            injectContent: () => {
              logger.warn("injectContent is not available in response phase");
            },

            executeToolCall: async <TToolName extends keyof TLLMToolSchemas>(
              toolName: TToolName,
              executor: (
                parameters: z.infer<TLLMToolSchemas[TToolName]>,
              ) => Promise<ToolExecutionResult>,
            ): Promise<boolean> => {
              if (!toolCall || toolCall.toolId !== toolName) {
                return false;
              }

              const toolSchema = llmToolSchemas?.[toolName];
              if (!toolSchema) {
                logger.error(`No schema found for tool: ${String(toolName)}`);
                return false;
              }

              try {
                const validatedParameters = toolSchema.parse(toolCall.parameters);

                const approvalConfig = ourToolConfig.approval as
                  | import("./types.js").ToolApprovalConfig
                  | undefined;
                const decision = evaluateApproval(
                  approvalConfig,
                  String(toolName),
                  validatedParameters as Record<string, unknown>,
                );
                if (decision === "deny") {
                  handlerContext.addToolResult({
                    toolName: String(toolName),
                    parameters: validatedParameters,
                    result: "Tool execution denied by approval policy.",
                    isError: true,
                    duration: 2,
                  });
                  handlerContext.yieldToSelf();
                  return true;
                }
                if (decision === "pending") {
                  const approvalId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                  const userDecision = await requestApproval({
                    approvalId,
                    agentId: agentFrameworkContext.agent.id,
                    toolName: String(toolName),
                    parameters: validatedParameters as Record<string, unknown>,
                    originalText: toolCall.originalText,
                    created: new Date(),
                  });
                  if (userDecision === "deny") {
                    handlerContext.addToolResult({
                      toolName: String(toolName),
                      parameters: validatedParameters,
                      result: "Tool execution denied by user.",
                      isError: true,
                      duration: 2,
                    });
                    handlerContext.yieldToSelf();
                    return true;
                  }
                }

                const result = await executor(validatedParameters);

                const toolResultDuration =
                  (config as { toolResultDuration?: number } | undefined)?.toolResultDuration ?? 1;
                handlerContext.addToolResult({
                  toolName: toolName as string,
                  parameters: validatedParameters,
                  result: result.success
                    ? (result.data ?? "Success")
                    : (result.error ?? "Unknown error"),
                  isError: !result.success,
                  duration: toolResultDuration,
                });

                handlerContext.yieldToSelf();

                await hooks.toolExecuted.promise({
                  agentFrameworkContext,
                  toolResult: result,
                  toolInfo: {
                    toolId: String(toolName),
                    parameters: validatedParameters as Record<string, unknown>,
                    originalText: toolCall.originalText,
                  },
                  requestId,
                });

                return true;
              } catch (error) {
                logger.error(`Tool execution failed: ${String(toolName)}`, error);

                handlerContext.addToolResult({
                  toolName: toolName as string,
                  parameters: toolCall.parameters,
                  result: error instanceof Error ? error.message : String(error),
                  isError: true,
                  duration: 2,
                });

                handlerContext.yieldToSelf();

                await hooks.toolExecuted.promise({
                  agentFrameworkContext,
                  toolResult: {
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                  },
                  toolInfo: {
                    toolId: toolName as string,
                    parameters: toolCall.parameters || {},
                  },
                });

                return true;
              }
            },

            addToolResult: (options: AddToolResultOptions) => {
              const now = new Date();

              let resultContent = options.result;
              if (resultContent.length > MAX_TOOL_RESULT_CHARS) {
                const truncated = resultContent.slice(0, MAX_TOOL_RESULT_CHARS);
                resultContent = `${truncated}\n\n[... truncated — result was ${options.result.length} chars, showing first ${MAX_TOOL_RESULT_CHARS}]`;
              }

              const toolResultText = `<functions_result>
Tool: ${options.toolName}
Parameters: ${JSON.stringify(options.parameters)}
${options.isError ? "Error" : "Result"}: ${resultContent}
</functions_result>`;

              const toolResultMessage: ChatMessage = {
                messageId: `tool-result-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                conversationId: agentFrameworkContext.agent.id,
                originNodeId: "local",
                timestamp: now.getTime(),
                lamportClock: 0,
                role: "tool",
                content: toolResultText,
                duration: options.duration ?? 1,
                metadata: {
                  isToolResult: true,
                  isError: options.isError ?? false,
                  toolId: options.toolName,
                  toolParameters: options.parameters,
                  isPersisted: false,
                  isComplete: true,
                },
              };

              agentFrameworkContext.agent.messages.push(toolResultMessage);

              const aiMessages = agentFrameworkContext.agent.messages.filter(
                (m) => m.role === "assistant",
              );
              if (aiMessages.length > 0) {
                const latestAiMessage = aiMessages[aiMessages.length - 1];
                if (
                  latestAiMessage.content === response.content &&
                  !latestAiMessage.metadata?.containsToolCall
                ) {
                  latestAiMessage.duration = 1;
                  latestAiMessage.metadata = {
                    ...latestAiMessage.metadata,
                    containsToolCall: true,
                    toolId: options.toolName,
                    isPersisted: true,
                  };

                  if (persist) {
                    void (async () => {
                      try {
                        await persist(latestAiMessage);
                      } catch (error) {
                        logger.warn("Failed to persist AI message with tool call", {
                          error,
                          messageId: latestAiMessage.messageId,
                        });
                      }
                    })();
                  }
                }
              }

              if (persist) {
                void (async () => {
                  try {
                    await persist(toolResultMessage);
                    toolResultMessage.metadata = { ...toolResultMessage.metadata, isPersisted: true };
                  } catch (error) {
                    logger.warn("Failed to persist tool result", {
                      error,
                      messageId: toolResultMessage.messageId,
                    });
                  }
                })();
              }
            },

            yieldToSelf: () => {
              const ctx = context as { actions?: { yieldNextRoundTo?: "human" | "self" } };
              if (!ctx.actions) {
                ctx.actions = {};
              }
              ctx.actions.yieldNextRoundTo = "self";
            },

            yieldToHuman: () => {
              const ctx = context as { actions?: { yieldNextRoundTo?: "human" | "self" } };
              if (!ctx.actions) {
                ctx.actions = {};
              }
              ctx.actions.yieldNextRoundTo = "human";
            },

            executeAllMatchingToolCalls: async <TToolName extends keyof TLLMToolSchemas>(
              toolName: TToolName,
              executor: (
                parameters: z.infer<TLLMToolSchemas[TToolName]>,
              ) => Promise<ToolExecutionResult>,
              options?: { timeoutMs?: number },
            ): Promise<number> => {
              const matchingCalls = allCalls.filter((call) => call.toolId === toolName);
              if (matchingCalls.length === 0) return 0;

              const toolSchema = llmToolSchemas?.[toolName];
              if (!toolSchema) {
                logger.error(`No schema found for tool: ${String(toolName)}`);
                return 0;
              }

              const toolResultDuration =
                (config as { toolResultDuration?: number } | undefined)?.toolResultDuration ?? 1;

              const entries: Array<{
                call: ToolCallingMatch & { found: true };
                executor: (parameters: Record<string, unknown>) => Promise<ToolExecutionResult>;
                timeoutMs?: number;
              }> = [];

              const approvalConfig = ourToolConfig.approval as
                | import("./types.js").ToolApprovalConfig
                | undefined;
              const batchDecision = evaluateApproval(
                approvalConfig,
                String(toolName),
                matchingCalls[0]?.parameters ?? {},
              );
              if (batchDecision === "deny") {
                for (const call of matchingCalls) {
                  handlerContext.addToolResult({
                    toolName: String(toolName),
                    parameters: call.parameters,
                    result: "Tool execution denied by approval policy.",
                    isError: true,
                    duration: toolResultDuration,
                  });
                }
                handlerContext.yieldToSelf();
                return matchingCalls.length;
              }
              if (batchDecision === "pending") {
                const approvalId = `approval-batch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                const userDecision = await requestApproval({
                  approvalId,
                  agentId: agentFrameworkContext.agent.id,
                  toolName: String(toolName),
                  parameters: {
                    _batchSize: matchingCalls.length,
                    _firstCallParams: matchingCalls[0]?.parameters,
                  },
                  created: new Date(),
                });
                if (userDecision === "deny") {
                  for (const call of matchingCalls) {
                    handlerContext.addToolResult({
                      toolName: String(toolName),
                      parameters: call.parameters,
                      result: "Tool execution denied by user.",
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
                  const validatedParameters = toolSchema.parse(call.parameters);
                  entries.push({
                    call,
                    executor: async () => executor(validatedParameters),
                    timeoutMs: options?.timeoutMs,
                  });
                } catch (validationError) {
                  handlerContext.addToolResult({
                    toolName: String(toolName),
                    parameters: call.parameters,
                    result: `Parameter validation failed: ${validationError instanceof Error ? validationError.message : String(validationError)}`,
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
                results = await executeToolCallsParallel(entries);
              } else {
                results = await executeToolCallsSequential(entries);
              }

              for (const result of results) {
                const isError =
                  result.status !== "fulfilled" ||
                  (result.result !== undefined && !result.result.success);
                const resultText =
                  result.status === "timeout"
                    ? (result.error ?? "Tool execution timed out")
                    : result.status === "rejected"
                      ? (result.error ?? "Tool execution failed")
                      : result.result?.success
                        ? (result.result.data ?? "Success")
                        : (result.result?.error ?? "Unknown error");

                handlerContext.addToolResult({
                  toolName: String(toolName),
                  parameters: result.call.parameters,
                  result: resultText,
                  isError,
                  duration: toolResultDuration,
                });

                await hooks.toolExecuted.promise({
                  agentFrameworkContext,
                  toolResult: result.result ?? { success: false, error: resultText },
                  toolInfo: {
                    toolId: String(toolName),
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
          callback();
        } catch (error) {
          logger.error(`Error in ${toolId} responseComplete handler`, error);
          callback();
        }
      });
    }

    if (onPostProcess) {
      hooks.postProcess.tapAsync(`${toolId}-postProcess`, async (context, callback) => {
        try {
          const { toolConfig, prompts, messages, agentFrameworkContext, llmResponse, responses } =
            context as any;

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

          const config = configSchema.parse(rawConfig) as z.infer<TConfigSchema>;

          const handlerContext: PostProcessHandlerContext<TConfigSchema> = {
            config,
            toolConfig,
            prompts: prompts as IPrompt[],
            messages,
            agentFrameworkContext,
            llmResponse,
            responses,

            findPrompt: (id: string) =>
              findPromptById(prompts as Parameters<typeof findPromptById>[0], id),

            injectToolList: () => {
              logger.warn("injectToolList is not recommended in postProcess phase");
            },

            injectContent: () => {
              logger.warn("injectContent is not recommended in postProcess phase");
            },
          };

          await onPostProcess(handlerContext);
          callback();
        } catch (error) {
          logger.error(`Error in ${toolId} postProcess handler`, error);
          callback();
        }
      });
    }
  };

  getActivePluginRegistry().set(toolId, tool);

  return {
    tool,
    toolId,
    configSchema,
    llmToolSchemas,
    displayName: definition.displayName,
    description: definition.description,
  };
}
