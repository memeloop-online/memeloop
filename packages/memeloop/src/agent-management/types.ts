/**
 * Headless agent management contracts.
 *
 * Environment-neutral interfaces for managing agent definitions, agent instances,
 * conversations, prompt previews, and scheduled tasks.
 *
 * Designed to be consumed by:
 * - Desktop (via Electron IPC adapters)
 * - Cloud (via REST API adapters)
 * - CLI (via Ink + local or remote adapters)
 */

import type { AgentDefinition } from '../agent/types.js';
import type { AttachmentReference } from '../conversation/index.js';
import type { PortableLlmMessage } from '../llm/request.js';
import type { PromptFlatModelMessage } from '../promptUtilities/promptConcat.js';
import type { AgentFrameworkConfig, PromptNode } from '../promptUtilities/types.js';
import type { ConversationMessageListProjection } from '../storage/conversationPaging.js';
import type { ConversationTimelineCompactionEntry } from '../storage/ports.js';
import type { AgentInstanceMetadata } from '../types.js';
import type {
  AgentConversationDeleteTurnRequest,
  AgentConversationDeleteTurnResponse,
  AgentConversationRetryTurnRequest,
  AgentConversationRetryTurnResponse,
  AgentConversationTurnDetailRequest,
  AgentConversationTurnDetailResponse,
} from './conversationCommands.js';

// ─── Attachment types (host-neutral) ───────────────────────────────

/** Attachment metadata for a wiki tiddler selected in the composer. */
export interface WikiTiddlerAttachment {
  workspaceName: string;
  tiddlerTitle: string;
}

/** Data passed when a wiki tiddler chip is clicked in a message. */
export interface WikiTiddlerClickData {
  workspaceId: string;
  workspaceName: string;
  tiddlerTitle: string;
  renderedContent?: string;
}

/** Host-neutral cancellation for one bounded attachment range read. */
export interface AgentAttachmentChunkReadOptions {
  signal?: AbortSignal;
}

/**
 * Portable streaming attachment input. Browser, React Native, and Node
 * adapters wrap their native bounded range readers at the host boundary.
 * Implementations return at most maxBytes and never materialize the whole file.
 */
export interface AgentAttachmentUploadSource {
  kind: 'source';
  filename: string;
  mimeType: string;
  totalBytes: number;
  /** Optional precomputed final digest; adapters verify it or compute one while streaming before commit. */
  sha256?: string;
  readChunk(
    offset: number,
    maxBytes: number,
    options?: AgentAttachmentChunkReadOptions,
  ): Promise<Uint8Array | null>;
}

/** A previously committed reference; adapters still enforce active-conversation ownership. */
export interface AgentCommittedAttachment {
  kind: 'committed';
  reference: AttachmentReference;
}

export type AgentAttachmentInput = AgentAttachmentUploadSource | AgentCommittedAttachment;

// ─── Agent Definition Repository ───────────────────────────────────

/** Storage contract for agent definition CRUD and template queries. */
export interface AgentDefinitionRepository {
  createAgentDef(agent: AgentDefinition): Promise<AgentDefinition>;
  updateAgentDef(agent: Partial<AgentDefinition> & { id: string }): Promise<AgentDefinition>;
  getAgentDefs(): Promise<AgentDefinition[]>;
  getAgentDef(id?: string): Promise<AgentDefinition | undefined>;
  getAgentTemplates(): Promise<AgentDefinition[]>;
  deleteAgentDef(id: string): Promise<void>;
}

// ─── Agent Instance Client ─────────────────────────────────────────

/** Observable agent runtime metadata exposed to the UI layer. */
export interface AgentRuntimeView extends AgentInstanceMetadata {
  /** If applicable, the agent definition merged with instance overrides. */
  definition?: AgentDefinition;
}

/** Subscription callback for agent updates. */
export type AgentUpdateListener = (update: Partial<AgentRuntimeView>) => void;

/** Cancellation shared by every potentially remote agent-management read/write. */
export interface AgentManagementCallOptions {
  signal?: AbortSignal;
}

/** Client contract for creating, controlling, and subscribing to agent instances. */
export interface AgentInstanceClient {
  /**
   * Create a new agent instance from a definition.
   * @param agentDefinitionId  The definition ID to instantiate from
   * @param options             Optional creation flags (e.g. { preview: true })
   */
  createAgent(
    agentDefinitionId: string,
    options?: { preview?: boolean; signal?: AbortSignal },
  ): Promise<{ id: string }>;

