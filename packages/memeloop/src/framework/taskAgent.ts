import type { AgentDefinition, ChatMessage, DetailRef } from "@memeloop/protocol";

import { matchAllToolCallings, type ToolCallingMatch } from "../prompt/responsePatternUtility.js";
import { filterOldMessagesByDuration } from "../prompt/utilities.js";
import { promptConcatStream } from "../prompt/promptConcat.js";
import { responseConcat } from "../prompt/responseConcat.js";
import type { AgentFrameworkContext } from "../types.js";
import { nextLamportClockForConversation } from "../storage/nextLamport.js";
import {
  createHooksWithPlugins,
  resolvePromptPluginMap,
  runResponseCompleteHooks,
} from "../tools/pluginRegistry.js";
import type { DefineToolAgentFrameworkContext } from "../tools/types.js";
import {
  extractMemeloopStructuredToolPayload,
  truncateToolSummary,
} from "../tools/structuredToolResult.js";
import { autoCompact as autoCompactMessages, shouldCompact } from "../services/compact.js";
import { executeHooks, hasHooks } from "../hooks/registry.js";

export type { TaskAgentGenerator, TaskAgentInput, TaskAgentStep } from "./taskAgentContract.js";
import type { TaskAgentGenerator, TaskAgentInput } from "./taskAgentContract.js";
import { formatToolResultMessage } from "./toolResultMessage.js";
import { gateToolCallsWithPreToolUse } from "./toolUseGate.js";

const DEFAULT_MAX_ITERATIONS = 256;

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

type LlmRequestMessage = { role: "system" | "user" | "assistant" | "tool"; content: unknown };

function compactHistory(
  history: ChatMessage[],
  opts: AgentFrameworkContext["taskAgent"],
): ChatMessage[] {
  const maxMessages = opts?.contextCompaction?.maxMessages ?? 0;
  if (maxMessages <= 0 || history.length <= maxMessages) return history;
  const dropped = history.length - maxMessages;
  const tail = history.slice(-maxMessages);
  const summaryMessage: ChatMessage = {
    ...(tail[0] as ChatMessage),
    messageId: `${tail[0]?.conversationId ?? "unknown"}:summary:${Date.now().toString(36)}`,
    role: "assistant",
    content: `[context-summary] ${dropped} earlier messages were compacted.`,
  };
  if (opts?.contextCompaction?.replayLastUserMessage === false) return tail;
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  if (!lastUser) return [summaryMessage, ...tail];
  if (tail.some((m) => m.messageId === lastUser.messageId)) return tail;
  return [summaryMessage, lastUser, ...tail];
}

function chunkToText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk != null && typeof chunk === "object" && "content" in chunk) {
    const c = (chunk as { content?: unknown }).content;
    return typeof c === "string" ? c : JSON.stringify(c);
  }
  return JSON.stringify(chunk);
}

async function* streamLlm(
  context: AgentFrameworkContext,
  request: unknown,
): AsyncGenerator<unknown, void, unknown> {
  const chatFunction = context.llmProvider.chat;
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- legacy chat used for backward compatibility
  if (typeof chatFunction !== "function") {
    throw new Error(
      "LLM provider does not support legacy chat() method. Use AI SDK's streamText instead.",
    );
  }
  const raw = chatFunction(request);
  let resolved: unknown = raw;
  if (resolved != null && typeof (resolved as Promise<unknown>).then === "function") {
    resolved = await (resolved as Promise<unknown>);
  }
  if (isAsyncIterable(resolved)) {
    for await (const chunk of resolved) {
      yield chunk;
    }
    return;
  }
  yield resolved;
}

function chatMessageToModelMessage(m: ChatMessage): LlmRequestMessage {
  // Map ChatRole to LLM model roles (agent/error -> assistant)
  const role: LlmRequestMessage["role"] =
    m.role === "agent" || m.role === "error"
      ? "assistant"
      : m.role === "tool"
        ? "tool"
        : m.role === "user"
          ? "user"
          : "assistant";
  return {
    role,
    content: m.content,
  };
}

async function resolveAgentDefinitionModel(
  context: AgentFrameworkContext,
  definitionId: string,
): Promise<AgentDefinition | null> {
  if (context.resolveAgentDefinition) {
    return context.resolveAgentDefinition(definitionId);
  }
  return context.storage.getAgentDefinition(definitionId);
}

