import type { ConversationEventDraft } from '../conversation/events.js';
import { messageToConversationEvent } from '../conversation/events.js';
import type { ChatMessage } from '../conversation/types.js';

export const CONVERSATION_EDIT_TEXT_LIMIT = 4 * 1024 * 1024;

export interface ConversationEditSource {
  text: string;
  /** Changes when the canonical source changes; never a list-preview digest. */
  sourceRevision: string;
  draft: { text: string | null; revision: number } | null;
}

export interface ConversationDraftWrite {
  conversationId: string;
  messageId: string;
  expectedRevision: number;
  /** null discards; keep the revision tombstone to fence delayed saves. */
  text: string | null;
}

export interface ConversationForkRequest {
  conversationId: string;
  messageId: string;
  sourceRevision: string;
  requestId: string;
  targetConversationId: string;
  replacementMessageId: string;
  text: string;
  /** Optional host navigation state committed with the pending branch. */
  navigation?: { tabId: string; draftRevision: number };
}

export interface ConversationBranchIdentity {
  rootConversationId: string;
  rootMessageId: string;
  variantConversationId: string;
  variantMessageId: string;
}

export interface ConversationBranchState {
  messageId: string;
  selected: number;
  alternatives: readonly { conversationId: string; messageId: string }[];
}

/** Host-bound edit operations; history copying stays in the storage process. */
export interface ConversationEditingAdapter {
  loadSource(messageId: string): Promise<ConversationEditSource>;
  saveDraft(messageId: string, text: string | null, expectedRevision: number): Promise<number>;
  submit(messageId: string, text: string, sourceRevision: string, draftRevision: number): Promise<void>;
  branches: readonly ConversationBranchState[];
  switchBranch(conversationId: string, messageId: string): Promise<void>;
}

export function conversationBranchIdentity(message: Pick<ChatMessage, 'conversationId' | 'messageId' | 'metadata'>): ConversationBranchIdentity {
  const value = message.metadata?.memeloopBranch;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const { rootConversationId, rootMessageId, variantConversationId, variantMessageId } = record;
    if (
      typeof rootConversationId === 'string' && typeof rootMessageId === 'string' &&
      typeof variantConversationId === 'string' && typeof variantMessageId === 'string' &&
      [rootConversationId, rootMessageId, variantConversationId, variantMessageId].every(value => value.length > 0 && value.length <= 512)
    ) {
      return { rootConversationId, rootMessageId, variantConversationId, variantMessageId };
    }
  }
  return {
    rootConversationId: message.conversationId,
    rootMessageId: message.messageId,
    variantConversationId: message.conversationId,
    variantMessageId: message.messageId,
  };
}

export function assertConversationEditText(text: unknown): asserts text is string {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > CONVERSATION_EDIT_TEXT_LIMIT) {
    throw new Error('conversation_edit_text_limit');
  }
}

/**
 * Materialize a branch prefix with existing wire event kinds. The host MUST run
 * this inside one transaction holding a source snapshot and must supply only
 * retained, non-tombstoned, non-compaction messages strictly before the edit.
 * Old peers see an ordinary independent conversation with correct model context.
 */
export async function copyConversationBranchPrefix(options: {
  sourceConversationId: string;
  targetConversationId: string;
  originNodeId: string;
  messages: AsyncIterable<ChatMessage>;
  createId: (sourceId: string) => string;
  append: (draft: ConversationEventDraft) => Promise<void>;
}): Promise<void> {
  for await (const message of options.messages) {
    if (message.conversationId !== options.sourceConversationId) throw new Error('conversation_branch_source_mismatch');
    if (message.metadata?.isContextCompaction === true) throw new Error('conversation_branch_compaction_not_copyable');
    // Full immutable payloads and attachment hashes are retained; run/checkpoint
    // state is deliberately not part of a message event.
    const event = messageToConversationEvent(message);
    const { originSequence: _sequence, lamportClock: _clock, ...draft } = event;
    const { isContextCompaction: _compaction, contextCompactionBoundary: _boundary, ...metadata } = message.metadata ?? {};
    await options.append({
      ...draft,
      eventId: options.createId(message.messageId),
      conversationId: options.targetConversationId,
      originNodeId: options.originNodeId,
      message: {
        ...event.message,
        messageId: options.createId(message.messageId),
        turnId: options.createId(message.turnId),
        metadata: {
          ...metadata,
          ...(message.role === 'user' ? { memeloopBranch: conversationBranchIdentity(message) } : {}),
        },
      },
    });
  }
}
