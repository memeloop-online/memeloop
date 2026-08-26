// Loop API registry, types, and built-in loop definitions.
export * from './encoding/canonicalJson.js';
export * from './loopAPI/agent-agent-loop/index.js';
export * from './loopAPI/agent-tool-loop/index.js';
export * from './loopAPI/controlStoreLoopCheckpointStore.js';
export * from './loopAPI/plugins/builtinLoopsPlugin.js';
export * from './loopAPI/plugins/index.js';
export * from './loopAPI/registry.js';
export { TokenTracker } from './loopAPI/tokenTracker.js';
export * from './loopAPI/types.js';
export * from './runState.js';
export * from './runtime.js';
export * from './safeError.js';
export { decodeAttachmentBlobRpc } from './sync/attachmentRpcCodec.js';
export * from './sync/chatSyncEngine.js';
export * from './sync/peerNodeAdapter.js';
export * from './types.js';
export * from './userMessageAdmission.js';
// SolidPodSyncAdapter is intentionally not public: v2 raw-event/blob semantics
// are not implemented yet. Do not expose an internal source path that package
// exports cannot resolve; hosts must use a conforming ConversationEventStore.
export { getBuiltinLoopProfile, getBuiltinLoopProfiles } from './loopProfiles/loadBuiltins.js';
export * from './loopProfiles/resolveCapabilities.js';
export * from './storage/atomicAgentRetry.js';
export { assertStorageConformance, runStorageConformance, STORAGE_CONFORMANCE_CHECKS } from './storage/conformance.js';
export type { StorageConformanceCheck, StorageConformanceReport } from './storage/conformance.js';
export {
  assertConversationMessageProjection,
  assertConversationMessageWindowResult,
  assertConversationTimelinePage,
  assertConversationTimelinePageEnvelope,
  boundConversationTimelineTurnEntry,
  buildConversationMessagePage,
  buildConversationMessageWindowAround,
  buildConversationTimelinePage,
  compareMessageCursor,
  DEFAULT_MESSAGE_PAGE_SIZE,
  MAX_CONVERSATION_MESSAGE_WINDOW_BYTES,
  MAX_CONVERSATION_MESSAGE_WINDOW_SIZE,
  MAX_CONVERSATION_TIMELINE_PAGE_BYTES,
  MAX_CONVERSATION_TIMELINE_PAGE_SIZE,
  MAX_CONVERSATION_TIMELINE_PREVIEW_LENGTH,
  MAX_MESSAGE_PAGE_SIZE,
  messageCursor,
  normalizeMessagePageLimit,
  projectConversationMessageForList,
  readConversationMessagePage,
  readConversationMessageWindowAround,
  readConversationTimelinePage,
} from './storage/conversationPaging.js';
export type { ConversationMessageDisplayTruncation, ConversationMessageListProjection } from './storage/conversationPaging.js';
export type {
  AgentInstanceStore,
  AuditableAgentStorage,
  BlobStore,
  CompactionCandidatePage,
  ConversationAuditExportOptions,
  ConversationAuditExportStore,
  ConversationDirectoryStore,
  ConversationEventPage,
  ConversationEventStore,
  ConversationListPage,
  ConversationListPageCallOptions,
  ConversationListPageReset,
  ConversationListPageSuccess,
  ConversationListQuery,
  ConversationMessageCursor,
  ConversationMessageDetailRange,
  ConversationMessageIdentity,
  ConversationMessagePage,
  ConversationMessageWindowCompactionFocus,
  ConversationMessageWindowFocus,
  ConversationMessageWindowReset,
  ConversationMessageWindowResolvedFocus,
  ConversationMessageWindowResult,
  ConversationMessageWindowSuccess,
  ConversationMessageWindowTurnFocus,
  ConversationReadCallOptions,
  ConversationTimelineCompactionEntry,
  ConversationTimelineEntry,
  ConversationTimelinePage,
  ConversationTimelinePageCallOptions,
  ConversationTimelinePageReset,
  ConversationTimelinePageSuccess,
  ConversationTimelineParticipantPreview,
  ConversationTimelineParticipantRole,
  ConversationTimelineTurnEntry,
  DefinitionStore,
  FullAgentStorage,
  GetCompactionCandidatePageOptions,
  GetConversationEventPageOptions,
  GetConversationListPageOptions,
  GetConversationMessageWindowAroundOptions,
  GetConversationTimelinePageOptions,
  GetMessagePageOptions,
  GetRetainedCompactionControlsOptions,
  ImBindingStore,
  MessageVersionFrontier,
  MessageVersionFrontierCursor,
  MessageVersionFrontierPage,
  RetainedCompactionControlPage,
} from './storage/ports.js';
export { SessionStorage } from './storage/sessionStorage.js';
export { createCheckpointRecord, parseCheckpointRecord, serializeCheckpointRecord } from './storage/sessionStorage.js';
export type { CheckpointRecord, CheckpointStore, CheckpointSummary } from './storage/sessionStorage.js';

// Agent definition/profile types
export * from './agent/agentProfileRegistry.js';
export * from './agent/agentProfiles.js';
export * from './agent/categories.js';
export { tiddlerToAgentDefinition } from './agent/tiddlerTemplateConverter.js';
export type { TiddlerFieldsForAgent } from './agent/tiddlerTemplateConverter.js';
export * from './agent/types.js';
export type { AgentInstanceModel, AgentInstanceModel as AgentInstance } from './types.js';

// Headless agent management contracts (host-neutral interfaces for UI layer)
export * from './agent-management/index.js';
// Keep the public paging result explicit: TypeScript consumer resolution can
// otherwise lose these two type-only names behind the nested export-star.
export type { ScheduledTaskPage, ScheduledTaskPageSource } from './agent-management/types.js';

// LLM providers
export * from './llm/fetchProvider.js';
export * from './llm/prepareModelRequest.js';
export * from './llm/providerRegistry.js';
export * from './llm/request.js';
export * from './llm/response.js';
export * from './modelCatalog/index.js';

// Network utilities not tied to peer transport
export { gitProxyTargetBlockReason } from './network/gitProxyUrlPolicy.js';
export { buildMemeloopFileUri, buildMemeloopUri, parseMemeloopUri } from './network/uri.js';

// Portable declarative orchestration contracts
export * from './orchestration/index.js';

// Device network abstraction (libp2p-first)
export * from './device-network/index.js';
export * from './network/terminalNotifications.js';

// IM bridge types + implementation
export * from './im/index.js';

// Sync types
export * from './sync/protocol.js';

// Conversation message and attachment types
export * from './conversation/index.js';

export * from './loopAPI/hooks/registry.js';
export * from './loopAPI/hooks/types.js';
export * from './permission/index.js';
export * from './plugin/index.js';
export { registerBuiltinPromptPlugins } from './promptUtilities/builtinPromptPlugins.js';
export { findPromptById, flattenPrompts, promptConcatStream } from './promptUtilities/promptConcat.js';
export type { PromptConcatPluginPreview, PromptConcatStreamState } from './promptUtilities/promptConcat.js';
export * from './promptUtilities/responsePatternUtility.js';
export type { AgentFrameworkConfig, AgentPromptDescription, IPrompt, PromptNode, PromptPluginConfig } from './promptUtilities/types.js';
export * from './tools/index.js';