async function inferDefinitionId(
  storage: AgentFrameworkContext["storage"],
  conversationId: string,
): Promise<string> {
  try {
    const meta = await storage.getConversationMeta(conversationId);
    if (meta?.definitionId) return meta.definitionId;
  } catch {
    /* optional on old mocks */
  }
  const parts = conversationId.split(":");
  if (parts.length >= 2) {
    return parts.slice(0, -1).join(":");
  }
  return conversationId;
}

async function buildLlmMessages(
  context: AgentFrameworkContext,
  conversationId: string,
  history: ChatMessage[],
): Promise<LlmRequestMessage[]> {
  const definitionId = await inferDefinitionId(context.storage, conversationId);
  const definition = await resolveAgentDefinitionModel(context, definitionId);
  const fw = definition?.agentFrameworkConfig as { prompts?: unknown[]; plugins?: unknown[] } | undefined;
  const maxHistoryAgeMs = context.taskAgent?.maxHistoryAgeMs ?? 0;
  const historyForPrompt =
    maxHistoryAgeMs > 0 ? filterOldMessagesByDuration(history, maxHistoryAgeMs) : history;

  if (fw?.prompts && Array.isArray(fw.prompts) && fw.prompts.length > 0) {
    const readAttachmentFile = context.taskAgent?.readAttachmentFile;
    const gen = promptConcatStream(
      {
        agentFrameworkConfig: {
          prompts: fw.prompts as import("../prompt/types.js").PromptNode[],
          plugins: (fw.plugins ?? []) as import("../prompt/types.js").PromptPluginConfig[],
          response: [],
        },
      },
      historyForPrompt,
      context,
      readAttachmentFile ? { readAttachmentFile } : undefined,
    );
    let lastFlat: LlmRequestMessage[] = [];
    for await (const state of gen) {
      lastFlat = state.flatPrompts as LlmRequestMessage[];
    }
    const withoutTrailingUser =
      lastFlat.length > 0 && lastFlat[lastFlat.length - 1]?.role === "user"
        ? lastFlat.slice(0, -1)
        : lastFlat;
    return [...withoutTrailingUser, ...historyForPrompt.map(chatMessageToModelMessage)];
  }

  const systemText = typeof definition?.systemPrompt === "string" ? definition.systemPrompt.trim() : "";
  if (systemText.length > 0) {
    return [
      { role: "system", content: systemText },
      ...historyForPrompt.map(chatMessageToModelMessage),
    ];
  }

  return historyForPrompt.map(chatMessageToModelMessage);
}

type ToolRunRow = {
  text: string;
  isError: boolean;
  detailRef?: DetailRef;
  awaitSessionId?: string;
};

