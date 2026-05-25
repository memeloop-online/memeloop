import type { ChatMessage } from "@memeloop/protocol";
import type { ILLMProvider } from "../types.js";

export interface CompactionOptions {
  /** Maximum token count to aim for after compaction (estimated by char count / 3.5). Default: 0 (no limit). */
  maxTokens?: number;
  /** Number of recent message turns (user+assistant pairs) to preserve. Default: 4. */
  recentTurnsToKeep?: number;
  /** Whether to attempt LLM summarization. Falls back to truncation if LLM unavailable or fails. Default: true. */
  useLlmSummary?: boolean;
  /** Optional LLM provider for summarization. */
  llmProvider?: ILLMProvider;
}

export interface CompactionResult {
  /** Compacted messages (summary + recent turns). */
  messages: ChatMessage[];
  /** True if compaction reduced the message count. */
  compacted: boolean;
  /** Number of messages dropped. */
  droppedCount: number;
  /** Summary text generated or fallback notice. */
  summaryText: string;
}

/**
 * Counts "turns" in message history. A turn is a user→assistant pair.
 * Tool messages are grouped with the preceding assistant message.
 */
function countTurns(messages: ChatMessage[]): number {
  let turns = 0;
  for (const msg of messages) {
    if (msg.role === "user") {
      turns++;
    }
  }
  return turns;
}

/**
 * Estimate token count from message content (rough: chars / 3.5).
 */
function estimateTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    total += content.length / 3.5;
  }
  return Math.ceil(total);
}

/**
 * Build a fallback summary string from the dropped messages.
 */
function buildTruncationSummary(
  dropped: ChatMessage[],
  totalDropped: number,
): string {
  const turns = countTurns(dropped);
  const oldest = dropped[0];
  const newest = dropped[dropped.length - 1];
  const oldestTime = oldest?.timestamp ? new Date(oldest.timestamp).toISOString() : "unknown";
  const newestTime = newest?.timestamp ? new Date(newest.timestamp).toISOString() : "unknown";

  return `[context-summary] ${totalDropped} earlier messages (${turns} turns, ${oldestTime} → ${newestTime}) were compacted. Key topics: see recent messages below.`;
}

/**
 * Creates a summary ChatMessage from the compaction result.
 */
function createSummaryMessage(
  conversationId: string,
  summaryText: string,
  baseMessage: ChatMessage,
): ChatMessage {
  return {
    messageId: `${conversationId}:compacted:${Date.now().toString(36)}`,
    conversationId,
    originNodeId: baseMessage.originNodeId,
    timestamp: Date.now(),
    lamportClock: -1, // Will be replaced by TaskAgent
    role: "assistant",
    content: summaryText,
    metadata: { compacted: true },
  };
}

/**
 * Deterministic compaction: keeps recent N turns and replaces older messages
 * with a single summary message.
 */
export function compactMessages(
  messages: ChatMessage[],
  options: Omit<CompactionOptions, "llmProvider" | "useLlmSummary"> = {},
): CompactionResult {
  const recentTurnsToKeep = options.recentTurnsToKeep ?? 4;

  if (messages.length <= recentTurnsToKeep * 2) {
    return { messages, compacted: false, droppedCount: 0, summaryText: "" };
  }

  // Find the cutoff point: keep the last recentTurnsToKeep user messages + everything after them
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      userIndices.push(i);
    }
  }

  if (userIndices.length <= recentTurnsToKeep) {
    return { messages, compacted: false, droppedCount: 0, summaryText: "" };
  }

  // The first message to keep starts at the recentTurnsToKeep-th user message from the end
  const keepStartIndex = userIndices[userIndices.length - recentTurnsToKeep];
  const dropped = messages.slice(0, keepStartIndex);
  const kept = messages.slice(keepStartIndex);

  if (dropped.length === 0) {
    return { messages, compacted: false, droppedCount: 0, summaryText: "" };
  }

  const conversationId = messages[0]?.conversationId ?? "unknown";
  const summaryText = buildTruncationSummary(dropped, dropped.length);
  const summaryMessage = createSummaryMessage(conversationId, summaryText, messages[0]);

  const compacted: ChatMessage[] = [summaryMessage, ...kept];

  // Also prune tool outputs older than the cutoff in the kept section
  // (we already dropped them in the "dropped" section)

  return {
    messages: compacted,
    compacted: true,
    droppedCount: dropped.length,
    summaryText,
  };
}