  /**
   * Fetch a full agent runtime view (messages excluded, available via conversation client).
   */
  fetchAgent(agentId: string, options?: AgentManagementCallOptions): Promise<AgentRuntimeView>;

  /**
   * Update an agent instance with partial data.
   */
  updateAgent(
    agentId: string,
    data: Partial<AgentDefinition>,
    options?: AgentManagementCallOptions,
  ): Promise<AgentRuntimeView>;

  /**
   * Cancel the current operation for an agent instance.
   */
  cancelAgent(agentId: string, options?: AgentManagementCallOptions): Promise<void>;

  /**
   * Delete an agent instance and its associated conversation.
   */
  deleteAgent(agentId: string, options?: AgentManagementCallOptions): Promise<void>;

  /**
   * Subscribe to live updates for an agent instance.
   * Returns an unsubscribe function.
   */
  subscribeToUpdates(agentId: string, listener: AgentUpdateListener): () => void;

  /**
   * Get the framework (handler) ID for an agent instance.
   */
  getAgentFrameworkId(agentId: string, options?: AgentManagementCallOptions): Promise<string>;

  /**
   * Get the JSON Schema for the framework configuration.
   */
  getFrameworkConfigSchema(
    frameworkId: string,
    options?: AgentManagementCallOptions,
  ): Promise<Record<string, unknown>>;
}

// ─── Agent Conversation Client ─────────────────────────────────────

/** Client contract for conversation operations on an agent instance. */
export interface AgentConversationMessagePageOptions {
  limit: number;
  /** Shared UTF-8 JSON budget for the requested projection page. */
  maxBytes: number;
  direction?: 'backward' | 'forward';
  /** Remote adapters accept their own opaque keyset without decoding it in Core. */
  cursor?: string;
  /** Required with cursor navigation; mismatch returns reset. */
  expectedRevision?: string;
}

export interface AgentConversationMessagePageSuccess {
  reset: false;
  conversationId: string;
  revision: string;
  items: AgentConversationMessageProjection[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  /** Opaque cursor for the next strictly older page. */
  previousCursor?: string;
  /** Opaque cursor for the next strictly newer page. */
  nextCursor?: string;
}

export interface AgentConversationMessagePageReset {
  reset: true;
  conversationId: string;
  revision: string;
}

export type AgentConversationMessagePage =
  | AgentConversationMessagePageSuccess
  | AgentConversationMessagePageReset;

/**
 * Bounded live-list projection. Heavy structured fields are fetched lazily
 * through getTurnDetail instead of crossing the subscription boundary.
 */
export type AgentConversationMessageProjection = ConversationMessageListProjection;

export const MAX_AGENT_CONVERSATION_APPENDED_MESSAGE_COUNT = 1_000_000;
export const MAX_AGENT_SESSION_PENDING_NEW_MESSAGE_COUNT = 1_000_000;

export type AgentConversationUpdate =
  | {
    kind: 'projection';
    conversationId: string;
    revision: string;
    /** True for transient chunks that do not advance the durable snapshot. */
    streaming: boolean;
    message: AgentConversationMessageProjection;
  }
  | (
    & {
      kind: 'invalidated';
      conversationId: string;
      previousRevision: string;
      revision: string;
    }
    & (
      | {
        reason: 'append';
        /** Exact positive newly visible durable-message delta represented by this invalidation. */
        appendedMessageCount: number;
      }
      | {
        reason: 'reset' | 'tombstone' | 'compaction';
        appendedMessageCount?: never;
      }
    )
  );

export type AgentConversationMessageWindowFocus =
  | {
    kind: 'message';
    messageId: string;
    turnId: string;
    cursor?: string;
  }
  | {
    kind: 'timeline-entry';
    entryId: string;
    cursor: string;
  };

export interface AgentConversationMessageWindowRequest {
  conversationId: string;
  focus: AgentConversationMessageWindowFocus;
  /** Required timeline snapshot revision; mismatch returns reset atomically. */
  expectedRevision: string;
  /** Total hard ceiling for the atomically selected resident window. */
  maxMessages: number;
  /** Strict UTF-8 canonical JSON budget for the complete response. */
  maxBytes: number;
}

export interface AgentConversationResolvedMessageFocus {
  kind: 'message';
  messageId: string;
  turnId: string;
  /** Present when a timeline entry, rather than a direct turn, resolved this focus. */
  entryId?: string;
  cursor?: string;
}

export type AgentConversationResolvedCompactionFocus =
  & {
    kind: 'compaction';
    /** The real semantic compaction entry; no synthetic messageId/turnId is permitted. */
    entry: ConversationTimelineCompactionEntry;
  }
  & (
    | { nearestPosition: 'none'; nearestMessageId?: never; nearestTurnId?: never }
    | { nearestPosition: 'before' | 'after'; nearestMessageId: string; nearestTurnId: string }
  );

export type AgentConversationResolvedMessageWindowFocus =
  | AgentConversationResolvedMessageFocus
  | AgentConversationResolvedCompactionFocus;

export interface AgentConversationMessageWindowSuccess {
  reset: false;
  conversationId: string;
  /** Opaque revision shared with the timeline cursor used for this atomic read. */
  revision: string;
  focus: AgentConversationResolvedMessageWindowFocus;
  recenterAnchor?: { messageId: string; turnId: string };
  items: AgentConversationMessageProjection[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  /** Opaque cursor accepted unchanged by getMessagePage for older rows. */
  previousCursor?: string;
  /** Opaque cursor accepted unchanged by getMessagePage for newer rows. */
  nextCursor?: string;
}

export interface AgentConversationMessageWindowReset {
  reset: true;
  conversationId: string;
  revision: string;
}

export type AgentConversationMessageWindowResult =
  | AgentConversationMessageWindowSuccess
  | AgentConversationMessageWindowReset;

export type AgentSessionSeekResult =
  | Readonly<AgentConversationMessageWindowReset>
  | Readonly<Pick<AgentConversationMessageWindowSuccess, 'reset' | 'revision' | 'focus'>>;

export interface AgentConversationClient {
  /** Required stable keyset page, always ordered oldest to newest. */
  getMessagePage(
    conversationId: string,
    options: AgentConversationMessagePageOptions,
    callOptions?: AgentManagementCallOptions,
  ): Promise<AgentConversationMessagePage>;