async function executeRegistryTool(
  context: AgentFrameworkContext,
  toolId: string,
  parameters: Record<string, unknown>,
): Promise<ToolRunRow> {
  const normalizedId = toolId.includes("-")
    ? toolId.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
    : toolId;
  const impl = (context.tools.getTool(toolId) ?? context.tools.getTool(normalizedId)) as
    | ((args: Record<string, unknown>) => unknown | Promise<unknown>)
    | undefined;

  if (typeof impl !== "function") {
    return {
      text: `No tool registered for "${toolId}".`,
      isError: true,
    };
  }

  try {
    const raw = await impl(parameters);
    if (raw != null && typeof raw === "object") {
      const o = raw as { error?: string; result?: unknown };
      if (typeof o.error === "string" && o.error.length > 0) {
        return { text: o.error, isError: true };
      }
      if ("result" in o) {
        return {
          text: typeof o.result === "string" ? o.result : JSON.stringify(o.result),
          isError: false,
        };
      }
      const structured = extractMemeloopStructuredToolPayload(raw);
      if (structured) {
        return {
          text: structured.summary,
          isError: false,
          detailRef: structured.detailRef,
          awaitSessionId: structured.awaitSessionId,
        };
      }
    }
    return { text: typeof raw === "string" ? raw : JSON.stringify(raw), isError: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const log = context.logger?.warn ?? console.warn.bind(console);
    log("[taskAgent] tool execution error", toolId, message);
    return { text: message, isError: true };
  }
}

function toolCallHandledInAgentMessages(
  agentMessages: import("../types.js").AgentInstanceMessage[],
  assistantContent: string,
  call: ToolCallingMatch & { found: true },
): boolean {
  let assistantIdx = -1;
  for (let i = agentMessages.length - 1; i >= 0; i--) {
    const m = agentMessages[i];
    if (m.role === "assistant" && m.content === assistantContent) {
      assistantIdx = i;
      break;
    }
  }
  if (assistantIdx < 0) return false;
  const after = agentMessages.slice(assistantIdx + 1);
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
    const opts = context.taskAgent ?? {};
    const enableToolLoop = opts.enableToolLoop !== false;
    const fallbackRegistry = opts.fallbackRegistryTools !== false;
    const maxIterations =
      opts.maxIterations != null && opts.maxIterations > 0
        ? opts.maxIterations
        : DEFAULT_MAX_ITERATIONS;
    const autoCompactOpts = opts.autoCompact;
    const checkpointOpts = opts.sessionCheckpoint;

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

    let iteration = 0;
    const recentToolCalls: string[] = [];

    while (iteration < maxIterations) {
      iteration++;

      if (opts.isCancelled?.(input.conversationId)) {
        yield {
          type: "thinking",
          data: { status: "cancelled", conversationId: input.conversationId },
        };
        return;
      }

      const rawHistory = await context.storage.getMessages(input.conversationId, {
        mode: "full-content",
      });

      // Auto-compact if message count exceeds threshold (before contextCompaction)
      let history = rawHistory;
      if (autoCompactOpts) {
        const threshold = autoCompactOpts.threshold ?? 50;
        if (shouldCompact(history, threshold)) {
          try {
            const result = await autoCompactMessages(history, {
              recentTurnsToKeep: autoCompactOpts.recentTurnsToKeep ?? 4,
              maxTokens: autoCompactOpts.maxTokens ?? 0,
              llmProvider: context.llmProvider,
            });
            if (result.compacted) {
              history = result.messages;
              yield {
                type: "thinking",
                data: {
                  status: "compacted",
                  conversationId: input.conversationId,
                  droppedCount: result.droppedCount,
                  summaryText: result.summaryText,
                  iteration,
                },
              };
              // Persist the summary message to storage
              const summaryMsg = result.messages[0];
              if (summaryMsg) {
                const lamportSummary = await nextLamportClockForConversation(
                  context.storage,
                  input.conversationId,
                );
                await context.storage.appendMessage({
                  ...summaryMsg,
                  lamportClock: lamportSummary,
                });
              }
            }
          } catch (err) {
            const log = context.logger?.warn ?? console.warn.bind(console);
            log("[taskAgent] auto-compact failed:", err);
          }
        }
      }

      history = compactHistory(history, opts);

      const hookCtx: DefineToolAgentFrameworkContext = {
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
      const hasPlugins = Boolean(fw?.plugins && Array.isArray(fw.plugins) && fw.plugins.length > 0);

      const assistantMessage: ChatMessage = {
        messageId: `${input.conversationId}:a:${Date.now().toString(36)}`,
        conversationId: input.conversationId,
        originNodeId: "local",
        timestamp: Date.now(),
        lamportClock: await nextLamportClockForConversation(context.storage, input.conversationId),
        role: "assistant",
        content: assistantText,
      };
      hookCtx.agent.messages.push(assistantMessage);
      await hookCtx.persistAgentMessage?.(assistantMessage);

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
          agentFrameworkContext: hookCtx,
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
          hookCtx,
          hookCtx.agent.messages,
        );

        const yieldTarget = rcPayload.actions?.yieldNextRoundTo ?? post.yieldNextRoundTo;

        if (yieldTarget === "human") {
          yield {
            type: "thinking",
            data: { status: "input-required", conversationId: input.conversationId },
          };
          return;
        }
        if (yieldTarget === "self") {
          continue;
        }
      }

      if (calls.length === 0) {
        return;
      }

      if (!enableToolLoop) {
        return;
      }

      const pending = calls.filter(
        (c) => !toolCallHandledInAgentMessages(hookCtx.agent.messages, assistantText, c),
      );

      if (pending.length === 0) {
        if (hasPlugins && calls.length > 0) {
          continue;
        }
        return;
      }

      if (!fallbackRegistry && hasPlugins) {
        continue;
      }

      const allowedCalls = yield* gateToolCallsWithPreToolUse(
        context,
        opts,
        definitionId,
        input.conversationId,
        pending,
      );

      if (allowedCalls.length === 0) {
        continue;
      }

      const executeWithGuards = async (call: (typeof allowedCalls)[number]): Promise<ToolRunRow> => {
        const signature = `${call.toolId}:${JSON.stringify(call.parameters)}`;
        recentToolCalls.push(signature);
        const threshold = Math.max(2, opts.doomLoopThreshold ?? 3);
        const last = recentToolCalls.slice(-threshold);
        if (last.length === threshold && last.every((x) => x === signature)) {
          return { text: "Blocked by doom-loop guard", isError: true };
        }

        const row = await executeRegistryTool(context, call.toolId, call.parameters);

        // Execute PostToolUse hooks
        if (hasHooks("PostToolUse")) {
          await executeHooks("PostToolUse", context, {
            toolId: call.toolId,
            parameters: call.parameters,
            result: row.text,
            isError: row.isError,
            conversationId: input.conversationId,
          });
        }

        return row;
      };

      const persistToolResult = async (
        call: (typeof allowedCalls)[number],
        row: ToolRunRow,
      ): Promise<void> => {
        const lamportTool = await nextLamportClockForConversation(
          context.storage,
          input.conversationId,
        );
        await context.storage.appendMessage({
          messageId: `${input.conversationId}:t:${call.toolId}:${Date.now().toString(36)}`,
          conversationId: input.conversationId,
          originNodeId: "local",
          timestamp: Date.now(),
          lamportClock: lamportTool,
          role: "tool",
          content: formatToolResultMessage(call.toolId, call.parameters, row.text, row.isError),
          detailRef: row.detailRef,
        });
      };

      const persistTerminalAwaitCompletion = async (
        call: (typeof allowedCalls)[number],
        row: ToolRunRow,
      ): Promise<void> => {
        const sid = row.awaitSessionId;
        const wait = opts.waitForTerminalSession;
        if (!sid || !wait || row.isError) return;
        const done = await wait(sid);
        const lamport2 = await nextLamportClockForConversation(
          context.storage,
          input.conversationId,
        );
        const body = truncateToolSummary(
          `[terminal.await done] session=${sid}\nexitCode: ${done.exitCode ?? "null"}\n---\n${done.truncatedOutput}`,
        );
        await context.storage.appendMessage({
          messageId: `${input.conversationId}:t:${call.toolId}:await:${Date.now().toString(36)}`,
          conversationId: input.conversationId,
          originNodeId: "local",
          timestamp: Date.now(),
          lamportClock: lamport2,
          role: "tool",
          content: formatToolResultMessage(call.toolId, call.parameters, body, false),
          detailRef: row.detailRef
            ? { ...row.detailRef, exitCode: done.exitCode ?? row.detailRef.exitCode }
            : undefined,
        });
      };

      if (parallel) {
        const results = await Promise.all(
          allowedCalls.map(async (call: (typeof allowedCalls)[number]) => ({
            call,
            ...(await executeWithGuards(call)),
          })),
        );
        for (const row of results) {
          yield {
            type: "tool" as const,
            data: {
              toolId: row.call.toolId,
              parameters: row.call.parameters,
              parallel: true,
              result: row.text,
              isError: row.isError,
            },
          };
        }
        for (const row of results) {
          await persistToolResult(row.call, {
            text: row.text,
            isError: row.isError,
            detailRef: row.detailRef,
          });
        }
        for (const row of results) {
          await persistTerminalAwaitCompletion(row.call, row);
        }
      } else {
        for (const call of allowedCalls) {
          const row = await executeWithGuards(call);
          yield {
            type: "tool",
            data: {
              toolId: call.toolId,
              parameters: call.parameters,
              parallel: false,
              result: row.text,
              isError: row.isError,
            },
          };
          await persistToolResult(call, row);
          await persistTerminalAwaitCompletion(call, row);
        }
      }

      // Save session checkpoint after each completed turn
      if (checkpointOpts?.enabled) {
        const checkpointStore = checkpointOpts.store;
        if (!checkpointStore) {
          const log = context.logger?.warn ?? console.warn.bind(console);
          log("[taskAgent] checkpoint enabled without a checkpoint store");
          continue;
        }
        try {
          const allMessages = await context.storage.getMessages(input.conversationId, {
            mode: "full-content",
          });
          await checkpointStore.saveCheckpoint(input.conversationId, allMessages);
        } catch (err) {
          const log = context.logger?.warn ?? console.warn.bind(console);
          log("[taskAgent] checkpoint save failed:", err);
        }
      }

      continue;
    }

    yield {
      type: "thinking",
      data: { status: "max-iterations", conversationId: input.conversationId, maxIterations },
    };
  };
}
