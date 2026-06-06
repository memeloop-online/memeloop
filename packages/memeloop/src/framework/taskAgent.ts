import type { ChatMessage } from "../protocol/index.js";

import { executeHooks, hasHooks } from "../hooks/registry.js";
import type { AgentStopData } from "../hooks/types.js";
import { responseConcat } from "../prompt/responseConcat.js";
import { matchAllToolCallings, type ToolCallingMatch } from "../prompt/responsePatternUtility.js";
import { nextLamportClockForConversation } from "../storage/nextLamport.js";
import {
  createHooksWithPlugins,
  resolvePromptPluginMap,
  runResponseCompleteHooks,
} from "../tools/pluginRegistry.js";
import type { DefineToolAgentFrameworkContext } from "../tools/types.js";
import type { AgentFrameworkContext } from "../types.js";

export type { TaskAgentGenerator, TaskAgentInput, TaskAgentStep } from "./taskAgentContract.js";
import { prepareIterationHistory } from "./historyCompaction.js";
import { chunkToText, streamLlm } from "./llmStream.js";
import {
  buildLlmMessages,
  inferDefinitionId,
  resolveAgentDefinitionModel,
} from "./modelMessages.js";
import type { TaskAgentGenerator, TaskAgentInput, TaskAgentStep } from "./taskAgentContract.js";
import { runRegistryToolCalls } from "./toolCallRunner.js";
import { gateToolCallsWithPreToolUse } from "./toolUseGate.js";

const DEFAULT_MAX_ITERATIONS = 256;

