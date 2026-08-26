export {
  createAgentRunLogDetailLoader,
  formatMessageDetailPage,
  MEMELOOP_MESSAGE_DETAIL_DISPLAY_CHARACTERS,
  MEMELOOP_MESSAGE_DETAIL_LIMIT,
  MEMELOOP_MESSAGE_DETAIL_MAX_BYTES,
  validateMessageDetailPage,
} from './messageDetail.js';
export type {
  AgentRunLogDetailItem,
  AgentRunLogDetailLoaderOptions,
  AgentRunLogDetailPullPage,
  AgentRunLogDetailPullRequest,
  MemeLoopMessageDetailLoader,
  MemeLoopMessageDetailPage,
  MemeLoopMessageDetailRequest,
} from './messageDetail.js';
export type {
  AgentExecutionTarget,
  ConversationTimelineLabels,
  DroppedAttachmentResolver,
  DroppedAttachmentSnapshot,
  MemeLoopAttachmentSelectionContext,
  MemeLoopChatAdapter,
  MemeLoopComposerLabels,
  MemeLoopComposerProps,
  MemeLoopConversationTimelinePage,
  MemeLoopMessageProps,
  MemeLoopSelectedAttachmentBatch,
  MemeLoopThreadProps,
  MemeLoopTimelineCompactionEntry,
  MemeLoopTimelineEntry,
  MemeLoopTimelineEntryBase,
  MemeLoopTimelineParticipantPreview,
  MemeLoopTimelineTurnEntry,
  MessageDetailLoader,
  SetExecutionTargetOptions,
  WebMemeLoopChatAdapter,
  WebMemeLoopSendMessageInput,
  WebSelectedAttachmentBatch,
  WikiTiddlerAttachment,
  WikiTiddlerClickData,
} from './types.js';

export {
  imageAttachmentReferences,
  MEMELOOP_VISIBLE_ATTACHMENT_CHUNK_BYTES,
  MEMELOOP_VISIBLE_ATTACHMENT_MAX_BYTES,
  MEMELOOP_VISIBLE_ATTACHMENT_MAX_COUNT,
  MemeLoopVisibleAttachmentHydrationError,
  messageHydrationIdentity,
  messageHydrationRevision,
  messageNeedsVisibleAttachmentHydration,
  sameMessageHydrationIdentity,
  validateVisibleAttachmentHydrationResult,
} from './visibleAttachmentHydration.js';
export type {
  MemeLoopMessageHydrationIdentity,
  MemeLoopVisibleAttachment,
  MemeLoopVisibleAttachmentHydrationRequest,
  MemeLoopVisibleAttachmentHydrationResult,
  MemeLoopVisibleAttachmentLoader,
  MemeLoopVisibleAttachmentSource,
} from './visibleAttachmentHydration.js';

export { useMemeLoopChatContext } from './runtime/MemeLoopChatContext.js';
export { MemeLoopRuntimeProvider } from './runtime/MemeLoopRuntimeProvider.js';
export { useMemeLoopRuntime } from './runtime/useMemeLoopRuntime.js';

export { resolveAgentRunErrorPresentation } from './agentRunErrorPresentation.js';
export type { AgentRunErrorLocalizedText, AgentRunErrorPresentation, AgentRunErrorPresentationOptions } from './agentRunErrorPresentation.js';
export {
  DEFAULT_MAX_ATTACHMENT_FILE_BYTES,
  DEFAULT_MAX_DROP_PAYLOAD_BYTES,
  DEFAULT_MAX_SELECTED_ATTACHMENTS,
  DEFAULT_MAX_TIDDLER_TITLE_BYTES,
  DEFAULT_MAX_WORKSPACE_NAME_BYTES,
  MemeLoopAttachmentValidationError,
  validateMemeLoopAttachmentSelection,
  validateWebFileAttachment,
  validateWikiTiddlerAttachment,
} from './attachmentValidation.js';
export type { MemeLoopAttachmentPolicy, MemeLoopAttachmentValidationErrorCode, MemeLoopFileAttachment } from './attachmentValidation.js';
export { MemeLoopComposer } from './composer/MemeLoopComposer.js';
export { AskQuestionContent } from './content/AskQuestionContent.js';
export type { AskQuestionContentLabels, AskQuestionContentProps } from './content/AskQuestionContent.js';
export { MessageContent } from './content/MessageContent.js';
export type { MessageContentLabels, MessageContentProps } from './content/MessageContent.js';
export { ConversationTimelineWindowController, validateConversationTimelineResult } from './ConversationTimelineWindowController.js';
export type {
  ConversationTimelinePageClient,
  ConversationTimelinePageRequest,
  ConversationTimelineWindowControllerOptions,
  ConversationTimelineWindowSnapshot,
} from './ConversationTimelineWindowController.js';
export {
  boundMessageForDisplay,
  DEFAULT_RESIDENT_CONTENT_BYTE_LIMIT,
  DEFAULT_RESIDENT_RENDER_ROW_LIMIT,
  estimateMessageDisplay,
  estimateMessageDisplayBytes,
  estimateMessageRenderRows,
  getDisplayTruncation,
  MAX_DISPLAY_MESSAGE_CHARACTERS,
  MAX_DISPLAY_MESSAGE_RENDER_ROWS,
  MAX_RESIDENT_CONTENT_BYTE_LIMIT,
  MAX_RESIDENT_RENDER_ROW_LIMIT,
} from './displayBounds.js';
export {
  boundedResidentMessages,
  DEFAULT_RESIDENT_MESSAGE_LIMIT,
  MAX_RESIDENT_MESSAGE_LIMIT,
  MEMELOOP_INITIAL_MESSAGE_PAGE_LIMIT,
  MEMELOOP_MESSAGE_PAGE_MAX_BYTES,
} from './residentWindow.js';
export { ConversationTimelineRail } from './thread/ConversationTimelineRail.js';
export { MemeLoopMessage } from './thread/MemeLoopMessage.js';
export type { MemeLoopMessageLabels } from './thread/MemeLoopMessage.js';
export { MemeLoopThread } from './thread/MemeLoopThread.js';
export {
  boundedTimelinePageItems,
  MAX_RESIDENT_TIMELINE_ENTRIES,
  MEMELOOP_TIMELINE_PAGE_LIMIT,
  MEMELOOP_TIMELINE_PAGE_MAX_BYTES,
  TIMELINE_MARKER_HEIGHT,
  timelineEntryOffset,
  timelineMarkerOffsets,
  timelineScrollHeight,
} from './timelineSampling.js';
export { snapshotDroppedAttachments } from './webAttachmentDrop.js';

// Re-export assistant-ui runtime hooks so hosts don't need a direct dependency.
// eslint-disable-next-line @typescript-eslint/no-deprecated -- The no-argument hook remains current; assistant-ui marks only its configuration overload deprecated.
export { useAui, useAuiState } from '@assistant-ui/react';

// Re-export core chat types for consumers.
export type { ChatMessage, ChatRole } from 'memeloop';
