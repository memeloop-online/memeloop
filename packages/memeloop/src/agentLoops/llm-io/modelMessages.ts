import type { AgentDefinition } from "../../agent/types.js";
import type { ChatMessage } from "../../conversation/index.js";
import { promptConcatStream } from "../../promptUtilities/promptConcat.js";
import type { PromptNode, PromptPluginConfig } from "../../promptUtilities/types.js";
import { filterOldMessagesByDuration } from "../../promptUtilities/utilities.js";
import type { AgentFrameworkContext } from "../../types.js";

export type LlmRequestMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
};

function chatMessageToModelMessage(message: ChatMessage): LlmRequestMessage {
  const role: LlmRequestMessage["role"] =
    message.role === "agent" || message.role === "error"
      ? "assistant"
      : message.role === "tool"
        ? "tool"
        : message.role === "user"
          ? "user"
          : "assistant";
  return {
    role,
    content: message.content,
  };
}

export async function resolveAgentDefinitionModel(
  context: AgentFrameworkContext,
  definitionId: string,
): Promise<AgentDefinition | null> {
  if (context.resolveAgentDefinition) {
    return context.resolveAgentDefinition(definitionId);
  }
  return context.storage.getAgentDefinition(definitionId);
}

export async function inferDefinitionId(
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

export async function buildLlmMessages(
  context: AgentFrameworkContext,
  conversationId: string,
  history: ChatMessage[],
): Promise<LlmRequestMessage[]> {
  const definitionId = await inferDefinitionId(context.storage, conversationId);
  const definition = await resolveAgentDefinitionModel(context, definitionId);
  const fw = definition?.agentFrameworkConfig as
    | { prompts?: unknown[]; plugins?: unknown[] }
    | undefined;
  const maxHistoryAgeMs = context.taskAgent?.maxHistoryAgeMs ?? 0;
  const historyForPrompt =
    maxHistoryAgeMs > 0 ? filterOldMessagesByDuration(history, maxHistoryAgeMs) : history;

  if (fw?.prompts && Array.isArray(fw.prompts) && fw.prompts.length > 0) {
    const readAttachmentFile = context.taskAgent?.readAttachmentFile;
    const gen = promptConcatStream(
      {
        agentFrameworkConfig: {
          prompts: fw.prompts as PromptNode[],
          plugins: (fw.plugins ?? []) as PromptPluginConfig[],
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

  const systemText =
    typeof definition?.systemPrompt === "string" ? definition.systemPrompt.trim() : "";
  if (systemText.length > 0) {
    return [
      { role: "system", content: systemText },
      ...historyForPrompt.map(chatMessageToModelMessage),
    ];
  }

  return historyForPrompt.map(chatMessageToModelMessage);
}
