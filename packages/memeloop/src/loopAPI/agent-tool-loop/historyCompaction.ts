import type { ChatMessage, ContextCompactionProgress } from '../../conversation/index.js';
import type { ConversationEventStore } from '../../storage/ports.js';
import { type ContextCompactionWorkBudget, loadBoundedModelContext } from './boundedModelContext.js';

/**
 * Load the bounded effective model context. There is deliberately no
 * full-history fallback: old prefixes are summarized from storage-owned causal
 * pages and a failed/cancelled summarizer prevents the downstream model call.
 */
export async function loadEffectiveIterationHistory(
  options: {
    storage: ConversationEventStore;
    conversationId: string;
    localNodeId: string;
    signal: AbortSignal;
    summarize: (messages: readonly ChatMessage[], signal: AbortSignal) => Promise<string>;
    recentTurnsToKeep?: number;
    maxContextBytes?: number;
    workMode?: 'foreground' | 'background';
    workBudget?: Partial<ContextCompactionWorkBudget>;
    onCompactionContinuationNeeded?: (progress: Readonly<ContextCompactionProgress>) => void;
  },
): Promise<ChatMessage[]> {
  const result = await loadBoundedModelContext(options);
  return result.messages;
}