/**
 * Checks whether compaction is needed based on message count threshold.
 * @returns true if message count exceeds threshold (default 50).
 */
export function shouldCompact(
  messages: ChatMessage[],
  threshold?: number,
): boolean {
  const t = threshold ?? 50;
  return messages.length > t;
}

/**
 * Auto-compact: estimates token usage, and if it exceeds maxTokens,
 * performs compaction to keep the context within bounds.
 *
 * Uses the LLM provider for summarization if available, falling back to
 * simple truncation + turn counting.
 */
export async function autoCompact(
  messages: ChatMessage[],
  options: CompactionOptions = {},
): Promise<CompactionResult> {
  const recentTurnsToKeep = options.recentTurnsToKeep ?? 4;

  // If we're within budget, no need to compact
  if (options.maxTokens && options.maxTokens > 0) {
    const currentTokens = estimateTokens(messages);
    if (currentTokens <= options.maxTokens) {
      return { messages, compacted: false, droppedCount: 0, summaryText: "" };
    }
  }

  // If LLM summarization is requested and provider is available, try it
  if (options.useLlmSummary !== false && options.llmProvider?.chat) {
    try {
      const result = await llmCompact(messages, options.llmProvider, recentTurnsToKeep);
      if (result) return result;
    } catch {
      // Fall through to truncation
    }
  }

  // Fallback: deterministic truncation
  return compactMessages(messages, { ...options });
}

/**
 * LLM-based compaction: asks the model to summarize the older conversation turns.
 */
async function llmCompact(
  messages: ChatMessage[],
  llmProvider: ILLMProvider,
  recentTurnsToKeep: number,
): Promise<CompactionResult | null> {
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      userIndices.push(i);
    }
  }

  if (userIndices.length <= recentTurnsToKeep) {
    return null;
  }

  const keepStartIndex = userIndices[userIndices.length - recentTurnsToKeep];
  const toSummarize = messages.slice(0, keepStartIndex);
  const kept = messages.slice(keepStartIndex);

  if (toSummarize.length === 0) return null;

  const conversationId = messages[0]?.conversationId ?? "unknown";

  // Build a text representation of the messages to summarize
  const conversationText = toSummarize
    .map((m) => {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      const roleLabel = m.role === "tool" ? `[tool: ${m.metadata?.toolId ?? "unknown"}]` : `[${m.role}]`;
      // Keep tool outputs brief in summary
      if (m.role === "tool" && content.length > 500) {
        return `${roleLabel} ${content.slice(0, 500)}... (truncated)`;
      }
      return `${roleLabel} ${content}`;
    })
    .join("\n\n");

  const prompt = `Summarize the following conversation excerpt. Be concise but capture key decisions, action items, tool calls, and important context. Focus on information useful for continuing the conversation.

<conversation>
${conversationText.slice(0, 8000)}
</conversation>

Provide a brief summary (3-5 paragraphs) of the key points.`;

  try {
    const response = await llmProvider.chat?.({
      messages: [{ role: "user", content: prompt }],
    });

    let summaryText: string;
    if (response != null && typeof response === "object" && Symbol.asyncIterator in Object(response)) {
      // Async iterable - collect chunks
      const chunks: string[] = [];
      for await (const chunk of response as AsyncIterable<unknown>) {
        if (typeof chunk === "string") {
          chunks.push(chunk);
        } else if (chunk != null && typeof chunk === "object" && "content" in chunk) {
          const c = (chunk as { content?: unknown }).content;
          if (typeof c === "string") chunks.push(c);
        }
      }
      summaryText = chunks.join("");
    } else if (typeof response === "string") {
      summaryText = response;
    } else {
      return null;
    }

    const trimmed = summaryText.trim();
    if (trimmed.length < 10) return null;

    const summaryMessage = createSummaryMessage(
      conversationId,
      `[context-summary] ${trimmed}`,
      messages[0],
    );

    return {
      messages: [summaryMessage, ...kept],
      compacted: true,
      droppedCount: toSummarize.length,
      summaryText: trimmed,
    };
  } catch {
    return null; // Fall back to truncation
  }
}
