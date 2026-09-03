import { safeErrorFromUnknown } from 'memeloop';
import type {
  AgentRunErrorSettingTarget,
  ChatMessage,
  ConversationMessageListProjection,
  ConversationTimelineMessageRole,
  ConversationTimelinePageSuccess,
  RemoteAgentExecutionTarget,
  WikiTiddlerAttachment,
} from 'memeloop';

export type {
  ConversationTimelineCompactionEntry,
  ConversationTimelineEntry,
  ConversationTimelineMessageEntry,
  ConversationTimelineMessageRole,
  ConversationTimelinePage,
  ConversationTimelinePageReset,
  ConversationTimelinePageSuccess,
} from 'memeloop';

import type { MemeLoopMessageDetailLoader } from './messageDetail.js';
import type { MemeLoopMessageReasoningLoader } from './messageReasoning.js';
import type { MemeLoopObserverErrorHandler } from './observerErrors.js';
import type { MemeLoopVisibleAttachmentLoader } from './visibleAttachmentHydration.js';

export type { MemeLoopObserverErrorHandler, MemeLoopObserverFailure } from './observerErrors.js';

export interface AgentExecutionTarget {
  /** Canonical Core value retained unchanged through every UI selection. */
  value: RemoteAgentExecutionTarget;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface SetExecutionTargetOptions {
  restartCurrentTurn?: boolean;
}

export type MessageDetailLoader = MemeLoopMessageDetailLoader;

export type { WikiTiddlerAttachment, WikiTiddlerClickData, WikiTiddlerContentProjection } from 'memeloop';

/**
 * Platform-neutral, atomic attachment selection owned by a host.
 *
 * `TFile` is deliberately generic: browser, Native and embedded hosts can use
 * their own immutable URI/handle without pulling platform declarations into
 * the portable entrypoint.
 */
export interface MemeLoopSelectedAttachmentBatch<TFile = never> {
  file?: TFile;
  wikiTiddlers: readonly WikiTiddlerAttachment[];
}

/** Generation-scoped context for asynchronous attachment resolution/commit. */
export interface MemeLoopAttachmentSelectionContext {
  conversationId: string;
  signal: AbortSignal;
}

export interface MemeLoopChatErrorPresentation {
  title: string;
  message: string;
  actionLabel?: string;
  actionId?: string;
  diagnosticId?: string;
  settingTarget?: AgentRunErrorSettingTarget;
}

export interface MemeLoopSendMessageInput {
  text: string;
  wikiTiddlers?: readonly WikiTiddlerAttachment[];
}

export type MemeLoopChatOperation =
  | 'cancel'
  | 'configure-error'
  | 'copy-conversation'
  | 'copy-message'
  | 'delete-turn'
  | 'edit-message'
  | 'export-conversation'
  | 'export-message'
  | 'load-detail'
  | 'load-reasoning'
  | 'load-more-after'
  | 'load-more-before'
  | 'load-around'
  | 'load-timeline-after'
  | 'load-timeline-around'
  | 'load-timeline-before'
  | 'load-around-timeline-entry'
  | 'jump-to-latest'
  | 'load-attachment-options'
  | 'load-visible-attachments'
  | 'reload-message'
  | 'resolve-question'
  | 'resolve-dropped-attachments'
  | 'rename-conversation'
  | 'retry-turn'
  | 'send-message'
  | 'select-attachment'
  | 'set-execution-target'
  | 'update-message';

export interface ConversationTimelineLabels {
  navigation: string;
  message: (index: number, total: number, role: ConversationTimelineMessageRole) => string;
  compacted: (count: number) => string;
  loadEarlier: string;
  loadLater: string;
  seek: string;
  close: string;
  newMessages: (count: number) => string;
}

/** Platform-neutral host adapter shared by Web and React Native surfaces. */
export interface MemeLoopChatAdapter {
  /** Stable identity even while both resident messages and timeline page are empty. */
  conversationId: string;
  messages: readonly ConversationMessageListProjection[];
  timeline?: ConversationTimelinePageSuccess;
  hasMoreBefore?: boolean;
  hasMoreAfter?: boolean;
  isLoadingMoreBefore?: boolean;
  isLoadingMoreAfter?: boolean;
  loadMoreBefore?: (signal?: AbortSignal) => Promise<void>;
  loadMoreAfter?: (signal?: AbortSignal) => Promise<void>;
  loadAround?: (messageId: string, turnId: string, cursor: string | undefined, expectedRevision: string, signal?: AbortSignal) => Promise<void>;
  loadTimelineBefore?: (cursor: string, expectedRevision: string, signal?: AbortSignal) => Promise<void>;
  loadTimelineAfter?: (cursor: string, expectedRevision: string, signal?: AbortSignal) => Promise<void>;
  /** Fetch a bounded marker page around an absolute timeline entry. */
  loadTimelineAround?: (entryIndex: number, expectedRevision: string, signal?: AbortSignal) => Promise<void>;
  /** Load the resident message window nearest a turn or visible compaction boundary. */
  loadAroundTimelineEntry?: (entryId: string, cursor: string, expectedRevision: string, signal?: AbortSignal) => Promise<void>;
  isLoadingTimelineBefore?: boolean;
  isLoadingTimelineAfter?: boolean;
  windowAnchorTurnId?: string;
  windowAnchorMessageId?: string;
  residentMessageLimit?: number;
  residentContentByteLimit?: number;
  residentRenderRowLimit?: number;
  isRunning: boolean;
  isLoading: boolean;
  isMessageStreaming?: (messageId: string) => boolean;
  isAtLiveTail?: boolean;
  pendingNewMessageCount?: number;
  jumpToLatest?: (signal?: AbortSignal) => Promise<void>;
  error: Error | null;
  sendMessage: (input: MemeLoopSendMessageInput) => Promise<void>;
  cancel: () => Promise<void>;
  deleteTurn: (turnId: string) => Promise<void>;
  retryTurn: (turnId: string) => Promise<void>;
  editMessage?: (messageId: string, text: string) => Promise<void>;
  reloadMessage?: (messageId: string) => Promise<void>;
  resolveAskQuestion?: (questionId: string, answer: string) => Promise<void>;
  updateMessage?: (message: ChatMessage) => Promise<void>;
  executionTargets?: readonly AgentExecutionTarget[];
  activeExecutionTarget?: RemoteAgentExecutionTarget;
  setExecutionTarget?: (target: RemoteAgentExecutionTarget, options?: SetExecutionTargetOptions) => Promise<void>;
  loadMessageDetail?: MessageDetailLoader;
  /** Page reasoning independently from answer text and generic message detail. */
  loadMessageReasoning?: MemeLoopMessageReasoningLoader;
  /** Hydrate only attachments for resident messages that a surface marks visible. */
  loadVisibleAttachments?: MemeLoopVisibleAttachmentLoader;

  /** Host-owned streaming/file export. Must not materialize the transcript in UI memory. */
  exportConversation?: (options: { signal: AbortSignal }) => Promise<void>;
  /** Host-owned single-message streaming export. UI passes identity only. */
  exportMessage?: (messageId: string, options: { signal: AbortSignal }) => Promise<void>;

  /** Receives every caught asynchronous UI operation failure. */
  onError?: (error: Error, operation: MemeLoopChatOperation) => void;
  /** Receives structured failures raised by an `onError`/listener observer. */
  onObserverError?: MemeLoopObserverErrorHandler;
}

export function normalizeMemeLoopChatError(error: unknown): Error {
  // Typed agent failures are interpreted separately by the presentation layer.
  // Operation diagnostics use Core's bounded descriptor-only conversion.
  return safeErrorFromUnknown(error, { fallback: 'memeloop-ui-operation-failed', maxBytes: 4_096 });
}
