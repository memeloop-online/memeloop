/**
 * agent-management — headless agent management contracts and controllers.
 *
 * Environment-neutral interfaces and pure-TypeScript controllers for:
 * - Agent definition CRUD (AgentDefinitionRepository)
 * - Agent instance lifecycle (AgentInstanceClient)
 * - Conversation operations (AgentConversationClient)
 * - Prompt preview generation (PromptPreviewClient)
 * - Scheduled task management (ScheduledTaskClient)
 *
 * No React, DOM, Electron, MUI, Zustand, or RxJS dependency.
 */

// ── Types ──────────────────────────────────────────────────────────

export type {
  AgentAttachmentChunkReadOptions,
  AgentAttachmentInput,
  AgentAttachmentUploadSource,
  AgentCommittedAttachment,
  AgentConversationClient,
  AgentConversationMessagePage,
  AgentConversationMessagePageOptions,
  AgentConversationMessagePageReset,
  AgentConversationMessagePageSuccess,
  AgentConversationMessageProjection,
  AgentConversationMessageWindowFocus,
  AgentConversationMessageWindowRequest,
  AgentConversationMessageWindowReset,
  AgentConversationMessageWindowResult,
  AgentConversationMessageWindowSuccess,
  AgentConversationResolvedCompactionFocus,
  AgentConversationResolvedMessageWindowFocus,
  AgentConversationResolvedTurnFocus,
  AgentConversationUpdate,
  AgentCreationState,
  AgentDefinitionEditorState,
  AgentDefinitionRepository,
  AgentInstanceClient,
  AgentManagementCallOptions,
  AgentRuntimeView,
  AgentSessionSeekResult,
  AgentUpdateListener,
  CreateScheduledTaskInput,
  ListScheduledTasksOptions,
  PromptPreviewAuditDetailChunk,
  PromptPreviewAuditDetailRequest,
  PromptPreviewAuditDetailTarget,
  PromptPreviewAuditEntrySource,
  PromptPreviewAuditEntrySummary,
  PromptPreviewAuditPage,
  PromptPreviewAuditPageRequest,
  PromptPreviewAuditReleaseRequest,
  PromptPreviewCallOptions,
  PromptPreviewClient,
  PromptPreviewContextStats,
  PromptPreviewDialogState,
  PromptPreviewExecutionRoute,
  PromptPreviewGeneratedResult,
  PromptPreviewPreparedExecution,
  PromptPreviewProgress,
  PromptPreviewResult,
  PromptPreviewStepCode,
  ScheduledTask,
  ScheduledTaskClient,
  ScheduledTaskPage,
  ScheduledTaskPageSource,
  ScheduledTaskState,
  WikiTiddlerAttachment,
  WikiTiddlerClickData,
} from './types.js';
export {
  MAX_AGENT_CONVERSATION_APPENDED_MESSAGE_COUNT,
  MAX_AGENT_SESSION_PENDING_NEW_MESSAGE_COUNT,
  MAX_PROMPT_PREVIEW_AUDIT_DETAIL_CHUNK_BYTES,
  MAX_PROMPT_PREVIEW_AUDIT_ENTRY_PREVIEW_CODE_UNITS,
  MAX_PROMPT_PREVIEW_AUDIT_PAGE_BYTES,
  MAX_PROMPT_PREVIEW_AUDIT_PAGE_ENTRIES,
  MAX_PROMPT_PREVIEW_GENERATED_RESULT_BYTES,
  MIN_PROMPT_PREVIEW_AUDIT_DETAIL_CHUNK_BYTES,
  MIN_PROMPT_PREVIEW_AUDIT_PAGE_BYTES,
} from './types.js';

