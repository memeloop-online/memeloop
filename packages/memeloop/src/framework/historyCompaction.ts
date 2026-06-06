import { executeHooks, hasHooks } from "../hooks/registry.js";
import type { ChatMessage } from "../protocol/index.js";
import { autoCompact as autoCompactMessages, shouldCompact } from "../services/compact.js";
import { nextLamportClockForConversation } from "../storage/nextLamport.js";
import type { AgentFrameworkContext } from "../types.js";

import type { TaskAgentStep } from "./taskAgentContract.js";

type ContextCompactionModified = {
  history?: unknown;
  skipDefault?: unknown;
  compacted?: unknown;
  droppedCount?: unknown;
  summaryText?: unknown;
  persistSummaryMessage?: unknown;
};

type AutoCompactResult = {
  messages: ChatMessage[];
  compacted: boolean;
  droppedCount: number;
  summaryText: string;
};

type AutoCompactFunction = (
  messages: ChatMessage[],
  options: {
    recentTurnsToKeep: number;
    maxTokens: number;
    llmProvider: unknown;
  },
) => Promise<AutoCompactResult>;

function compactHistory(
  history: ChatMessage[],
  options: AgentFrameworkContext["taskAgent"],
): ChatMessage[] {
  const maxMessages = options?.contextCompaction?.maxMessages ?? 0;
  if (maxMessages <= 0 || history.length <= maxMessages) return history;
  const dropped = history.length - maxMessages;
  const tail = history.slice(-maxMessages);
  const summaryMessage: ChatMessage = {
    ...tail[0],
    messageId: `${tail[0]?.conversationId ?? "unknown"}:summary:${Date.now().toString(36)}`,
    role: "assistant",
    content: `[context-summary] ${dropped} earlier messages were compacted.`,
  };
  if (options?.contextCompaction?.replayLastUserMessage === false) return tail;
  const lastUser = [...history].reverse().find((message) => message.role === "user");
  if (!lastUser) return [summaryMessage, ...tail];
  if (tail.some((message) => message.messageId === lastUser.messageId)) return tail;
  return [summaryMessage, lastUser, ...tail];
}

function asChatMessages(value: unknown): ChatMessage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((message) => message != null && typeof message === "object")) return undefined;
  return value as ChatMessage[];
}

function buildCompactedStep(
  conversationId: string,
  iteration: number,
  droppedCount: unknown,
  summaryText: unknown,
): TaskAgentStep {
  return {
    type: "thinking",
    data: {
      status: "compacted",
      conversationId,
      droppedCount: typeof droppedCount === "number" ? droppedCount : 0,
      summaryText: typeof summaryText === "string" ? summaryText : "",
      iteration,
    },
  };
}

async function persistSummaryMessage(
  context: AgentFrameworkContext,
  conversationId: string,
  summaryMessage: ChatMessage | undefined,
): Promise<void> {
  if (!summaryMessage) return;
  const lamportSummary = await nextLamportClockForConversation(context.storage, conversationId);
  await context.storage.appendMessage({
    ...summaryMessage,
    lamportClock: lamportSummary,
  });
}

async function maybeApplyContextCompactionHook(options: {
  context: AgentFrameworkContext;
  conversationId: string;
  iteration: number;
  history: ChatMessage[];
  taskAgentOptions: AgentFrameworkContext["taskAgent"];
}): Promise<{ handled: boolean; history: ChatMessage[]; steps: TaskAgentStep[] }> {
  const { context, conversationId, iteration, history, taskAgentOptions } = options;
  if (!hasHooks("ContextCompaction")) {
    return { handled: false, history, steps: [] };
  }

  const hookResult = await executeHooks("ContextCompaction", context, {
    conversationId,
    iteration,
    history,
    autoCompact: taskAgentOptions?.autoCompact,
    contextCompaction: taskAgentOptions?.contextCompaction,
  });
  const modified = hookResult.modified as ContextCompactionModified | undefined;
  const modifiedHistory = asChatMessages(modified?.history);
  const nextHistory = modifiedHistory ?? history;
  const skipDefault =
    !hookResult.allowed || modifiedHistory != null || modified?.skipDefault === true;
  if (!skipDefault) {
    return { handled: false, history: nextHistory, steps: [] };
  }

  const steps =
    modified?.compacted === true
      ? [buildCompactedStep(conversationId, iteration, modified.droppedCount, modified.summaryText)]
      : [];
  if (modified?.persistSummaryMessage === true) {
    await persistSummaryMessage(context, conversationId, nextHistory[0]);
  }

  return { handled: true, history: nextHistory, steps };
}

async function applyBuiltInAutoCompact(options: {
  context: AgentFrameworkContext;
  conversationId: string;
  iteration: number;
  history: ChatMessage[];
  taskAgentOptions: AgentFrameworkContext["taskAgent"];
}): Promise<{ history: ChatMessage[]; steps: TaskAgentStep[] }> {
  const { context, conversationId, iteration, taskAgentOptions } = options;
  let history = options.history;
  const autoCompactOptions = taskAgentOptions?.autoCompact;
  if (!autoCompactOptions) {
    return { history, steps: [] };
  }

  const threshold = autoCompactOptions.threshold ?? 50;
  if (!shouldCompact(history, threshold)) {
    return { history, steps: [] };
  }

  try {
    const result = await (autoCompactMessages as unknown as AutoCompactFunction)(history, {
      recentTurnsToKeep: autoCompactOptions.recentTurnsToKeep ?? 4,
      maxTokens: autoCompactOptions.maxTokens ?? 0,
      llmProvider: context.llmProvider,
    });
    if (!result.compacted) {
      return { history, steps: [] };
    }

    history = result.messages;
    await persistSummaryMessage(context, conversationId, result.messages[0]);
    return {
      history,
      steps: [
        buildCompactedStep(conversationId, iteration, result.droppedCount, result.summaryText),
      ],
    };
  } catch (error) {
    if (context.logger?.warn) {
      context.logger.warn("[taskAgent] auto-compact failed:", error);
    } else {
      console.warn("[taskAgent] auto-compact failed:", error);
    }
    return { history, steps: [] };
  }
}

export async function prepareIterationHistory(options: {
  context: AgentFrameworkContext;
  conversationId: string;
  iteration: number;
  rawHistory: ChatMessage[];
  taskAgentOptions: AgentFrameworkContext["taskAgent"];
}): Promise<{ history: ChatMessage[]; steps: TaskAgentStep[] }> {
  const { taskAgentOptions } = options;
  const hookResult = await maybeApplyContextCompactionHook({
    ...options,
    history: options.rawHistory,
  });
  if (hookResult.handled) {
    return hookResult;
  }

  const autoCompactResult = await applyBuiltInAutoCompact({
    ...options,
    history: hookResult.history,
  });
  return {
    history: compactHistory(autoCompactResult.history, taskAgentOptions),
    steps: autoCompactResult.steps,
  };
}
