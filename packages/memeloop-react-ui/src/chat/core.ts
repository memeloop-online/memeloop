/**
 * Platform-neutral chat contracts and bounded-window helpers.
 *
 * React Native/Metro consumers should import this entrypoint instead of the
 * Web chat surface, which intentionally depends on MUI and assistant-ui.
 */

export type {
  AgentExecutionTarget,
  ConversationTimelineCompactionEntry,
  ConversationTimelineEntry,
  ConversationTimelineLabels,
  ConversationTimelineMessageEntry,
  ConversationTimelineMessageRole,
  ConversationTimelinePage,
  ConversationTimelinePageReset,
  ConversationTimelinePageSuccess,
  MemeLoopAttachmentSelectionContext,
  MemeLoopChatAdapter,
  MemeLoopChatErrorPresentation,
  MemeLoopChatOperation,
  MemeLoopSelectedAttachmentBatch,
  MemeLoopSendMessageInput,
  MessageDetailLoader,
  SetExecutionTargetOptions,
  WikiTiddlerAttachment,
  WikiTiddlerClickData,
} from './coreTypes.js';

export {
  imageAttachmentReferences,
  imageAttachmentReferencesFromFullMessage,
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
export { MEMELOOP_REASONING_PAGE_MAX_BYTES, messageReasoningProjection, validateMessageReasoningPage } from './messageReasoning.js';
export type { MemeLoopMessageReasoningLoader, MemeLoopMessageReasoningPage, MemeLoopMessageReasoningRequest } from './messageReasoning.js';

export { resolveAgentRunErrorPresentation } from './agentRunErrorPresentation.js';
export type { AgentRunErrorLocalizedText, AgentRunErrorPresentation, AgentRunErrorPresentationOptions } from './agentRunErrorPresentation.js';
export { ConversationTimelineWindowController, validateConversationTimelineResult } from './ConversationTimelineWindowController.js';
export type {
  ConversationTimelinePageClient,
  ConversationTimelinePageRequest,
  ConversationTimelineWindowControllerOptions,
  ConversationTimelineWindowSnapshot,
} from './ConversationTimelineWindowController.js';
export { normalizeMemeLoopChatError } from './coreTypes.js';

export {
  DEFAULT_MAX_DROP_PAYLOAD_BYTES,
  DEFAULT_MAX_SELECTED_ATTACHMENTS,
  DEFAULT_MAX_TIDDLER_TITLE_BYTES,
  DEFAULT_MAX_WORKSPACE_NAME_BYTES,
  MemeLoopAttachmentValidationError,
  validateMemeLoopAttachmentSelection,
  validateWikiTiddlerAttachment,
} from './attachmentValidation.js';
export type { MemeLoopAttachmentPolicy, MemeLoopAttachmentValidationErrorCode, MemeLoopFileAttachment } from './attachmentValidation.js';

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