export { assertAgentAttachmentInput, normalizeAgentAttachmentInput } from './attachmentInput.js';
export {
  AGENT_SESSION_CONTRACT_LIMITS,
  parseAgentConversationDeleteTurnResponse,
  parseAgentConversationRetryTurnResponse,
  parseAgentConversationTurnDetailResponse,
} from './conversationCommands.js';
export type {
  AgentConversationDeleteTurnRequest,
  AgentConversationDeleteTurnResponse,
  AgentConversationRetryTurnRequest,
  AgentConversationRetryTurnResponse,
  AgentConversationTurnDetailRequest,
  AgentConversationTurnDetailResponse,
} from './conversationCommands.js';
export {
  assertPromptPreviewAuditDetailChunk,
  assertPromptPreviewAuditDetailRequest,
  assertPromptPreviewAuditPage,
  assertPromptPreviewAuditPageRequest,
  assertPromptPreviewAuditReleaseRequest,
  assertPromptPreviewGeneratedResult,
  assertPromptPreviewPreparedExecution,
  PromptPreviewAuditError,
} from './PromptPreviewAudit.js';
export type { PromptPreviewAuditErrorCode, PromptPreviewAuditPageAssertionOptions } from './PromptPreviewAudit.js';
export { decodePromptPreviewAuditRequest, PromptPreviewAuditSessionStore } from './PromptPreviewAuditSessionStore.js';
export type { CreatePromptPreviewAuditSessionInput, PromptPreviewAuditSessionStoreOptions } from './PromptPreviewAuditSessionStore.js';

// ── Controllers ────────────────────────────────────────────────────

export { AgentSessionController } from './AgentSessionController.js';
export type { AgentSessionControllerOptions, AgentSessionListener, AgentSessionSeekCallOptions, AgentSessionSnapshot, AgentSessionTarget } from './AgentSessionController.js';

export { PollingAgentConversationUpdateSource } from './PollingAgentConversationUpdateSource.js';
export type {
  AgentConversationHead,
  AgentConversationInvalidation,
  PollingAgentConversationUpdateSchedule,
  PollingAgentConversationUpdateSourceOptions,
  ReadAgentConversationHeadInput,
} from './PollingAgentConversationUpdateSource.js';

export { AgentDefinitionEditorController } from './AgentDefinitionEditorController.js';
export type { AgentDefinitionEditorControllerOptions, EditorStateChange, EditorStateListener, ScheduleEditorState } from './AgentDefinitionEditorController.js';

export { AgentCreationController } from './AgentCreationController.js';
export type { AgentCreationControllerOptions, CreationStateListener } from './AgentCreationController.js';

export { PromptPreviewController } from './PromptPreviewController.js';
export type { PreviewDialogListener, PromptPreviewAuditReadOptions, PromptPreviewControllerOptions } from './PromptPreviewController.js';

export { previewScheduledTaskCron, ScheduledTaskExecutionCoordinator } from './ScheduledTaskExecutionCoordinator.js';
export type {
  ScheduledTaskExecutionClock,
  ScheduledTaskExecutionCoordinatorOptions,
  ScheduledTaskExecutionIdentity,
  ScheduledTaskExecutionPatch,
  ScheduledTaskExecutionRunInput,
  ScheduledTaskExecutionStore,
} from './ScheduledTaskExecutionCoordinator.js';

export { RemoteAgentExecutionCoordinator, RemoteAgentExecutionError } from './RemoteAgentExecutionCoordinator.js';
export { REMOTE_AGENT_EXECUTION_LIMITS } from './RemoteAgentExecutionCoordinator.js';
export type {
  RemoteAgentCancelRequest,
  RemoteAgentDeleteRequest,
  RemoteAgentDeleteResult,
  RemoteAgentExecuteRequest,
  RemoteAgentExecutionCallOptions,
  RemoteAgentExecutionCoordinatorOptions,
  RemoteAgentExecutionErrorCode,
  RemoteAgentExecutionOperation,
  RemoteAgentExecutionProvenance,
  RemoteAgentExecutionResult,
  RemoteAgentExecutionSnapshot,
  RemoteAgentExecutionStatus,
  RemoteAgentExecutionTarget,
  RemoteAgentRetryRequest,
  RemoteAgentSynchronizationState,
} from './RemoteAgentExecutionCoordinator.js';
