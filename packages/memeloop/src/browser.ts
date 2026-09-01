/**
 * Browser-safe entry point for memeloop.
 *
 * Bundlers that respect the "browser" condition (Vite, webpack, etc.) will
 * resolve `import ... from 'memeloop'` to this file instead of the full Node.js
 * entry, avoiding libp2p, crypto, and other Node.js-specific dependencies.
 *
 * Only type-only re-exports and browser-safe utilities are included.
 * For the full Node.js runtime, import from 'memeloop/node' or use the
 * "default"/"node" condition.
 */

// ── Types (compile-time only — erased by TypeScript/esbuild) ──────────────
export type * from './agent-management/types.js';
export type * from './agent/agentProfileRegistry.js';
export type * from './agent/agentProfiles.js';
export type * from './agent/types.js';
export type * from './conversation/events.js';
export { assertCanonicalChatMessageProjection, compareConversationLoopCheckpointEvents } from './conversation/events.js';
export type * from './conversation/types.js';
export * from './device-network/agentDeviceRpc.js';
export * from './device-network/agentDeviceRpcClient.js';
export { ATTACHMENT_UPLOAD_LIMITS, buildAttachmentUploadChunkRequest } from './device-network/attachmentUpload.js';
export type { BuildAttachmentUploadChunkRequestInput, UploadAttachmentChunkRequest } from './device-network/attachmentUpload.js';
export * from './device-network/deviceHeartbeat.js';
export type * from './device-network/index.js';
export * from './device-network/mutableDeviceAuthorizer.js';
export * from './device-network/scheduledTaskRpc.js';
export * from './encoding/canonicalJson.js';
export type * from './im/index.js';
export * from './llm/collectTextResponse.js';
export * from './llm/prepareModelRequest.js';
export * from './llm/providerAccount.js';
export * from './llm/providerRegistry.js';
export * from './llm/request.js';
export * from './llm/response.js';
export { BOUNDED_MODEL_CONTEXT_LIMITS, BoundedModelContextError, loadBoundedModelContext } from './loopAPI/agent-tool-loop/boundedModelContext.js';
export type { BoundedModelContext, ContextCompactionWorkBudget, LoadBoundedModelContextOptions } from './loopAPI/agent-tool-loop/boundedModelContext.js';
export { loadAgentExecutionModelContext, prepareAgentExecutionModelRequest, prepareLoadedAgentExecutionModelRequest } from './loopAPI/agent-tool-loop/executionModelContext.js';
export type {
  AgentExecutionModelContext,
  LoadAgentExecutionModelContextOptions,
  PrepareAgentExecutionModelRequestOptions,
  PreparedAgentExecutionModelRequest,
  PrepareLoadedAgentExecutionModelRequestOptions,
} from './loopAPI/agent-tool-loop/executionModelContext.js';
export { prepareAgentModelRequest } from './loopAPI/agent-tool-loop/modelMessages.js';
export type * from './loopAPI/controlStoreLoopCheckpointStore.js';
export type * from './loopAPI/types.js';
export { getBuiltinLoopProfile, getBuiltinLoopProfiles } from './loopProfiles/loadBuiltins.js';
export * from './loopProfiles/resolveCapabilities.js';
export * from './modelCatalog/index.js';
export type * from './orchestration/index.js';
export type * from './permission/index.js';
export type * from './plugin/index.js';
// Keep a direct value edge to the browser-safe prompt utilities. Besides being
// useful to plugin hosts, this prevents split builds from emitting a redundant
// side-effect-only chunk import that consumers correctly drop under
// `sideEffects: false`.
export { findPromptById, flattenPrompts, promptConcatStream } from './promptUtilities/promptConcat.js';
export type { PromptConcatPluginPreview, PromptConcatStreamState } from './promptUtilities/promptConcat.js';
export type * from './promptUtilities/types.js';
export * from './runState.js';
export * from './safeError.js';
export * from './storage/atomicAgentRetry.js';
export {
  assertConversationFullContentMessagePage,
  assertConversationMessageProjection,
  assertConversationMessageWindowResult,
  assertConversationTimelinePage,
  assertConversationTimelinePageEnvelope,
  boundConversationTimelineMessageEntry,
  buildConversationFullContentMessagePage,
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
  projectTransientConversationMessageForList,
  readConversationFullContentMessagePage,
  readConversationMessagePage,
  readConversationMessageWindowAround,
  readConversationTimelinePage,
} from './storage/conversationPaging.js';
export type { ConversationMessageDisplayTruncation, ConversationMessageListProjection, ConversationMessageReasoningProjection } from './storage/conversationPaging.js';
export type * from './storage/ports.js';
export type * from './storage/sessionStorage.js';
export type * from './sync/protocol.js';
export type * from './types.js';
export * from './userMessageAdmission.js';

// Re-export AgentInstance type (used by UI layer)
export type { AgentInstanceModel, AgentInstanceModel as AgentInstance } from './types.js';

// ── Browser-safe runtime values (no libp2p, no Node.js APIs) ─────────────

// Categories — constants with no dependencies
export * from './agent/categories.js';

// Agent management contracts — headless, type-only based
export * from './agent-management/index.js';
export type { ScheduledTaskPage, ScheduledTaskPageSource } from './agent-management/types.js';

// Remote declarative orchestration — fetch/ReadableStream only, no Node APIs
export { OrchestrationError } from './orchestration/errors.js';
export * from './orchestration/remoteClient.js';