  /** One revision-consistent bounded read used for absolute turn/timeline seeks. */
  getMessageWindowAround(
    request: AgentConversationMessageWindowRequest,
    options?: AgentManagementCallOptions,
  ): Promise<AgentConversationMessageWindowResult>;

  /** Required bounded turn detail; request carries its conversation scope. */
  getTurnDetail(
    request: AgentConversationTurnDetailRequest,
    options?: AgentManagementCallOptions,
  ): Promise<AgentConversationTurnDetailResponse>;

  /** Send a user message to the agent. Returns the list of message IDs that were appended. */
  sendMessage(
    conversationId: string,
    content: string,
    attachment?: AgentAttachmentInput,
    wikiTiddlers?: WikiTiddlerAttachment[],
    options?: AgentManagementCallOptions,
  ): Promise<void>;

  /** Subscribe to bounded list projections; full detail is never pushed live. */
  subscribeToMessages(
    conversationId: string,
    listener: (update: AgentConversationUpdate) => void,
  ): () => void;

  /** Append a conversation-scoped turn tombstone with a durable request id. */
  deleteTurn(
    request: AgentConversationDeleteTurnRequest,
    options?: AgentManagementCallOptions,
  ): Promise<AgentConversationDeleteTurnResponse>;

  /** Atomically tombstone the old turn and start the conversation-scoped retry. */
  retryTurn(
    request: AgentConversationRetryTurnRequest,
    options?: AgentManagementCallOptions,
  ): Promise<AgentConversationRetryTurnResponse>;
}

// ─── Prompt Preview Client ─────────────────────────────────────────

/** Exact host request for preparing one retained prompt-preview audit session. */
export interface PromptPreviewPrepareRequest {
  /** Caller-generated cancellation/idempotency scope for the in-flight preparation. */
  requestId: string;
  conversationId: string;
  inputText?: string;
}

/** Progress callback for prompt preview generation. */
export type PromptPreviewStepCode =
  | 'idle'
  | 'starting'
  | 'preparing'
  | 'plugin'
  | 'flatten'
  | 'finalize'
  | 'completing'
  | 'complete'
  | 'error';

export interface PromptPreviewProgress {
  progress: number;
  /** Stable localization key; Core never emits human-language status text. */
  stepCode: Extract<PromptPreviewStepCode, 'plugin' | 'flatten' | 'finalize' | 'completing'>;
  /** Optional bounded host/plugin detail, rendered as untrusted text by the UI. */
  stepDisplay?: string;
  currentPlugin?: string;
}

/** Maximum number of message summaries transferred in one prompt-audit page. */
export const MAX_PROMPT_PREVIEW_AUDIT_PAGE_ENTRIES = 50;
/** Smallest page budget that can always carry one bounded summary plus metadata. */
export const MIN_PROMPT_PREVIEW_AUDIT_PAGE_BYTES = 4 * 1_024;
/** Maximum strict canonical UTF-8 bytes transferred by one prompt-audit page. */
export const MAX_PROMPT_PREVIEW_AUDIT_PAGE_BYTES = 256 * 1_024;
/** Smallest detail budget that can hold any one UTF-8 code point. */
export const MIN_PROMPT_PREVIEW_AUDIT_DETAIL_CHUNK_BYTES = 4;
/** Maximum canonical UTF-8 bytes transferred by one raw audit-detail chunk. */
export const MAX_PROMPT_PREVIEW_AUDIT_DETAIL_CHUNK_BYTES = 256 * 1_024;
/** Maximum strict canonical UTF-8 bytes returned for the generated tree summary. */
export const MAX_PROMPT_PREVIEW_GENERATED_RESULT_BYTES = 256 * 1_024;
/** Maximum UTF-16 code units retained in one untrusted audit summary preview. */
export const MAX_PROMPT_PREVIEW_AUDIT_ENTRY_PREVIEW_CODE_UNITS = 512;

export type PromptPreviewAuditEntrySource =
  | 'system'
  | 'prompt'
  | 'context-compaction-summary'
  | 'conversation-message'
  | 'preview-input'
  | 'tool';

/** Bounded navigation projection. Full message content is never embedded here. */
export interface PromptPreviewAuditEntrySummary {
  entryId: string;
  entryIndex: number;
  role: PortableLlmMessage['role'];
  source: PromptPreviewAuditEntrySource;
  /** Sanitized, bounded plain-text hint for hover/navigation UI. */
  preview: string;
  /** Size of the lossless canonical representation available through detail chunks. */
  canonicalBytes: number;
}

/**
 * One bounded prompt-audit navigation page. Initial pages may be sampled so
 * system/compaction markers and the recent tail can coexist without loading the
 * middle of a very long conversation.
 */
export interface PromptPreviewAuditPage {
  sessionId: string;
  revision: string;
  items: PromptPreviewAuditEntrySummary[];
  totalEntries: number;
  previousCursor?: string;
  nextCursor?: string;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  sampled: boolean;
}

export interface PromptPreviewExecutionRoute {
  providerId: string;
  logicalModelId: string;
  wireModelId: string;
  apiMode: 'chat-completions' | 'responses';
}

export interface PromptPreviewContextStats {
  messageCount: number;
  compactionSummaryCount: number;
}

/** Opaque, bounded handle to an exact request retained by the main/host process. */
export interface PromptPreviewPreparedExecution {
  sessionId: string;
  revision: string;
  route: PromptPreviewExecutionRoute;
  contextStats: PromptPreviewContextStats;
  initialPage: PromptPreviewAuditPage;
}

interface PromptPreviewAuditPageRequestBase {
  sessionId: string;
  expectedRevision: string;
  /** Required caller-selected count bound; hard maximum is 50. */
  limit: number;
  /** Required caller-selected strict canonical UTF-8 bound; hard maximum is 256 KiB. */
  maxBytes: number;
}

/** Cursor values are opaque and scoped to one session revision. */
export type PromptPreviewAuditPageRequest =
  | (PromptPreviewAuditPageRequestBase & { mode: 'before'; cursor: string })
  | (PromptPreviewAuditPageRequestBase & { mode: 'after'; cursor: string })
  | (PromptPreviewAuditPageRequestBase & { mode: 'around'; entryIndex: number });

export type PromptPreviewAuditDetailTarget =
  | { kind: 'request' }
  | { kind: 'entry'; entryId: string; entryIndex: number };

/** Read one bounded chunk of lossless canonical UTF-8 audit data. */
export interface PromptPreviewAuditDetailRequest {
  sessionId: string;
  expectedRevision: string;
  target: PromptPreviewAuditDetailTarget;
  /** Opaque byte continuation; omit for the first chunk. */
  cursor?: string;
  /** Required caller-selected chunk bound; hard maximum is 256 KiB. */
  maxBytes: number;
}

export interface PromptPreviewAuditDetailChunk {
  sessionId: string;
  revision: string;
  target: PromptPreviewAuditDetailTarget;
  /** Raw lossless canonical UTF-8. IPC adapters must transfer it as binary, never a number array. */
  canonicalUtf8: Uint8Array;
  nextCursor?: string;
  complete: boolean;
}

export interface PromptPreviewAuditReleaseRequest {
  sessionId: string;
  expectedRevision: string;
}

/** Result of a bounded prompt-tree preview plus its opaque exact-request audit handle. */
export interface PromptPreviewResult {
  flatPrompts: PromptFlatModelMessage[];
  processedPrompts: PromptNode[];
  /** No full request, messages, or context segments cross the renderer boundary. */
  audit: PromptPreviewPreparedExecution;
}

/** The host must return a bounded projection, never flattened conversation content. */
export interface PromptPreviewGeneratedResult {
  flatPrompts: PromptFlatModelMessage[];
  processedPrompts: PromptNode[];
}

export interface PromptPreviewCallOptions {
  /** Aborted when the view closes or a newer preview supersedes this one. */
  signal: AbortSignal;
}

/** Client contract for generating prompt previews. */
export interface PromptPreviewClient {
  /**
   * Generate a preview of the prompt tree for the given agent state.
   * @param agentFrameworkConfig  The agent's framework configuration
   * @param execution             Opaque exact-request audit session retained by the host
   * @param onProgress            Optional progress callback
   * @param options               Required cancellation fence for host/plugin work
   */
  generatePreview(
    agentFrameworkConfig: AgentFrameworkConfig,
    execution: PromptPreviewPreparedExecution,
    onProgress: ((progress: PromptPreviewProgress) => void) | undefined,
    options: PromptPreviewCallOptions,
  ): Promise<PromptPreviewGeneratedResult | null>;

