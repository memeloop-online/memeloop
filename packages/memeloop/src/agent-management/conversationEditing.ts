import { isContextCompactionSummary } from '../conversation/compactionBoundary.js';
import type { ConversationEventDraft } from '../conversation/events.js';
import { canonicalConversationEventBytes, messageToConversationEvent } from '../conversation/events.js';
import type { ChatMessage } from '../conversation/types.js';
import { sha256HexSync } from '../encoding/sha256.js';
import type { PendingLocalChatMessage } from '../loopAPI/types.js';

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

/** Durable host operations shared by local clients and authenticated device RPC. */
export interface ConversationEditingPort {
  loadConversationEditSource(conversationId: string, messageId: string): Promise<ConversationEditSource>;
  saveConversationEditDraft(input: ConversationDraftWrite): Promise<number>;
  /** Atomically retains the prefix and a pending replacement; requestId is idempotent. */
  forkConversation(input: ConversationForkRequest): Promise<string>;
  /** Host-only staged root, retained after acceptance for idempotent retries. */
  getPendingConversationBranchReplacement(conversationId: string): Promise<PendingLocalChatMessage | null>;
  getConversationBranches(conversationId: string, messageIds: readonly string[]): Promise<ConversationBranchState[]>;
}

/**
 * Bind the common editor to a local/remote durable store. Acceptance of the
 * replacement turn and navigation remain with the host's existing run/session
 * controller, so editing never creates a second execution or history system.
 */
export function createConversationEditingAdapter(options: {
  conversationId: string;
  port: Pick<ConversationEditingPort, 'loadConversationEditSource' | 'saveConversationEditDraft' | 'forkConversation'>;
  branches: readonly ConversationBranchState[];
  createId: () => string;
  acceptBranch: (request: ConversationForkRequest, draftRevision: number) => Promise<void>;
  switchBranch: ConversationEditingAdapter['switchBranch'];
}): ConversationEditingAdapter {
  // Retry an interrupted acceptance with the same durable branch identity.
  let pending: ConversationForkRequest | undefined;
  return {
    branches: options.branches,
    loadSource: messageId => options.port.loadConversationEditSource(options.conversationId, messageId),
    saveDraft: (messageId, text, expectedRevision) => options.port.saveConversationEditDraft({ conversationId: options.conversationId, messageId, text, expectedRevision }),
    submit: async (messageId, text, sourceRevision, draftRevision) => {
      if (!pending || pending.messageId !== messageId || pending.text !== text || pending.sourceRevision !== sourceRevision) {
        pending = {
          conversationId: options.conversationId,
          messageId,
          text,
          sourceRevision,
          requestId: options.createId(),
          targetConversationId: options.createId(),
          replacementMessageId: options.createId(),
        };
      }
      const request = pending;
      const target = await options.port.forkConversation(request);
      if (target !== request.targetConversationId) throw new Error('conversation_branch_target_mismatch');
      await options.acceptBranch(request, draftRevision);
      pending = undefined;
    },
    switchBranch: options.switchBranch,
  };
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

/** Stable revision of the full canonical source, independent of JSON object key order. */
export function conversationEditSourceRevision(message: ChatMessage): string {
  return sha256HexSync(canonicalConversationEventBytes(messageToConversationEvent(message)));
}

/**
 * Stage this payload with the atomic prefix fork, then pass it as userMessage
 * to normal runtime acceptance. Forking itself must not append the edited
 * root: acceptance owns that event and its idempotency/run identity.
 */
export function createConversationBranchReplacement(source: ChatMessage, input: ConversationForkRequest): PendingLocalChatMessage {
  if (source.role !== 'user' || source.conversationId !== input.conversationId || source.messageId !== input.messageId) {
    throw new Error('conversation_branch_source_mismatch');
  }
  assertConversationEditText(input.text);
  if (!input.text.trim()) throw new Error('conversation_edit_empty');
  const { beforeCommitMap: _beforeCommitMap, ...metadata } = source.metadata ?? {};
  return {
    messageId: input.replacementMessageId,
    turnId: input.replacementMessageId,
    content: input.text,
    contentType: 'text/plain',
    parts: [{ type: 'text', text: input.text }, ...source.parts.filter(part => part.type === 'attachment')],
    ...(source.attachments === undefined ? {} : { attachments: source.attachments }),
    metadata: {
      ...metadata,
      memeloopBranch: {
        ...conversationBranchIdentity(source),
        variantConversationId: input.targetConversationId,
        variantMessageId: input.replacementMessageId,
      },
    },
  };
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
    await options.append(createConversationBranchPrefixEvent(message, options));
  }
}

/** Synchronous per-message form for SQLite transaction callbacks. */
export function createConversationBranchPrefixEvent(message: ChatMessage, options: {
  sourceConversationId: string;
  targetConversationId: string;
  originNodeId: string;
  createId: (sourceId: string) => string;
}): ConversationEventDraft {
  if (message.conversationId !== options.sourceConversationId) throw new Error('conversation_branch_source_mismatch');
  if (isContextCompactionSummary(message) || message.metadata?.isContextCompaction === true) throw new Error('conversation_branch_compaction_not_copyable');
  const event = messageToConversationEvent(message);
  const { originSequence: _sequence, lamportClock: _clock, ...draft } = event;
  const { isContextCompaction: _compaction, contextCompactionBoundary: _boundary, ...metadata } = message.metadata ?? {};
  return {
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
  };
}