function toolCallHandledInAgentMessages(
  agentMessages: ChatMessage[],
  assistantContent: string,
  call: ToolCallingMatch & { found: true },
): boolean {
  let assistantIndex = -1;
  for (let index = agentMessages.length - 1; index >= 0; index--) {
    const m = agentMessages[index];
    if (m.role === "assistant" && m.content === assistantContent) {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 0) return false;
  const after = agentMessages.slice(assistantIndex + 1);
  return after.some(
    (m) =>
      m.role === "tool" &&
      (m.metadata?.toolId === call.toolId ||
        (typeof m.content === "string" && m.content.includes(`Tool: ${call.toolId}`))),
  );
}

/**
 * TaskAgent：TidGi `basicPromptConcatHandler` 对齐版。
 *
 * - defineTool：`createHooksWithPlugins` + `responseComplete` + `responseConcat`（postProcess）
 * - 回退：`IToolRegistry` 执行未被插件处理的 tool 调用
 */
export function createTaskAgent(
  context: AgentFrameworkContext,
): (input: TaskAgentInput) => TaskAgentGenerator {
  return async function* taskAgent(input: TaskAgentInput): TaskAgentGenerator {
    let agentStarted = false;
    let agentStopped = false;
    let stopReason: AgentStopData["reason"] | undefined;
    const markStop = (reason: AgentStopData["reason"]): void => {
      stopReason ??= reason;
    };
    const finishThinking = (
      reason: AgentStopData["reason"],
      data: Record<string, unknown>,
    ): TaskAgentStep => {
      markStop(reason);
      return { type: "thinking", data };
    };
    const options = context.taskAgent ?? {};
    const enableToolLoop = options.enableToolLoop !== false;
    const fallbackRegistry = options.fallbackRegistryTools !== false;
    const maxIterations =
      options.maxIterations != null && options.maxIterations > 0
        ? options.maxIterations
        : DEFAULT_MAX_ITERATIONS;
    const checkpointOptions = options.sessionCheckpoint;

    try {
      const now = Date.now();
      const lamportClock = await nextLamportClockForConversation(
        context.storage,
        input.conversationId,
      );
      const userMessage: ChatMessage = {
        messageId: `${input.conversationId}:${now.toString(36)}`,
        conversationId: input.conversationId,
        originNodeId: "local",
        timestamp: now,
        lamportClock,
        role: "user",
        content: input.message,
      };

      // Resume session: load previous messages before appending new user message
      if (input.resumeSession && input.resumeSession.length > 0) {
        // Insert resume messages into storage (skip duplicates via messageId)
        await context.storage.insertMessagesIfAbsent(input.resumeSession);
      }

      await context.storage.appendMessage(userMessage);

      // Execute UserPromptSubmit hooks
      if (hasHooks("UserPromptSubmit")) {
        const hookResult = await executeHooks("UserPromptSubmit", context, {
          message: input.message,
          conversationId: input.conversationId,
        });
        if (!hookResult.allowed) {
          yield {
            type: "thinking",
            data: {
              status: "blocked",
              conversationId: input.conversationId,
              reason: hookResult.reason ?? "Blocked by UserPromptSubmit hook",
            },
          };
          return;
        }
      }

      const initialDefinitionId = await inferDefinitionId(context.storage, input.conversationId);
      if (hasHooks("AgentStart")) {
        const hookResult = await executeHooks("AgentStart", context, {
          conversationId: input.conversationId,
          definitionId: initialDefinitionId,
        });
        if (!hookResult.allowed) {
          yield {
            type: "thinking",
            data: {
              status: "blocked",
              conversationId: input.conversationId,
              reason: hookResult.reason ?? "Blocked by AgentStart hook",
            },
          };
          return;
        }
      }
      agentStarted = true;

      let iteration = 0;
      const recentToolCalls: string[] = [];

      while (iteration < maxIterations) {
        iteration++;

        if (options.isCancelled?.(input.conversationId)) {
          yield finishThinking("cancelled", {
            status: "cancelled",
            conversationId: input.conversationId,
          });
          return;
        }

        const rawHistory = await context.storage.getMessages(input.conversationId, {
          mode: "full-content",
        });

        const { history, steps: compactionSteps } = await prepareIterationHistory({
          context,
          conversationId: input.conversationId,
          iteration,
          rawHistory,
          taskAgentOptions: options,
        });
        for (const step of compactionSteps) {
          yield step;
        }

        const hookContext: DefineToolAgentFrameworkContext = {
          ...context,
          agent: { id: input.conversationId, messages: history },
          persistAgentMessage: async (m) => {
            await context.storage.appendMessage(m);
          },
        };

        yield {
          type: "thinking",
          data: {
            status: "calling-llm",
            conversationId: input.conversationId,
            messageCount: history.length,
            iteration,
          },
        };

        const messages = await buildLlmMessages(context, input.conversationId, history);
        const request = { conversationId: input.conversationId, messages };
        let assistantText = "";
        for await (const c of streamLlm(context, request)) {
          assistantText += chunkToText(c);
          yield { type: "message", data: c };
        }

        const definitionId = await inferDefinitionId(context.storage, input.conversationId);
        const agentDefinition = await resolveAgentDefinitionModel(context, definitionId);
        const fw = agentDefinition?.agentFrameworkConfig as
          | { prompts?: unknown[]; plugins?: unknown[]; response?: unknown[] }
          | undefined;
        const hasPlugins = Boolean(
          fw?.plugins && Array.isArray(fw.plugins) && fw.plugins.length > 0,
        );

        const assistantMessage: ChatMessage = {
          messageId: `${input.conversationId}:a:${Date.now().toString(36)}`,
          conversationId: input.conversationId,
          originNodeId: "local",
          timestamp: Date.now(),
          lamportClock: await nextLamportClockForConversation(
            context.storage,
            input.conversationId,
          ),
          role: "assistant",
          content: assistantText,
        };
        hookContext.agent.messages.push(assistantMessage);
        await hookContext.persistAgentMessage?.(assistantMessage);

        const { calls, parallel } = matchAllToolCallings(assistantText);

        if (hasPlugins && fw) {
          const { hooks } = await createHooksWithPlugins(
            fw as { plugins: Array<{ toolId: string }> },
            {
              pluginRegistry: resolvePromptPluginMap(context),
            },
          );
          const rcPayload: {
            agentFrameworkContext: DefineToolAgentFrameworkContext;
            response: { status: "done"; content: string };
            agentFrameworkConfig: {
              plugins?: import("../tools/types.js").FrameworkPluginToolConfig[];
            };
            requestId: undefined;
            toolConfig: import("../tools/types.js").FrameworkPluginToolConfig;
            actions?: { yieldNextRoundTo?: "human" | "self" };
          } = {
            agentFrameworkContext: hookContext,
            response: { status: "done", content: assistantText },
            agentFrameworkConfig: fw as {
              plugins?: import("../tools/types.js").FrameworkPluginToolConfig[];
            },
            requestId: undefined,
            toolConfig: { id: "_memeloop", toolId: "_memeloop" },
            actions: {},
          };
          await runResponseCompleteHooks(hooks, rcPayload);

          const post = await responseConcat(
            fw as {
              response?: import("../tools/types.js").AgentResponse[];
              plugins?: import("../tools/types.js").FrameworkPluginToolConfig[];
            },
            assistantText,
            hookContext,
            hookContext.agent.messages,
          );

          const yieldTarget = rcPayload.actions?.yieldNextRoundTo ?? post.yieldNextRoundTo;

          if (yieldTarget === "human") {
            yield finishThinking("completed", {
              status: "input-required",
              conversationId: input.conversationId,
            });
            return;
          }
          if (yieldTarget === "self") {
            continue;
          }
        }

        if (calls.length === 0) {
          markStop("completed");
          return;
        }

        if (!enableToolLoop) {
          markStop("completed");
          return;
        }

        const pending = calls.filter(
          (c) => !toolCallHandledInAgentMessages(hookContext.agent.messages, assistantText, c),
        );

        if (pending.length === 0) {
          if (hasPlugins && calls.length > 0) {
            continue;
          }
          markStop("completed");
          return;
        }

        if (!fallbackRegistry && hasPlugins) {
          continue;
        }

        const allowedCalls = yield* gateToolCallsWithPreToolUse(
          context,
          options,
          definitionId,
          input.conversationId,
          pending,
        );

        if (allowedCalls.length === 0) {
          continue;
        }

        yield* runRegistryToolCalls({
          context,
          taskAgentOptions: options,
          conversationId: input.conversationId,
          calls: allowedCalls,
          parallel,
          recentToolCalls,
        });

        // Save session checkpoint after each completed turn
        if (checkpointOptions?.enabled) {
          const checkpointStore = checkpointOptions.store;
          if (!checkpointStore) {
            if (context.logger?.warn) {
              context.logger.warn("[taskAgent] checkpoint enabled without a checkpoint store");
            } else {
              console.warn("[taskAgent] checkpoint enabled without a checkpoint store");
            }
            continue;
          }
          try {
            const allMessages = await context.storage.getMessages(input.conversationId, {
              mode: "full-content",
            });
            await checkpointStore.saveCheckpoint(input.conversationId, allMessages);
          } catch (error) {
            if (context.logger?.warn) {
              context.logger.warn("[taskAgent] checkpoint save failed:", error);
            } else {
              console.warn("[taskAgent] checkpoint save failed:", error);
            }
          }
        }

        continue;
      }

      yield finishThinking("max-iterations", {
        status: "max-iterations",
        conversationId: input.conversationId,
        maxIterations,
      });
    } catch (error) {
      markStop("error");
      throw error;
    } finally {
      if (agentStarted && !agentStopped && stopReason && hasHooks("AgentStop")) {
        agentStopped = true;
        await executeHooks("AgentStop", context, {
          conversationId: input.conversationId,
          reason: stopReason,
        });
      }
    }
  };
}