  /** Load a bounded before/after/around navigation page from the retained request. */
  getAuditPage(
    request: PromptPreviewAuditPageRequest,
    options: PromptPreviewCallOptions,
  ): Promise<PromptPreviewAuditPage>;

  /** Load bounded lossless canonical UTF-8 for one message or the entire request. */
  getAuditDetail(
    request: PromptPreviewAuditDetailRequest,
    options: PromptPreviewCallOptions,
  ): Promise<PromptPreviewAuditDetailChunk>;

  /** Release retained host memory. Missing/already-released sessions are idempotent. */
  releaseAuditSession(request: PromptPreviewAuditReleaseRequest): Promise<void> | void;
}

// ─── Scheduled Task Client ─────────────────────────────────────────

/** Scheduled task input. */
export interface CreateScheduledTaskInput {
  agentInstanceId: string;
  agentDefinitionId: string;
  name: string;
  scheduleKind: 'cron' | 'at';
  schedule: { kind: 'cron'; expression: string; timezone?: string } | { kind: 'at'; wakeAtISO: string };
  payload?: { message: string };
  activeHoursStart?: string;
  activeHoursEnd?: string;
  createdBy?: string;
  enabled?: boolean;
  /** PeerId of the device that owns and executes this task. */
  executionNodeId: string;
  executionNodeLabel?: string;
  /** PeerId that originally created the task metadata. */
  originNodeId: string;
}

export type ScheduledTaskState = 'active' | 'paused' | 'completed' | 'cancelled' | 'archived';

export interface ListScheduledTasksOptions {
  /** Defaults to `['active', 'paused']`; terminal rows are never fetched accidentally. */
  states?: ScheduledTaskState[];
  executionNodeIds?: string[];
  /** Opaque forward-only keyset cursor returned by the preceding page. */
  cursor?: string;
  /** Bounded page size; adapters must not silently fetch or discard another page. */
  limit?: number;
  /** Strict canonical UTF-8 budget for this page (default/hard max: 256 KiB). */
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface ScheduledTaskPage {
  items: ScheduledTask[];
  nextCursor?: string;
  hasMoreAfter: boolean;
  /** True when at least one selected source could not provide a live complete page. */
  partial: boolean;
  /** Bounded provenance for every source considered by this page (at most 64). */
  sources: ScheduledTaskPageSource[];
}

export interface ScheduledTaskPageSource {
  executionNodeId: string;
  state: 'online' | 'offline' | 'degraded';
  fromCache: boolean;
}

/** Scheduled task model. */
export interface ScheduledTask {
  id: string;
  agentInstanceId: string;
  agentDefinitionId: string;
  name: string;
  schedule: CreateScheduledTaskInput['schedule'];
  payload?: { message?: string };
  activeHoursStart?: string;
  activeHoursEnd?: string;
  enabled: boolean;
  createdBy?: string;
  state: ScheduledTaskState;
  executionNodeId: string;
  executionNodeLabel?: string;
  originNodeId: string;
  updatedAt?: string;
  /** Durable execution projection maintained by the owning execution node. */
  nextRunAt?: string;
  lastRunAt?: string;
  lastRunStatus?: 'succeeded' | 'failed';
  lastError?: string;
  lastFailureAt?: string;
  consecutiveFailures?: number;
  nextRetryAt?: string;
  runCount?: number;
  maxRuns?: number;
  deleteAfterRun?: boolean;
  /** Monotonic host CAS fence for timer/config races. */
  executionRevision?: number;
  /** Stable idempotency key for the currently scheduled occurrence/retries. */
  occurrenceId?: string;
  occurrenceScheduledFor?: string;
  occurrenceAttempt?: number;
}

/** Client contract for managing scheduled tasks. */
export interface ScheduledTaskClient {
  listScheduledTasksForAgent(
    agentInstanceId: string,
    options?: ListScheduledTasksOptions,
  ): Promise<ScheduledTaskPage>;
  createScheduledTask(input: CreateScheduledTaskInput, options?: AgentManagementCallOptions): Promise<ScheduledTask>;
  updateScheduledTask(
    id: string,
    input: Partial<CreateScheduledTaskInput>,
    options?: AgentManagementCallOptions,
  ): Promise<ScheduledTask>;
  deleteScheduledTask(id: string, options?: AgentManagementCallOptions): Promise<void>;
  getCronPreviewDates(
    expression: string,
    timezone?: string,
    count?: number,
    options?: AgentManagementCallOptions,
  ): Promise<string[]>;
}

// ─── Agent Creation Wizard State ───────────────────────────────────

/** State for the "Create New Agent" wizard. */
export interface AgentCreationState {
  /** Current step index in the creation wizard. */
  currentStep: number;
  /** Agent name entered by the user. */
  agentName: string;
  /** Selected template definition, if any. */
  selectedTemplate: AgentDefinition | null;
  /** Temporary agent definition being built. */
  temporaryAgentDefinition: AgentDefinition | null;
  /** ID of the preview agent instance created for testing. */
  previewAgentId: string | null;
  /** Whether a loading operation is in progress. */
  isLoading: boolean;
  /** JSON Schema for the selected agent framework, if loaded. */
  promptSchema: Record<string, unknown> | null;
}

// ─── Agent Definition Editor State ─────────────────────────────────

/** State for the "Edit Agent Definition" view. */
export interface AgentDefinitionEditorState {
  /** The agent definition being edited. */
  agentDefinition: AgentDefinition | null;
  /** Agent name. */
  agentName: string;
  /** ID of the preview agent instance. */
  previewAgentId: string | null;
  /** Whether a loading operation is in progress. */
  isLoading: boolean;
  /** Whether a save operation is in progress. */
  isSaving: boolean;
  /** JSON Schema for the selected agent framework, if loaded. */
  promptSchema: Record<string, unknown> | null;
}

// ─── Prompt Preview State ──────────────────────────────────────────

/** State for the prompt preview/edit dialog. */
export interface PromptPreviewDialogState {
  open: boolean;
  baseMode: 'preview' | 'edit';
  activeTab: 'flat' | 'tree';
  loading: boolean;
  progress: number;
  currentStep: PromptPreviewStepCode;
  /** Optional bounded untrusted detail associated with currentStep. */
  currentStepDisplay: string | null;
  currentPlugin: string | null;
  result: PromptPreviewResult | null;
  lastUpdated: Date | null;
  formFieldsToScrollTo: string[];
}
