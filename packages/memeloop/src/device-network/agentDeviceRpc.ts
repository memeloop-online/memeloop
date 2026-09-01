import type { AgentDefinition } from '../agent/types.js';
import {
  assertCanonicalChatMessageProjection,
  conversationEventToMessage,
  type ConversationMessageEvent,
  type ConversationTombstoneEvent,
  isConversationEvent,
  MAX_CONVERSATION_EVENT_BYTES,
} from '../conversation/events.js';
import type { AttachmentReference, ChatMessage } from '../conversation/types.js';
import { canonicalJsonBytes } from '../encoding/canonicalJson.js';
import type { PendingLocalChatMessage } from '../loopAPI/types.js';
import { normalizeAgentRunError } from '../runState.js';
import type { MemeLoopRunState, MemeLoopRunStatus } from '../runtime.js';
import {
  assertConversationMessageProjection,
  assertConversationTimelineCompactionEntry,
  assertConversationTimelinePage,
  assertConversationTimelinePageEnvelope,
  MAX_CONVERSATION_MESSAGE_WINDOW_BYTES,
  MAX_CONVERSATION_MESSAGE_WINDOW_SIZE,
  MAX_CONVERSATION_TIMELINE_PAGE_BYTES,
  MAX_CONVERSATION_TIMELINE_PAGE_SIZE,
  MAX_MESSAGE_PAGE_SIZE,
} from '../storage/conversationPaging.js';
import type {
  ConversationMessageListProjection,
  ConversationMessageWindowFocus,
  ConversationMessageWindowResolvedFocus,
  ConversationTimelineEntry,
  ConversationTimelinePage,
} from '../storage/ports.js';
import type { ConversationMeta } from '../sync/protocol.js';
import { AGENT_USER_MESSAGE_LIMITS, assertAgentUserMessageWithinLimits } from '../userMessageAdmission.js';
import {
  assertAttachmentUploadRpcRequest,
  assertAttachmentUploadRpcResponseCorrelation,
  ATTACHMENT_UPLOAD_LIMITS,
  ATTACHMENT_UPLOAD_RPC_METHODS,
  ATTACHMENT_UPLOAD_SHA256_PATTERN,
  type AttachmentUploadRpcMethod,
  type AttachmentUploadRpcRequest,
  type AttachmentUploadRpcResponse,
  type BeginAttachmentUploadRequest,
  type BeginAttachmentUploadResponse,
  type CommitAttachmentUploadRequest,
  type CommitAttachmentUploadResponse,
  parseAttachmentUploadRpcResponse,
  type UploadAttachmentChunkRequest,
  type UploadAttachmentChunkResponse,
} from './attachmentUpload.js';
import {
  assertScheduledTaskRpcRequest,
  assertScheduledTaskRpcResponseCorrelation,
  getScheduledTaskRpcGrantResources,
  isScheduledTaskRpcMethod,
  parseScheduledTaskRpcResponse,
  SCHEDULED_TASK_RPC_METHODS,
  type ScheduledTaskRpcContract,
  type ScheduledTaskRpcMethod,
  type ScheduledTaskRpcRequest,
  type ScheduledTaskRpcResponse,
} from './scheduledTaskRpc.js';

export * from './attachmentUpload.js';
export * from './scheduledTaskRpc.js';

/** Portable limits shared by RPC handlers and every browser/mobile client. */
export const AGENT_DEVICE_RPC_LIMITS = Object.freeze(
  {
    conversationListPage: 100,
    conversationListBytes: 1024 * 1024,
    turnListPage: MAX_CONVERSATION_MESSAGE_WINDOW_SIZE,
    turnDetailPage: 50,
    turnDetailDefaultBytes: 256 * 1024,
    projectionPageDefaultBytes: MAX_CONVERSATION_MESSAGE_WINDOW_BYTES,
    projectionPageMaxBytes: MAX_CONVERSATION_MESSAGE_WINDOW_BYTES,
    projectionPageMinBytes: 64 * 1024,
    turnProjectionBytes: MAX_CONVERSATION_MESSAGE_WINDOW_BYTES,
    turnRenderLines: 20_000,
    definitions: 256,
    definitionsBytes: 2 * 1024 * 1024,
    messagePage: MAX_MESSAGE_PAGE_SIZE,
    timelinePage: MAX_CONVERSATION_TIMELINE_PAGE_SIZE,
    /** Timeline has a storage-aligned budget independent of chat detail pages. */
    timelinePageDefaultBytes: MAX_CONVERSATION_TIMELINE_PAGE_BYTES,
    timelinePageMaxBytes: MAX_CONVERSATION_TIMELINE_PAGE_BYTES,
    timelinePreviewCharacters: 240,
    loadAroundMessages: MAX_CONVERSATION_MESSAGE_WINDOW_SIZE,
    loadAroundDefaultBytes: MAX_CONVERSATION_MESSAGE_WINDOW_BYTES,
    loadAroundMaxBytes: MAX_CONVERSATION_MESSAGE_WINDOW_BYTES,
    messageProjectionBytes: 128 * 1024,
    messagePageBytes: MAX_CONVERSATION_MESSAGE_WINDOW_BYTES,
    detailChunkBytes: 3 * 1024 * 1024,
    messageDetailBytes: 64 * 1024 * 1024,
    attachmentChunkBytes: 3 * 1024 * 1024,
    runLogPage: 50,
    runLogContentCharacters: 32 * 1024,
    runLogPageBytes: 256 * 1024,
    identifierCharacters: 512,
    cursorCharacters: 2_048,
    userMessageAttachments: 32,
    userMessageBytes: AGENT_USER_MESSAGE_LIMITS.canonicalMessageBytes,
  } as const,
);

export const AGENT_DEVICE_RPC_METHODS = Object.freeze(
  {
    getDefinitions: 'memeloop.agent.getDefinitions',
    create: 'memeloop.agent.create',
    send: 'memeloop.agent.send',
    runTurn: 'memeloop.agent.runTurn',
    getRunStatus: 'memeloop.agent.getRunStatus',
    cancel: 'memeloop.agent.cancel',
    deleteTurn: 'memeloop.chat.deleteTurn',
    retryTurn: 'memeloop.chat.retryTurn',
    listConversations: 'memeloop.chat.listConversations',
    getConversationMeta: 'memeloop.chat.getConversationMeta',
    listTurns: 'memeloop.chat.listTurns',
    getTurnDetail: 'memeloop.chat.getTurnDetail',
    getMessagePage: 'memeloop.chat.getMessagePage',
    getConversationTimelinePage: 'memeloop.chat.getConversationTimelinePage',
    loadAround: 'memeloop.chat.loadAround',
    getMessageDetail: 'memeloop.chat.getMessageDetail',
    getAttachmentChunk: 'memeloop.chat.getAttachmentChunk',
    beginAttachmentUpload: ATTACHMENT_UPLOAD_RPC_METHODS.begin,
    uploadAttachmentChunk: ATTACHMENT_UPLOAD_RPC_METHODS.chunk,
    commitAttachmentUpload: ATTACHMENT_UPLOAD_RPC_METHODS.commit,
    pullAgentRunLog: 'memeloop.chat.pullAgentRunLog',
    scheduleList: SCHEDULED_TASK_RPC_METHODS.list,
    scheduleGet: SCHEDULED_TASK_RPC_METHODS.get,
    scheduleCreate: SCHEDULED_TASK_RPC_METHODS.create,
    scheduleUpdate: SCHEDULED_TASK_RPC_METHODS.update,
    scheduleDelete: SCHEDULED_TASK_RPC_METHODS.delete,
    scheduleCronPreview: SCHEDULED_TASK_RPC_METHODS.cronPreview,
  } as const,
);

export type AgentDeviceRpcMethod = typeof AGENT_DEVICE_RPC_METHODS[keyof typeof AGENT_DEVICE_RPC_METHODS];

const AGENT_DEVICE_RPC_METHOD_SET = new Set<string>(Object.values(AGENT_DEVICE_RPC_METHODS));

export function isAgentDeviceRpcMethod(value: unknown): value is AgentDeviceRpcMethod {
  return typeof value === 'string' && AGENT_DEVICE_RPC_METHOD_SET.has(value);
}

export interface AgentDeviceRpcGrantResources {
  conversationId?: string;
  definitionId?: string;
  /** Resolve this durable run before authorizing; parameters alone are insufficient. */
  runId?: string;
  /** Transport target checked by the embedded schedule handler, not Cloud grant authority. */
  executionNodeId?: string;
}

/**
 * Validate parameters and extract only caller-asserted scope hints. `runId`
 * methods must still replace these hints with the durable run record before
 * calling the shared grant authorizer.
 */
export function parseAgentDeviceRpcGrantResources(
  method: string,
  parameters: unknown,
): AgentDeviceRpcGrantResources {
  if (!isAgentDeviceRpcMethod(method)) throw new AgentDeviceRpcProtocolError('method');
  assertAgentDeviceRpcRequest(method, parameters);
  return getAgentDeviceRpcGrantResources(method, parameters);
}

/** Extract grant resources from a request already checked at a trust boundary. */
export function getAgentDeviceRpcGrantResources<M extends AgentDeviceRpcMethod>(
  method: M,
  parameters: AgentDeviceRpcRequest<M>,
): AgentDeviceRpcGrantResources {
  const record = parameters as Record<string, unknown>;
  switch (method) {
    case AGENT_DEVICE_RPC_METHODS.getDefinitions:
    case AGENT_DEVICE_RPC_METHODS.listConversations:
      return {};
    case AGENT_DEVICE_RPC_METHODS.create:
      return {
        definitionId: record.definitionId as string,
        ...(record.conversationId === undefined ? {} : { conversationId: record.conversationId as string }),
      };
    case AGENT_DEVICE_RPC_METHODS.send:
      return {
        conversationId: record.conversationId as string,
        ...(record.definitionId === undefined ? {} : { definitionId: record.definitionId as string }),
      };
    case AGENT_DEVICE_RPC_METHODS.runTurn:
      return {
        conversationId: record.conversationId as string,
        definitionId: record.definitionId as string,
      };
    case AGENT_DEVICE_RPC_METHODS.getRunStatus:
    case AGENT_DEVICE_RPC_METHODS.cancel:
      return { runId: record.runId as string };
    case AGENT_DEVICE_RPC_METHODS.pullAgentRunLog:
      return {
        conversationId: record.conversationId as string,
        runId: record.runId as string,
      };
    case AGENT_DEVICE_RPC_METHODS.retryTurn:
      return {
        conversationId: record.conversationId as string,
        ...(record.definitionId === undefined ? {} : { definitionId: record.definitionId as string }),
      };
    case AGENT_DEVICE_RPC_METHODS.beginAttachmentUpload:
    case AGENT_DEVICE_RPC_METHODS.uploadAttachmentChunk:
    case AGENT_DEVICE_RPC_METHODS.commitAttachmentUpload:
      return { conversationId: record.conversationId as string };
    case AGENT_DEVICE_RPC_METHODS.deleteTurn:
    case AGENT_DEVICE_RPC_METHODS.getConversationMeta:
    case AGENT_DEVICE_RPC_METHODS.listTurns:
    case AGENT_DEVICE_RPC_METHODS.getTurnDetail:
    case AGENT_DEVICE_RPC_METHODS.getMessagePage:
    case AGENT_DEVICE_RPC_METHODS.getConversationTimelinePage:
    case AGENT_DEVICE_RPC_METHODS.loadAround:
    case AGENT_DEVICE_RPC_METHODS.getMessageDetail:
    case AGENT_DEVICE_RPC_METHODS.getAttachmentChunk:
      return { conversationId: record.conversationId as string };
    case AGENT_DEVICE_RPC_METHODS.scheduleList:
    case AGENT_DEVICE_RPC_METHODS.scheduleGet:
    case AGENT_DEVICE_RPC_METHODS.scheduleCreate:
    case AGENT_DEVICE_RPC_METHODS.scheduleUpdate:
    case AGENT_DEVICE_RPC_METHODS.scheduleDelete:
    case AGENT_DEVICE_RPC_METHODS.scheduleCronPreview: {
      const resources = getScheduledTaskRpcGrantResources(
        method,
        parameters as ScheduledTaskRpcRequest<ScheduledTaskRpcMethod>,
      );
      return {
        ...(resources.conversationId === undefined ? {} : { conversationId: resources.conversationId }),
        ...(resources.definitionId === undefined ? {} : { definitionId: resources.definitionId }),
        ...(resources.executionNodeId === undefined ? {} : { executionNodeId: resources.executionNodeId }),
      };
    }
  }
}

export type AgentDeviceRpcGetDefinitionsRequest = Record<string, never>;

export interface AgentDeviceRpcGetDefinitionsResponse {
  definitions: AgentDefinition[];
}

export interface AgentDeviceRpcCreateRequest {
  definitionId: string;
  initialMessage?: string;
  conversationId?: string;
}

export interface AgentDeviceRpcCreateResponse {
  conversationId: string;
}

export interface AgentDeviceRpcSendRequest {
  /** Caller-generated durable idempotency key. Reuse it for transport retries. */
  requestId: string;
  /** Stable logical turn identity, independent of its individual messages. */
  turnId: string;
  conversationId: string;
  message: string;
  definitionId?: string;
  /** Local-event payload only; the server allocates origin sequence and Lamport identity. */
  userMessage?: AgentDeviceRpcPendingUserMessage;
}

export type AgentDeviceRpcPendingUserMessage = Omit<
  PendingLocalChatMessage,
  'messageId' | 'turnId' | 'originNodeId' | 'timestamp'
>;

/**
 * Detach a persisted canonical user root into the exact pending RPC payload.
 * Hosts must use this helper instead of maintaining field-by-field clones that
 * drift whenever ChatMessage evolves.
 */
export function agentDeviceRpcPendingUserMessageFromChatMessage(
  message: ChatMessage,
): AgentDeviceRpcPendingUserMessage {
  if (message.role !== 'user') throw new TypeError('agent RPC pending message must originate from a user root');
  const {
    messageId: _messageId,
    turnId: _turnId,
    originNodeId: _originNodeId,
    timestamp: _timestamp,
    conversationId: _conversationId,
    originSequence: _originSequence,
    lamportClock: _lamportClock,
    role: _role,
    ...pending
  } = message;
  return pending;
}

export interface AgentDeviceRpcRunTurnRequest extends AgentDeviceRpcSendRequest {
  definitionId: string;
  conversation?: ConversationMeta;
}

export interface AgentDeviceRpcTurnAcceptedResponse {
  ok: true;
  runId: string;
  requestId: string;
  turnId: string;
  conversationId: string;
  state: 'accepted';
}

export interface AgentDeviceRpcGetRunStatusRequest {
  runId: string;
}

export interface AgentDeviceRpcGetRunStatusResponse {
  status: AgentDeviceRpcRunStatus | null;
}

export interface AgentDeviceRpcCancelRequest {
  runId: string;
}

export interface AgentDeviceRpcCancelResponse {
  ok: boolean;
  status: AgentDeviceRpcRunStatus | null;
}

export interface AgentDeviceRpcRunStatus extends MemeLoopRunStatus {
  requestId: string;
  turnId: string;
}

export interface AgentDeviceRpcDeleteTurnRequest {
  conversationId: string;
  turnId: string;
  requestId: string;
  reason?: ConversationTombstoneEvent['reason'];
}

/** Deletion is an auditable append; implementations must never remove rows. */
export interface AgentDeviceRpcDeleteTurnResponse {
  ok: true;
  conversationId: string;
  turnId: string;
  requestId: string;
  tombstone: ConversationTombstoneEvent;
}

export interface AgentDeviceRpcRetryTurnRequest {
  conversationId: string;
  /** Existing turn hidden by the atomically appended tombstone. */
  turnId: string;
  requestId: string;
  /** New stable turn identity; must differ from turnId. */
  newTurnId: string;
  definitionId?: string;
}

/** Atomic retry result: tombstone(old), user event(new), then one durable run. */
export interface AgentDeviceRpcRetryTurnResponse extends AgentDeviceRpcTurnAcceptedResponse {
  tombstone: ConversationTombstoneEvent;
  userEvent: ConversationMessageEvent;
}

export interface AgentDeviceRpcListConversationsRequest {
  limit?: number;
  /** Opaque stable keyset cursor. Callers must never parse or synthesize it. */
  cursor?: string;
  /** Ask the server whether a previously rendered cursor is still retained. */
  seenCursor?: string;
  direction?: 'backward' | 'forward';
}

export interface AgentDeviceRpcListConversationsResponse {
  items: ConversationMeta[];
  nextCursor?: string;
  previousCursor?: string;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  seenCursorFound?: boolean;
}

export interface AgentDeviceRpcGetConversationMetaRequest {
  conversationId: string;
}

export interface AgentDeviceRpcGetConversationMetaResponse {
  meta: ConversationMeta | null;
}

export type AgentDeviceRpcTurnDetailState = 'summary' | 'full' | 'notLoaded';

export interface AgentDeviceRpcTurnParticipantPreview {
  actorId: string;
  actorLabel: string;
  role: 'assistant' | 'agent';
  preview: string;
}

export interface AgentDeviceRpcTurnSummary {
  turnId: string;
  conversationId: string;
  /** Opaque navigation cursor supplied back to list/load APIs unchanged. */
  cursor: string;
  startedAt: number;
  updatedAt: number;
  userPreview: string;
  participantPreviews: AgentDeviceRpcTurnParticipantPreview[];
  responseCount: number;
  runState?: MemeLoopRunState;
  isCompaction: boolean;
  compactedMessageCount?: number;
  isTombstone: boolean;
  detailState: AgentDeviceRpcTurnDetailState;
  /** Present only when the bounded list projection could include the whole turn. */
  messages?: ChatMessage[];
}

export interface AgentDeviceRpcListTurnsRequest {
  conversationId: string;
  cursor?: string;
  seenCursor?: string;
  direction?: 'backward' | 'forward';
  limit?: number;
  byteBudget?: number;
  renderLineBudget?: number;
}

export interface AgentDeviceRpcListTurnsResponse {
  items: AgentDeviceRpcTurnSummary[];
  nextCursor?: string;
  previousCursor?: string;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  seenCursorFound?: boolean;
  budget: {
    bytes: number;
    renderLines: number;
    truncated: boolean;
  };
}

export interface AgentDeviceRpcGetTurnDetailRequest {
  conversationId: string;
  turnId: string;
  cursor?: string;
  seenCursor?: string;
  direction?: 'backward' | 'forward';
  limit?: number;
  maxBytes?: number;
}

export interface AgentDeviceRpcGetTurnDetailResponse {
  turnId: string;
  items: ChatMessage[];
  nextCursor?: string;
  previousCursor?: string;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  seenCursorFound?: boolean;
}

export interface AgentDeviceRpcGetMessagePageRequest {
  conversationId: string;
  limit?: number;
  /** Opaque item cursor; the server owns its storage/keyset encoding. */
  cursor?: string;
  /** Required when replaying a revision-scoped cursor returned by loadAround. */
  expectedRevision?: string;
  seenCursor?: string;
  direction?: 'backward' | 'forward';
  /** UTF-8 JSON response budget. Defaults to and cannot exceed 256 KiB. */
  maxBytes?: number;
}

export type AgentDeviceRpcGetMessagePageResponse =
  | { reset: true; conversationId: string; revision: string }
  | {
    reset: false;
    conversationId: string;
    revision: string;
    items: ChatMessage[];
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
    nextCursor?: string;
    previousCursor?: string;
    seenCursorFound?: boolean;
  };

export interface AgentDeviceRpcGetConversationTimelinePageRequest {
  conversationId: string;
  limit?: number;
  maxBytes?: number;
  expectedRevision?: string;
  /** At most one navigation selector; none reads the latest page. */
  beforeCursor?: string;
  afterCursor?: string;
  aroundEntryIndex?: number;
}

export type AgentDeviceRpcTimelineEntry = ConversationTimelineEntry;
export type AgentDeviceRpcGetConversationTimelinePageResponse = ConversationTimelinePage;

export interface AgentDeviceRpcLoadAroundRequest {
  conversationId: string;
  focus: ConversationMessageWindowFocus;
  expectedRevision: string;
  maxMessages?: number;
  maxBytes?: number;
}

export type AgentDeviceRpcLoadAroundResponse =
  | {
    reset: true;
    conversationId: string;
    revision: string;
  }
  | {
    reset: false;
    conversationId: string;
    revision: string;
    focus: ConversationMessageWindowResolvedFocus;
    recenterAnchor?: { messageId: string; turnId: string };
    items: ConversationMessageListProjection[];
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
    /** Opaque cursor for a backward getMessagePage read. */
    previousCursor?: string;
    /** Opaque cursor for a forward getMessagePage read. */
    nextCursor?: string;
  };

export interface AgentDeviceRpcGetMessageDetailRequest {
  conversationId: string;
  messageId: string;
  offset?: number;
}

export type AgentDeviceRpcGetMessageDetailResponse =
  | { found: false }
  | AgentDeviceRpcJsonChunk;

export interface AgentDeviceRpcJsonChunk {
  found: true;
  encoding: 'base64-json';
  data: string;
  offset: number;
  totalBytes: number;
  nextOffset?: number;
}

export interface AgentDeviceRpcGetAttachmentChunkRequest {
  /** Required for resource-scope authorization; a hash alone is enumerable. */
  conversationId: string;
  contentHash: string;
  offset?: number;
}

export type AgentDeviceRpcGetAttachmentChunkResponse =
  | { found: false }
  | AgentDeviceRpcAttachmentChunk;

export interface AgentDeviceRpcAttachmentChunk {
  found: true;
  reference: AttachmentReference;
  encoding: 'base64';
  data: string;
  offset: number;
  totalBytes: number;
  nextOffset?: number;
}

export interface AgentDeviceRpcPullAgentRunLogRequest {
  conversationId: string;
  runId: string;
  cursor?: string;
  limit?: number;
  maxBytes?: number;
}

export interface AgentDeviceRpcRunLogMessage {
  messageId: string;
  role: ChatMessage['role'];
  content: string;
}

export interface AgentDeviceRpcPullAgentRunLogResponse {
  messages: AgentDeviceRpcRunLogMessage[];
  nextCursor?: string;
  hasMoreAfter: boolean;
  runStatus: AgentDeviceRpcRunStatus | null;
}

export interface AgentDeviceRpcContract {
  [AGENT_DEVICE_RPC_METHODS.getDefinitions]: {
    request: AgentDeviceRpcGetDefinitionsRequest;
    response: AgentDeviceRpcGetDefinitionsResponse;
  };
  [AGENT_DEVICE_RPC_METHODS.create]: {
    request: AgentDeviceRpcCreateRequest;
    response: AgentDeviceRpcCreateResponse;
  };
  [AGENT_DEVICE_RPC_METHODS.send]: {
    request: AgentDeviceRpcSendRequest;
    response: AgentDeviceRpcTurnAcceptedResponse;
  };
  [AGENT_DEVICE_RPC_METHODS.runTurn]: {
    request: AgentDeviceRpcRunTurnRequest;
    response: AgentDeviceRpcTurnAcceptedResponse;
  };
  [AGENT_DEVICE_RPC_METHODS.getRunStatus]: {
    request: AgentDeviceRpcGetRunStatusRequest;
    response: AgentDeviceRpcGetRunStatusResponse;
  };
  [AGENT_DEVICE_RPC_METHODS.cancel]: {
    request: AgentDeviceRpcCancelRequest;
    response: AgentDeviceRpcCancelResponse;
  };
  [AGENT_DEVICE_RPC_METHODS.deleteTurn]: {
    request: AgentDeviceRpcDeleteTurnRequest;
    response: AgentDeviceRpcDeleteTurnResponse;
  };
  [AGENT_DEVICE_RPC_METHODS.retryTurn]: {
    request: AgentDeviceRpcRetryTurnRequest;
    response: AgentDeviceRpcRetryTurnResponse;
  };
  [AGENT_DEVICE_RPC_METHODS.listConversations]: {
    request: AgentDeviceRpcListConversationsRequest;
    response: AgentDeviceRpcListConversationsResponse;
  };
  [AGENT_DEVICE_RPC_METHODS.getConversationMeta]: {
    request: AgentDeviceRpcGetConversationMetaRequest;
    response: AgentDeviceRpcGetConversationMetaResponse;
  };
  [AGENT_DEVICE_RPC_METHODS.listTurns]: {
    request: AgentDeviceRpcListTurnsRequest;
    response: AgentDeviceRpcListTurnsResponse;
  };
  [AGENT_DEVICE_RPC_METHODS.getTurnDetail]: {
    request: AgentDeviceRpcGetTurnDetailRequest;
    response: AgentDeviceRpcGetTurnDetailResponse;
  };
  [AGENT_DEVICE_RPC_METHODS.getMessagePage]: {
    request: AgentDeviceRpcGetMessagePageRequest;
    response: AgentDeviceRpcGetMessagePageResponse;
  };
  [AGENT_DEVICE_RPC_METHODS.getConversationTimelinePage]: {
    request: AgentDeviceRpcGetConversationTimelinePageRequest;
    response: AgentDeviceRpcGetConversationTimelinePageResponse;
  };
  [AGENT_DEVICE_RPC_METHODS.loadAround]: {
    request: AgentDeviceRpcLoadAroundRequest;
    response: AgentDeviceRpcLoadAroundResponse;
  };
  [AGENT_DEVICE_RPC_METHODS.getMessageDetail]: {
    request: AgentDeviceRpcGetMessageDetailRequest;
    response: AgentDeviceRpcGetMessageDetailResponse;
  };
  [AGENT_DEVICE_RPC_METHODS.getAttachmentChunk]: {
    request: AgentDeviceRpcGetAttachmentChunkRequest;
    response: AgentDeviceRpcGetAttachmentChunkResponse;
  };
  [AGENT_DEVICE_RPC_METHODS.pullAgentRunLog]: {
    request: AgentDeviceRpcPullAgentRunLogRequest;
    response: AgentDeviceRpcPullAgentRunLogResponse;
  };
  [AGENT_DEVICE_RPC_METHODS.beginAttachmentUpload]: {
    request: BeginAttachmentUploadRequest;
    response: BeginAttachmentUploadResponse;
  };
  [AGENT_DEVICE_RPC_METHODS.uploadAttachmentChunk]: {
    request: UploadAttachmentChunkRequest;
    response: UploadAttachmentChunkResponse;
  };
  [AGENT_DEVICE_RPC_METHODS.commitAttachmentUpload]: {
    request: CommitAttachmentUploadRequest;
    response: CommitAttachmentUploadResponse;
  };
  [AGENT_DEVICE_RPC_METHODS.scheduleList]: ScheduledTaskRpcContract[typeof SCHEDULED_TASK_RPC_METHODS.list];
  [AGENT_DEVICE_RPC_METHODS.scheduleGet]: ScheduledTaskRpcContract[typeof SCHEDULED_TASK_RPC_METHODS.get];
  [AGENT_DEVICE_RPC_METHODS.scheduleCreate]: ScheduledTaskRpcContract[typeof SCHEDULED_TASK_RPC_METHODS.create];
  [AGENT_DEVICE_RPC_METHODS.scheduleUpdate]: ScheduledTaskRpcContract[typeof SCHEDULED_TASK_RPC_METHODS.update];
  [AGENT_DEVICE_RPC_METHODS.scheduleDelete]: ScheduledTaskRpcContract[typeof SCHEDULED_TASK_RPC_METHODS.delete];
  [AGENT_DEVICE_RPC_METHODS.scheduleCronPreview]: ScheduledTaskRpcContract[typeof SCHEDULED_TASK_RPC_METHODS.cronPreview];
}

export type AgentDeviceRpcRequest<M extends AgentDeviceRpcMethod> = AgentDeviceRpcContract[M]['request'];
export type AgentDeviceRpcResponse<M extends AgentDeviceRpcMethod> = AgentDeviceRpcContract[M]['response'];

export class AgentDeviceRpcProtocolError extends Error {
  readonly code = 'invalid_agent_device_rpc' as const;

  constructor(readonly field: string) {
    super(`Invalid Agent device RPC ${field}`);
    this.name = 'AgentDeviceRpcProtocolError';
  }
}

/** Validate untrusted inbound parameters before dispatching to the local runtime. */
export function assertAgentDeviceRpcRequest<M extends AgentDeviceRpcMethod>(
  method: M,
  value: unknown,
): asserts value is AgentDeviceRpcRequest<M> {
  assertAgentDeviceRpcRequestEnvelope(value);
  const record = asRecord(value, 'request');
  switch (method) {
    case AGENT_DEVICE_RPC_METHODS.getDefinitions:
      assertOnlyKeys(record, [], 'request');
      return;
    case AGENT_DEVICE_RPC_METHODS.create:
      assertOnlyKeys(record, ['definitionId', 'initialMessage', 'conversationId'], 'request');
      assertIdentifier(record.definitionId, 'request.definitionId');
      optionalString(record.initialMessage, 'request.initialMessage');
      optionalIdentifier(record.conversationId, 'request.conversationId');
      return;
    case AGENT_DEVICE_RPC_METHODS.send:
      assertOnlyKeys(record, ['requestId', 'turnId', 'conversationId', 'message', 'definitionId', 'userMessage'], 'request');
      assertSendRequest(record, false);
      return;
    case AGENT_DEVICE_RPC_METHODS.runTurn:
      assertOnlyKeys(record, [
        'requestId',
        'turnId',
        'conversationId',
        'message',
        'definitionId',
        'userMessage',
        'conversation',
      ], 'request');
      assertSendRequest(record, true);
      optionalConversationMeta(record.conversation, 'request.conversation');
      return;
    case AGENT_DEVICE_RPC_METHODS.getRunStatus:
    case AGENT_DEVICE_RPC_METHODS.cancel:
      assertOnlyKeys(record, ['runId'], 'request');
      assertIdentifier(record.runId, 'request.runId');
      return;
    case AGENT_DEVICE_RPC_METHODS.deleteTurn:
      assertOnlyKeys(record, ['conversationId', 'turnId', 'requestId', 'reason'], 'request');
      assertTurnControlIdentity(record);
      if (
        record.reason !== undefined &&
        record.reason !== 'user-delete' &&
        record.reason !== 'retention' &&
        record.reason !== 'redaction'
      ) fail('request.reason');
      return;
    case AGENT_DEVICE_RPC_METHODS.retryTurn:
      assertOnlyKeys(record, [
        'conversationId',
        'turnId',
        'requestId',
        'newTurnId',
        'definitionId',
      ], 'request');
      assertTurnControlIdentity(record);
      assertIdentifier(record.newTurnId, 'request.newTurnId');
      if (record.newTurnId === record.turnId) fail('request.newTurnId');
      optionalIdentifier(record.definitionId, 'request.definitionId');
      return;
    case AGENT_DEVICE_RPC_METHODS.listConversations:
      assertOnlyKeys(record, ['limit', 'cursor', 'seenCursor', 'direction'], 'request');
      optionalBoundedInteger(record.limit, 'request.limit', 1, AGENT_DEVICE_RPC_LIMITS.conversationListPage);
      optionalCursorString(record.cursor, 'request.cursor');
      optionalCursorString(record.seenCursor, 'request.seenCursor');
      optionalDirection(record.direction, 'request.direction');
      return;
    case AGENT_DEVICE_RPC_METHODS.getConversationMeta:
      assertOnlyKeys(record, ['conversationId'], 'request');
      assertIdentifier(record.conversationId, 'request.conversationId');
      return;
    case AGENT_DEVICE_RPC_METHODS.listTurns:
      assertOnlyKeys(record, [
        'conversationId',
        'cursor',
        'seenCursor',
        'direction',
        'limit',
        'byteBudget',
        'renderLineBudget',
      ], 'request');
      assertIdentifier(record.conversationId, 'request.conversationId');
      optionalCursorString(record.cursor, 'request.cursor');
      optionalCursorString(record.seenCursor, 'request.seenCursor');
      optionalDirection(record.direction, 'request.direction');
      optionalBoundedInteger(record.limit, 'request.limit', 1, AGENT_DEVICE_RPC_LIMITS.turnListPage);
      optionalBoundedInteger(record.byteBudget, 'request.byteBudget', 1, AGENT_DEVICE_RPC_LIMITS.turnProjectionBytes);
      optionalBoundedInteger(record.renderLineBudget, 'request.renderLineBudget', 1, AGENT_DEVICE_RPC_LIMITS.turnRenderLines);
      return;
    case AGENT_DEVICE_RPC_METHODS.getTurnDetail:
      assertOnlyKeys(record, [
        'conversationId',
        'turnId',
        'cursor',
        'seenCursor',
        'direction',
        'limit',
        'maxBytes',
      ], 'request');
      assertIdentifier(record.conversationId, 'request.conversationId');
      assertIdentifier(record.turnId, 'request.turnId');
      optionalCursorString(record.cursor, 'request.cursor');
      optionalCursorString(record.seenCursor, 'request.seenCursor');
      optionalDirection(record.direction, 'request.direction');
      optionalBoundedInteger(record.limit, 'request.limit', 1, AGENT_DEVICE_RPC_LIMITS.turnDetailPage);
      optionalBoundedInteger(
        record.maxBytes,
        'request.maxBytes',
        AGENT_DEVICE_RPC_LIMITS.projectionPageMinBytes,
        AGENT_DEVICE_RPC_LIMITS.turnDetailDefaultBytes,
      );
      return;
    case AGENT_DEVICE_RPC_METHODS.getMessagePage:
      assertOnlyKeys(record, [
        'conversationId',
        'limit',
        'cursor',
        'expectedRevision',
        'seenCursor',
        'direction',
        'maxBytes',
      ], 'request');
      assertIdentifier(record.conversationId, 'request.conversationId');
      optionalBoundedInteger(record.limit, 'request.limit', 1, AGENT_DEVICE_RPC_LIMITS.messagePage);
      optionalCursorString(record.cursor, 'request.cursor');
      optionalCursorString(record.expectedRevision, 'request.expectedRevision');
      optionalCursorString(record.seenCursor, 'request.seenCursor');
      optionalDirection(record.direction, 'request.direction');
      optionalProjectionPageBytes(record.maxBytes, 'request.maxBytes');
      if (record.cursor !== undefined && record.expectedRevision === undefined) {
        fail('request.expectedRevision');
      }
      return;
    case AGENT_DEVICE_RPC_METHODS.getConversationTimelinePage: {
      assertOnlyKeys(record, [
        'conversationId',
        'limit',
        'maxBytes',
        'expectedRevision',
        'beforeCursor',
        'afterCursor',
        'aroundEntryIndex',
      ], 'request');
      assertIdentifier(record.conversationId, 'request.conversationId');
      optionalBoundedInteger(record.limit, 'request.limit', 1, AGENT_DEVICE_RPC_LIMITS.timelinePage);
      optionalTimelinePageBytes(record.maxBytes, 'request.maxBytes');
      optionalCursorString(record.expectedRevision, 'request.expectedRevision');
      optionalCursorString(record.beforeCursor, 'request.beforeCursor');
      optionalCursorString(record.afterCursor, 'request.afterCursor');
      optionalBoundedInteger(record.aroundEntryIndex, 'request.aroundEntryIndex', 0, Number.MAX_SAFE_INTEGER);
      if (
        [record.beforeCursor, record.afterCursor, record.aroundEntryIndex]
          .filter(value => value !== undefined).length > 1
      ) fail('request.navigation');
      return;
    }
    case AGENT_DEVICE_RPC_METHODS.loadAround:
      assertOnlyKeys(record, ['conversationId', 'focus', 'expectedRevision', 'maxMessages', 'maxBytes'], 'request');
      assertIdentifier(record.conversationId, 'request.conversationId');
      assertMessageWindowFocus(record.focus, 'request.focus');
      optionalCursorString(record.expectedRevision, 'request.expectedRevision');
      if (record.expectedRevision === undefined) fail('request.expectedRevision');
      optionalBoundedInteger(record.maxMessages, 'request.maxMessages', 1, AGENT_DEVICE_RPC_LIMITS.loadAroundMessages);
      optionalLoadAroundBytes(record.maxBytes, 'request.maxBytes');
      return;
    case AGENT_DEVICE_RPC_METHODS.getMessageDetail:
      assertOnlyKeys(record, ['conversationId', 'messageId', 'offset'], 'request');
      assertIdentifier(record.conversationId, 'request.conversationId');
      assertIdentifier(record.messageId, 'request.messageId');
      optionalBoundedInteger(record.offset, 'request.offset', 0, Number.MAX_SAFE_INTEGER);
      return;
    case AGENT_DEVICE_RPC_METHODS.getAttachmentChunk:
      assertOnlyKeys(record, ['conversationId', 'contentHash', 'offset'], 'request');
      assertIdentifier(record.conversationId, 'request.conversationId');
      assertIdentifier(record.contentHash, 'request.contentHash');
      optionalBoundedInteger(record.offset, 'request.offset', 0, Number.MAX_SAFE_INTEGER);
      return;
    case AGENT_DEVICE_RPC_METHODS.pullAgentRunLog:
      assertOnlyKeys(record, ['conversationId', 'runId', 'cursor', 'limit', 'maxBytes'], 'request');
      assertIdentifier(record.conversationId, 'request.conversationId');
      assertIdentifier(record.runId, 'request.runId');
      optionalCursorString(record.cursor, 'request.cursor');
      optionalBoundedInteger(record.limit, 'request.limit', 1, AGENT_DEVICE_RPC_LIMITS.runLogPage);
      optionalRunLogPageBytes(record.maxBytes, 'request.maxBytes');
      return;
    case AGENT_DEVICE_RPC_METHODS.beginAttachmentUpload:
    case AGENT_DEVICE_RPC_METHODS.uploadAttachmentChunk:
    case AGENT_DEVICE_RPC_METHODS.commitAttachmentUpload:
      assertAttachmentUploadRpcRequest(method, value);
      return;
    case AGENT_DEVICE_RPC_METHODS.scheduleList:
    case AGENT_DEVICE_RPC_METHODS.scheduleGet:
    case AGENT_DEVICE_RPC_METHODS.scheduleCreate:
    case AGENT_DEVICE_RPC_METHODS.scheduleUpdate:
    case AGENT_DEVICE_RPC_METHODS.scheduleDelete:
    case AGENT_DEVICE_RPC_METHODS.scheduleCronPreview:
      assertScheduledTaskRpcRequest(method, value);
      return;
  }
}

/** Shared outer envelope check for async request validators such as upload chunk integrity. */
export function assertAgentDeviceRpcRequestEnvelope(value: unknown): void {
  assertJsonBytes(value, 8 * 1024 * 1024, 'request');
}

/** Validate an untrusted response and return its method-specific type. */
export function parseAgentDeviceRpcResponse<M extends AgentDeviceRpcMethod>(
  method: M,
  value: unknown,
): AgentDeviceRpcResponse<M> {
  // Traverse descriptors before reading a field: accessors, toJSON hooks,
  // exotic prototypes and non-canonical values must never execute here.
  assertJsonBytes(value, 16 * 1024 * 1024, 'response');
  const record = asRecord(value, 'response');
  switch (method) {
    case AGENT_DEVICE_RPC_METHODS.getDefinitions:
      assertOnlyKeys(record, ['definitions'], 'response');
      assertArray(record.definitions, 'response.definitions');
      if (record.definitions.length > AGENT_DEVICE_RPC_LIMITS.definitions) fail('response.definitions');
      for (const definition of record.definitions) assertAgentDefinition(definition, 'response.definitions[]');
      assertJsonBytes(record, AGENT_DEVICE_RPC_LIMITS.definitionsBytes, 'response');
      break;
    case AGENT_DEVICE_RPC_METHODS.create:
      assertOnlyKeys(record, ['conversationId'], 'response');
      assertIdentifier(record.conversationId, 'response.conversationId');
      break;
    case AGENT_DEVICE_RPC_METHODS.send:
    case AGENT_DEVICE_RPC_METHODS.runTurn:
      assertOnlyKeys(record, ['ok', 'runId', 'requestId', 'turnId', 'conversationId', 'state'], 'response');
      assertTurnAcceptedResponse(record);
      break;
    case AGENT_DEVICE_RPC_METHODS.getRunStatus:
      assertOnlyKeys(record, ['status'], 'response');
      nullableRunStatus(record.status, 'response.status');
      break;
    case AGENT_DEVICE_RPC_METHODS.cancel:
      assertOnlyKeys(record, ['ok', 'status'], 'response');
      if (typeof record.ok !== 'boolean') fail('response.ok');
      nullableRunStatus(record.status, 'response.status');
      break;
    case AGENT_DEVICE_RPC_METHODS.deleteTurn:
      assertOnlyKeys(record, ['ok', 'conversationId', 'turnId', 'requestId', 'tombstone'], 'response');
      assertTurnControlResponse(record, false);
      break;
    case AGENT_DEVICE_RPC_METHODS.retryTurn:
      assertOnlyKeys(record, [
        'ok',
        'runId',
        'requestId',
        'turnId',
        'conversationId',
        'state',
        'tombstone',
        'userEvent',
      ], 'response');
      assertTurnAcceptedResponse(record);
      assertTurnControlResponse(record, true);
      assertConversationMessageEvent(record.userEvent, 'response.userEvent');
      break;
    case AGENT_DEVICE_RPC_METHODS.listConversations:
      assertOnlyKeys(record, [
        'items',
        'nextCursor',
        'previousCursor',
        'hasMoreBefore',
        'hasMoreAfter',
        'seenCursorFound',
      ], 'response');
      assertArray(record.items, 'response.items');
      if (record.items.length > AGENT_DEVICE_RPC_LIMITS.conversationListPage) fail('response.items');
      for (const meta of record.items) assertConversationMeta(meta, 'response.items[]');
      optionalCursorString(record.nextCursor, 'response.nextCursor');
      optionalCursorString(record.previousCursor, 'response.previousCursor');
      if (typeof record.hasMoreBefore !== 'boolean') fail('response.hasMoreBefore');
      if (typeof record.hasMoreAfter !== 'boolean') fail('response.hasMoreAfter');
      optionalBoolean(record.seenCursorFound, 'response.seenCursorFound');
      assertJsonBytes(record, AGENT_DEVICE_RPC_LIMITS.conversationListBytes, 'response');
      break;
    case AGENT_DEVICE_RPC_METHODS.getConversationMeta:
      assertOnlyKeys(record, ['meta'], 'response');
      if (!('meta' in record)) fail('response.meta');
      optionalConversationMeta(record.meta, 'response.meta', true);
      break;
    case AGENT_DEVICE_RPC_METHODS.listTurns:
      assertOnlyKeys(record, [
        'items',
        'nextCursor',
        'previousCursor',
        'hasMoreBefore',
        'hasMoreAfter',
        'seenCursorFound',
        'budget',
      ], 'response');
      assertTurnList(record, 'response');
      break;
    case AGENT_DEVICE_RPC_METHODS.getTurnDetail:
      assertOnlyKeys(record, [
        'turnId',
        'items',
        'nextCursor',
        'previousCursor',
        'hasMoreBefore',
        'hasMoreAfter',
        'seenCursorFound',
      ], 'response');
      assertTurnDetail(record, 'response');
      break;
    case AGENT_DEVICE_RPC_METHODS.getMessagePage:
      if (record.reset === true) {
        assertOnlyKeys(record, ['reset', 'conversationId', 'revision'], 'response');
        assertIdentifier(record.conversationId, 'response.conversationId');
        optionalCursorString(record.revision, 'response.revision');
        if (record.revision === undefined) fail('response.revision');
      } else {
        assertOnlyKeys(record, [
          'reset',
          'conversationId',
          'revision',
          'items',
          'nextCursor',
          'previousCursor',
          'hasMoreBefore',
          'hasMoreAfter',
          'seenCursorFound',
        ], 'response');
        if (record.reset !== false) fail('response.reset');
        assertIdentifier(record.conversationId, 'response.conversationId');
        optionalCursorString(record.revision, 'response.revision');
        if (record.revision === undefined) fail('response.revision');
        assertMessagePage(record, AGENT_DEVICE_RPC_LIMITS.messagePage, 'response');
      }
      assertJsonBytes(record, AGENT_DEVICE_RPC_LIMITS.messagePageBytes, 'response');
      break;
    case AGENT_DEVICE_RPC_METHODS.getConversationTimelinePage:
      if (record.reset === true) {
        assertOnlyKeys(record, ['reset', 'revision'], 'response');
        optionalCursorString(record.revision, 'response.revision');
        if (record.revision === undefined) fail('response.revision');
      } else {
        assertOnlyKeys(record, [
          'reset',
          'items',
          'totalEntries',
          'totalMessages',
          'totalTurns',
          'revision',
          'hasMoreBefore',
          'hasMoreAfter',
          'startEntryIndex',
          'endEntryIndex',
          'startCursor',
          'endCursor',
        ], 'response');
        assertTimeline(record, 'response');
      }
      assertJsonBytes(record, AGENT_DEVICE_RPC_LIMITS.timelinePageMaxBytes, 'response');
      break;
    case AGENT_DEVICE_RPC_METHODS.loadAround:
      assertMessageWindowResponse(record, 'response');
      assertJsonBytes(record, AGENT_DEVICE_RPC_LIMITS.loadAroundMaxBytes, 'response');
      break;
    case AGENT_DEVICE_RPC_METHODS.getMessageDetail:
      assertOnlyKeys(
        record,
        record.found === false
          ? ['found']
          : ['found', 'encoding', 'data', 'offset', 'totalBytes', 'nextOffset'],
        'response',
      );
      assertDetailChunk(record, 'response');
      break;
    case AGENT_DEVICE_RPC_METHODS.getAttachmentChunk:
      assertOnlyKeys(
        record,
        record.found === false
          ? ['found']
          : ['found', 'reference', 'encoding', 'data', 'offset', 'totalBytes', 'nextOffset'],
        'response',
      );
      assertAttachmentChunk(record, 'response');
      break;
    case AGENT_DEVICE_RPC_METHODS.pullAgentRunLog:
      assertOnlyKeys(record, ['messages', 'nextCursor', 'hasMoreAfter', 'runStatus'], 'response');
      assertRunLog(record, 'response');
      break;
    case AGENT_DEVICE_RPC_METHODS.beginAttachmentUpload:
    case AGENT_DEVICE_RPC_METHODS.uploadAttachmentChunk:
    case AGENT_DEVICE_RPC_METHODS.commitAttachmentUpload:
      return parseAttachmentUploadRpcResponse(method, value) as AgentDeviceRpcResponse<M>;
    case AGENT_DEVICE_RPC_METHODS.scheduleList:
    case AGENT_DEVICE_RPC_METHODS.scheduleGet:
    case AGENT_DEVICE_RPC_METHODS.scheduleCreate:
    case AGENT_DEVICE_RPC_METHODS.scheduleUpdate:
    case AGENT_DEVICE_RPC_METHODS.scheduleDelete:
    case AGENT_DEVICE_RPC_METHODS.scheduleCronPreview:
      return parseScheduledTaskRpcResponse(method, value) as AgentDeviceRpcResponse<M>;
  }
  return value as AgentDeviceRpcResponse<M>;
}

/** Reject valid-shaped responses that do not belong to the originating request. */
export function assertAgentDeviceRpcResponseCorrelation<M extends AgentDeviceRpcMethod>(
  method: M,
  request: AgentDeviceRpcRequest<M>,
  response: AgentDeviceRpcResponse<M>,
): void {
  const requestRecord = request as Record<string, unknown>;
  const responseRecord = response as Record<string, unknown>;
  if (
    requestRecord.seenCursor !== undefined &&
    typeof responseRecord.seenCursorFound !== 'boolean'
  ) fail('response.seenCursorFound');
  switch (method) {
    case AGENT_DEVICE_RPC_METHODS.create:
      if (
        requestRecord.conversationId !== undefined &&
        responseRecord.conversationId !== requestRecord.conversationId
      ) fail('response.conversationId');
      return;
    case AGENT_DEVICE_RPC_METHODS.send:
    case AGENT_DEVICE_RPC_METHODS.runTurn:
      for (const field of ['requestId', 'turnId', 'conversationId']) {
        if (responseRecord[field] !== requestRecord[field]) fail(`response.${field}`);
      }
      return;
    case AGENT_DEVICE_RPC_METHODS.getRunStatus:
    case AGENT_DEVICE_RPC_METHODS.cancel: {
      const status = responseRecord.status as AgentDeviceRpcRunStatus | null;
      if (status && status.runId !== requestRecord.runId) fail('response.status.runId');
      return;
    }
    case AGENT_DEVICE_RPC_METHODS.deleteTurn: {
      assertTurnControlCorrelation(requestRecord, responseRecord);
      const tombstone = responseRecord.tombstone as ConversationTombstoneEvent;
      if (requestRecord.reason !== undefined && tombstone.reason !== requestRecord.reason) {
        fail('response.tombstone.reason');
      }
      return;
    }
    case AGENT_DEVICE_RPC_METHODS.retryTurn: {
      if (
        responseRecord.requestId !== requestRecord.requestId ||
        responseRecord.turnId !== requestRecord.newTurnId ||
        responseRecord.conversationId !== requestRecord.conversationId
      ) fail('response');
      const tombstone = responseRecord.tombstone as ConversationTombstoneEvent;
      if (
        tombstone.conversationId !== requestRecord.conversationId ||
        tombstone.targetTurnId !== requestRecord.turnId
      ) fail('response.tombstone');
      const userEvent = responseRecord.userEvent as ConversationMessageEvent;
      if (
        userEvent.conversationId !== requestRecord.conversationId ||
        userEvent.message.messageId !== requestRecord.newTurnId ||
        userEvent.message.turnId !== requestRecord.newTurnId ||
        userEvent.message.role !== 'user'
      ) fail('response.userEvent');
      return;
    }
    case AGENT_DEVICE_RPC_METHODS.getConversationMeta: {
      const meta = responseRecord.meta as ConversationMeta | null;
      if (meta && meta.conversationId !== requestRecord.conversationId) fail('response.meta.conversationId');
      return;
    }
    case AGENT_DEVICE_RPC_METHODS.listConversations:
      assertRequestedPageLimit(requestRecord, responseRecord, AGENT_DEVICE_RPC_LIMITS.conversationListPage);
      return;
    case AGENT_DEVICE_RPC_METHODS.listTurns: {
      assertRequestedPageLimit(requestRecord, responseRecord, AGENT_DEVICE_RPC_LIMITS.turnListPage);
      const budget = responseRecord.budget as AgentDeviceRpcListTurnsResponse['budget'];
      if (budget.bytes > (requestRecord.byteBudget as number | undefined ?? AGENT_DEVICE_RPC_LIMITS.projectionPageDefaultBytes)) {
        fail('response.budget.bytes');
      }
      if (
        jsonByteLength(responseRecord) >
          (requestRecord.byteBudget as number | undefined ?? AGENT_DEVICE_RPC_LIMITS.projectionPageDefaultBytes)
      ) fail('response');
      if (
        budget.renderLines >
          (requestRecord.renderLineBudget as number | undefined ?? AGENT_DEVICE_RPC_LIMITS.turnRenderLines)
      ) fail('response.budget.renderLines');
      if (
        turnRenderLines(responseRecord.items) >
          (requestRecord.renderLineBudget as number | undefined ?? AGENT_DEVICE_RPC_LIMITS.turnRenderLines)
      ) fail('response.items');
      assertConversationItems(responseRecord, requestRecord.conversationId as string);
      return;
    }
    case AGENT_DEVICE_RPC_METHODS.getMessagePage:
      if (responseRecord.conversationId !== requestRecord.conversationId) {
        fail('response.conversationId');
      }
      assertRequestedByteBudget(requestRecord, responseRecord);
      if (responseRecord.reset === true) return;
      if (
        requestRecord.expectedRevision !== undefined &&
        responseRecord.revision !== requestRecord.expectedRevision
      ) fail('response.revision');
      assertRequestedPageLimit(requestRecord, responseRecord, AGENT_DEVICE_RPC_LIMITS.messagePage);
      assertConversationItems(responseRecord, requestRecord.conversationId as string);
      return;
    case AGENT_DEVICE_RPC_METHODS.getConversationTimelinePage:
      assertTimelinePageCorrelation(requestRecord, responseRecord);
      if (responseRecord.reset === true) {
        assertRequestedByteBudget(
          requestRecord,
          responseRecord,
          AGENT_DEVICE_RPC_LIMITS.timelinePageDefaultBytes,
        );
        return;
      }
      if (
        (responseRecord.items as unknown[]).length >
          (requestRecord.limit as number | undefined ?? AGENT_DEVICE_RPC_LIMITS.timelinePage)
      ) fail('response.items');
      assertConversationItems(responseRecord, requestRecord.conversationId as string);
      assertRequestedByteBudget(
        requestRecord,
        responseRecord,
        AGENT_DEVICE_RPC_LIMITS.timelinePageDefaultBytes,
      );
      return;
    case AGENT_DEVICE_RPC_METHODS.getTurnDetail:
      assertRequestedPageLimit(requestRecord, responseRecord, AGENT_DEVICE_RPC_LIMITS.turnDetailPage);
      if (responseRecord.turnId !== requestRecord.turnId) fail('response.turnId');
      for (const item of responseRecord.items as ChatMessage[]) {
        if (item.conversationId !== requestRecord.conversationId || item.turnId !== requestRecord.turnId) {
          fail('response.items');
        }
      }
      assertRequestedByteBudget(requestRecord, responseRecord);
      return;
    case AGENT_DEVICE_RPC_METHODS.loadAround:
      assertMessageWindowCorrelation(
        requestRecord as unknown as AgentDeviceRpcLoadAroundRequest,
        responseRecord as unknown as AgentDeviceRpcLoadAroundResponse,
      );
      return;
    case AGENT_DEVICE_RPC_METHODS.getAttachmentChunk: {
      if (responseRecord.found === true) {
        const reference = responseRecord.reference as AttachmentReference;
        if (reference.contentHash !== requestRecord.contentHash) fail('response.reference.contentHash');
        if (responseRecord.offset !== (requestRecord.offset ?? 0)) fail('response.offset');
      }
      return;
    }
    case AGENT_DEVICE_RPC_METHODS.getMessageDetail:
      if (
        responseRecord.found === true &&
        responseRecord.offset !== (requestRecord.offset ?? 0)
      ) fail('response.offset');
      return;
    case AGENT_DEVICE_RPC_METHODS.pullAgentRunLog: {
      assertRequestedPageLimit(requestRecord, responseRecord, AGENT_DEVICE_RPC_LIMITS.runLogPage, 'messages');
      const status = responseRecord.runStatus as AgentDeviceRpcRunStatus | null;
      if (status && status.runId !== requestRecord.runId) fail('response.runStatus.runId');
      assertRequestedByteBudget(
        requestRecord,
        responseRecord,
        AGENT_DEVICE_RPC_LIMITS.runLogPageBytes,
      );
      return;
    }
    case AGENT_DEVICE_RPC_METHODS.beginAttachmentUpload:
    case AGENT_DEVICE_RPC_METHODS.uploadAttachmentChunk:
    case AGENT_DEVICE_RPC_METHODS.commitAttachmentUpload:
      assertEmbeddedAttachmentUploadCorrelation(
        method as AttachmentUploadRpcMethod,
        request,
        response,
      );
      return;
    case AGENT_DEVICE_RPC_METHODS.scheduleList:
    case AGENT_DEVICE_RPC_METHODS.scheduleGet:
    case AGENT_DEVICE_RPC_METHODS.scheduleCreate:
    case AGENT_DEVICE_RPC_METHODS.scheduleUpdate:
    case AGENT_DEVICE_RPC_METHODS.scheduleDelete:
    case AGENT_DEVICE_RPC_METHODS.scheduleCronPreview:
      assertEmbeddedScheduledTaskCorrelation(method, request, response);
      return;
    case AGENT_DEVICE_RPC_METHODS.getDefinitions:
      return;
  }
}

function assertEmbeddedScheduledTaskCorrelation(
  method: ScheduledTaskRpcMethod,
  request: unknown,
  response: unknown,
): void {
  if (!isScheduledTaskRpcMethod(method)) fail('method');
  assertScheduledTaskRpcResponseCorrelation(
    method,
    request as ScheduledTaskRpcRequest<typeof method>,
    response as ScheduledTaskRpcResponse<typeof method>,
  );
}

function assertEmbeddedAttachmentUploadCorrelation(
  method: AttachmentUploadRpcMethod,
  request: unknown,
  response: unknown,
): void {
  switch (method) {
    case ATTACHMENT_UPLOAD_RPC_METHODS.begin:
      assertAttachmentUploadRpcResponseCorrelation(
        method,
        request as AttachmentUploadRpcRequest<typeof method>,
        response as AttachmentUploadRpcResponse<typeof method>,
      );
      return;
    case ATTACHMENT_UPLOAD_RPC_METHODS.chunk:
      assertAttachmentUploadRpcResponseCorrelation(
        method,
        request as AttachmentUploadRpcRequest<typeof method>,
        response as AttachmentUploadRpcResponse<typeof method>,
      );
      return;
    case ATTACHMENT_UPLOAD_RPC_METHODS.commit:
      assertAttachmentUploadRpcResponseCorrelation(
        method,
        request as AttachmentUploadRpcRequest<typeof method>,
        response as AttachmentUploadRpcResponse<typeof method>,
      );
  }
}

function assertConversationItems(response: Record<string, unknown>, conversationId: string): void {
  for (const item of response.items as Array<{ conversationId: string }>) {
    if (item.conversationId !== conversationId) fail('response.items.conversationId');
  }
}

function assertTimelinePageCorrelation(
  request: Record<string, unknown>,
  response: Record<string, unknown>,
): void {
  try {
    assertConversationTimelinePage(
      response,
      request.conversationId as string,
      {
        limit: request.limit as number | undefined ?? AGENT_DEVICE_RPC_LIMITS.timelinePage,
        maxBytes: request.maxBytes as number | undefined ??
          AGENT_DEVICE_RPC_LIMITS.timelinePageDefaultBytes,
        ...(request.expectedRevision === undefined
          ? {}
          : { expectedRevision: request.expectedRevision as string }),
        ...(request.beforeCursor === undefined
          ? {}
          : { beforeCursor: request.beforeCursor as string }),
        ...(request.afterCursor === undefined
          ? {}
          : { afterCursor: request.afterCursor as string }),
        ...(request.aroundEntryIndex === undefined
          ? {}
          : { aroundEntryIndex: request.aroundEntryIndex as number }),
      },
    );
  } catch {
    fail('response');
  }
  if (response.reset) return;
  const items = response.items;
  if (
    request.aroundEntryIndex !== undefined &&
    (request.aroundEntryIndex as number) < (response.totalEntries) &&
    !items.some(item => item.entryIndex === request.aroundEntryIndex)
  ) fail('response.items.entryIndex');
}

function assertRequestedPageLimit(
  request: Record<string, unknown>,
  response: Record<string, unknown>,
  defaultLimit: number,
  itemsField = 'items',
): void {
  if ((response[itemsField] as unknown[]).length > (request.limit as number | undefined ?? defaultLimit)) {
    fail(`response.${itemsField}`);
  }
}

function assertRequestedByteBudget(
  request: Record<string, unknown>,
  response: Record<string, unknown>,
  defaultBytes = AGENT_DEVICE_RPC_LIMITS.projectionPageDefaultBytes,
): void {
  const maximum = request.maxBytes as number | undefined ?? defaultBytes;
  if (jsonByteLength(response) > maximum) fail('response');
}

function assertSendRequest(record: Record<string, unknown>, requireDefinition: boolean): void {
  assertIdentifier(record.requestId, 'request.requestId');
  assertIdentifier(record.turnId, 'request.turnId');
  assertIdentifier(record.conversationId, 'request.conversationId');
  if (typeof record.message !== 'string') fail('request.message');
  if (requireDefinition) assertIdentifier(record.definitionId, 'request.definitionId');
  else optionalIdentifier(record.definitionId, 'request.definitionId');
  if (record.userMessage !== undefined) {
    assertPendingLocalUserMessage(record.userMessage, record.turnId);
    const userMessage = record.userMessage as AgentDeviceRpcPendingUserMessage;
    if (userMessage.content !== undefined && userMessage.content !== record.message) {
      fail('request.userMessage.content');
    }
  }
}

function assertPendingLocalUserMessage(value: unknown, turnId: string): void {
  const record = asRecord(value, 'request.userMessage');
  assertOnlyKeys(record, [
    'content',
    'parts',
    'toolCalls',
    'attachments',
    'detailRef',
    'reasoning_content',
    'contentType',
    'hidden',
    'duration',
    'metadata',
  ], 'request.userMessage');
  const event = {
    eventId: turnId,
    conversationId: 'rpc-validation',
    originNodeId: 'rpc-validation',
    originSequence: 1,
    lamportClock: 1,
    timestamp: 0,
    kind: 'message',
    message: {
      messageId: turnId,
      turnId,
      role: 'user',
      content: record.content ?? '',
      ...record,
    },
  };
  assertConversationMessageEvent(event, 'request.userMessage');
  try {
    assertAgentUserMessageWithinLimits(conversationEventToMessage(event));
  } catch {
    fail('request.userMessage');
  }
  const references: AttachmentReference[] = [
    ...((record.attachments as AttachmentReference[] | undefined) ?? []),
    ...((record.parts as Array<{ type: string; attachment?: AttachmentReference }> | undefined) ?? [])
      .filter(part => part.type === 'attachment' && part.attachment !== undefined)
      .map(part => part.attachment!),
  ];
  if (references.length > AGENT_DEVICE_RPC_LIMITS.userMessageAttachments) {
    fail('request.userMessage.attachments');
  }
  for (const reference of references) {
    if (
      !ATTACHMENT_UPLOAD_SHA256_PATTERN.test(reference.contentHash) ||
      reference.size > ATTACHMENT_UPLOAD_LIMITS.totalBytes ||
      reference.filename.length > ATTACHMENT_UPLOAD_LIMITS.filenameCharacters ||
      reference.mimeType.length > ATTACHMENT_UPLOAD_LIMITS.mimeTypeCharacters
    ) fail('request.userMessage.attachments');
  }
  assertJsonBytes(record, AGENT_DEVICE_RPC_LIMITS.userMessageBytes, 'request.userMessage');
}

function assertTurnControlIdentity(record: Record<string, unknown>): void {
  assertIdentifier(record.conversationId, 'request.conversationId');
  assertIdentifier(record.turnId, 'request.turnId');
  assertIdentifier(record.requestId, 'request.requestId');
}

function assertTurnControlResponse(record: Record<string, unknown>, retry: boolean): void {
  if (record.ok !== true) fail('response.ok');
  assertIdentifier(record.conversationId, 'response.conversationId');
  assertIdentifier(record.turnId, 'response.turnId');
  assertIdentifier(record.requestId, 'response.requestId');
  assertConversationTombstoneEvent(record.tombstone, 'response.tombstone');
  if (!retry && record.tombstone.targetTurnId !== record.turnId) fail('response.tombstone.targetTurnId');
}

function assertTurnControlCorrelation(
  request: Record<string, unknown>,
  response: Record<string, unknown>,
): void {
  if (
    response.requestId !== request.requestId ||
    response.turnId !== request.turnId ||
    response.conversationId !== request.conversationId
  ) fail('response');
  const tombstone = response.tombstone as ConversationTombstoneEvent;
  if (
    tombstone.conversationId !== request.conversationId ||
    tombstone.targetTurnId !== request.turnId
  ) fail('response.tombstone');
}

function assertConversationTombstoneEvent(
  value: unknown,
  field: string,
): asserts value is ConversationTombstoneEvent {
  if (!isConversationEvent(value) || value.kind !== 'tombstone') fail(field);
  assertJsonBytes(value, MAX_CONVERSATION_EVENT_BYTES, field);
}

function assertConversationMessageEvent(
  value: unknown,
  field: string,
): asserts value is ConversationMessageEvent {
  if (!isConversationEvent(value) || value.kind !== 'message') fail(field);
  assertJsonBytes(value, MAX_CONVERSATION_EVENT_BYTES, field);
}

function assertTurnAcceptedResponse(record: Record<string, unknown>): void {
  if (record.ok !== true || record.state !== 'accepted') fail('response.state');
  assertIdentifier(record.runId, 'response.runId');
  assertIdentifier(record.requestId, 'response.requestId');
  assertIdentifier(record.turnId, 'response.turnId');
  assertIdentifier(record.conversationId, 'response.conversationId');
}

function assertMessagePage(
  record: Record<string, unknown>,
  maximum: number,
  field: string,
  allowDuplicates = false,
): void {
  assertArray(record.items, `${field}.items`);
  if (record.items.length > maximum) fail(`${field}.items`);
  const messageIds = new Set<string>();
  for (const message of record.items) {
    try {
      assertConversationMessageProjection(message);
      assertJsonBytes(message, AGENT_DEVICE_RPC_LIMITS.messageProjectionBytes, `${field}.items[]`);
    } catch {
      fail(`${field}.items[]`);
    }
    if (!allowDuplicates && messageIds.has(message.messageId)) fail(`${field}.items[].messageId`);
    messageIds.add(message.messageId);
  }
  if (typeof record.hasMoreBefore !== 'boolean') fail(`${field}.hasMoreBefore`);
  if (typeof record.hasMoreAfter !== 'boolean') fail(`${field}.hasMoreAfter`);
  optionalCursorString(record.nextCursor, `${field}.nextCursor`);
  optionalCursorString(record.previousCursor, `${field}.previousCursor`);
  optionalBoolean(record.seenCursorFound, `${field}.seenCursorFound`);
}

function assertTimeline(record: Record<string, unknown>, field: string): void {
  try {
    assertConversationTimelinePageEnvelope(record, {
      limit: AGENT_DEVICE_RPC_LIMITS.timelinePage,
      maxBytes: AGENT_DEVICE_RPC_LIMITS.timelinePageMaxBytes,
      previewLength: AGENT_DEVICE_RPC_LIMITS.timelinePreviewCharacters,
    });
  } catch {
    fail(field);
  }
}

function assertTurnList(record: Record<string, unknown>, field: string): void {
  assertArray(record.items, `${field}.items`);
  if (record.items.length > AGENT_DEVICE_RPC_LIMITS.turnListPage) fail(`${field}.items`);
  const turnIds = new Set<string>();
  for (const value of record.items) {
    assertTurnSummary(value, `${field}.items[]`);
    if (turnIds.has(value.turnId)) fail(`${field}.items[].turnId`);
    turnIds.add(value.turnId);
  }
  assertPageNavigation(record, field);
  const budget = asRecord(record.budget, `${field}.budget`);
  assertBoundedInteger(budget.bytes, `${field}.budget.bytes`, 0, AGENT_DEVICE_RPC_LIMITS.turnProjectionBytes);
  assertBoundedInteger(budget.renderLines, `${field}.budget.renderLines`, 0, AGENT_DEVICE_RPC_LIMITS.turnRenderLines);
  if (typeof budget.truncated !== 'boolean') fail(`${field}.budget.truncated`);
  assertJsonBytes(record, AGENT_DEVICE_RPC_LIMITS.turnProjectionBytes, field);
}

function assertTurnDetail(record: Record<string, unknown>, field: string): void {
  assertIdentifier(record.turnId, `${field}.turnId`);
  assertArray(record.items, `${field}.items`);
  if (record.items.length > AGENT_DEVICE_RPC_LIMITS.turnDetailPage) fail(`${field}.items`);
  for (const message of record.items) {
    try {
      assertConversationMessageProjection(message);
    } catch {
      fail(`${field}.items[]`);
    }
  }
  assertPageNavigation(record, field);
  assertJsonBytes(record, AGENT_DEVICE_RPC_LIMITS.messagePageBytes, field);
}

function assertMessageWindowFocus(
  value: unknown,
  field: string,
): asserts value is ConversationMessageWindowFocus {
  const record = asRecord(value, field);
  if (record.kind === 'message') {
    assertOnlyKeys(record, ['kind', 'messageId', 'turnId', 'cursor'], field);
    assertIdentifier(record.messageId, `${field}.messageId`);
    assertIdentifier(record.turnId, `${field}.turnId`);
    optionalCursorString(record.cursor, `${field}.cursor`);
    return;
  }
  if (record.kind === 'timeline-entry') {
    assertOnlyKeys(record, ['kind', 'entryId', 'cursor'], field);
    assertIdentifier(record.entryId, `${field}.entryId`);
    optionalCursorString(record.cursor, `${field}.cursor`);
    if (record.cursor === undefined) fail(`${field}.cursor`);
    return;
  }
  fail(`${field}.kind`);
}

function assertMessageWindowResponse(record: Record<string, unknown>, field: string): void {
  if (record.reset === true) {
    assertOnlyKeys(record, ['reset', 'conversationId', 'revision'], field);
    assertIdentifier(record.conversationId, `${field}.conversationId`);
    optionalCursorString(record.revision, `${field}.revision`);
    if (record.revision === undefined) fail(`${field}.revision`);
    return;
  }
  assertOnlyKeys(record, [
    'reset',
    'conversationId',
    'revision',
    'focus',
    'recenterAnchor',
    'items',
    'hasMoreBefore',
    'hasMoreAfter',
    'previousCursor',
    'nextCursor',
  ], field);
  if (record.reset !== false) fail(`${field}.reset`);
  assertIdentifier(record.conversationId, `${field}.conversationId`);
  optionalCursorString(record.revision, `${field}.revision`);
  if (record.revision === undefined) fail(`${field}.revision`);
  assertResolvedMessageWindowFocus(record.focus, `${field}.focus`);
  if (record.recenterAnchor !== undefined) {
    const anchor = asRecord(record.recenterAnchor, `${field}.recenterAnchor`);
    assertOnlyKeys(anchor, ['messageId', 'turnId'], `${field}.recenterAnchor`);
    assertIdentifier(anchor.messageId, `${field}.recenterAnchor.messageId`);
    assertIdentifier(anchor.turnId, `${field}.recenterAnchor.turnId`);
  }
  assertArray(record.items, `${field}.items`);
  if (record.items.length > AGENT_DEVICE_RPC_LIMITS.loadAroundMessages) fail(`${field}.items`);
  const messageIds = new Set<string>();
  for (const item of record.items) {
    try {
      assertConversationMessageProjection(item, record.conversationId);
      assertJsonBytes(item, AGENT_DEVICE_RPC_LIMITS.messageProjectionBytes, `${field}.items[]`);
    } catch {
      fail(`${field}.items[]`);
    }
    if (messageIds.has(item.messageId)) fail(`${field}.items[].messageId`);
    messageIds.add(item.messageId);
  }
  if (typeof record.hasMoreBefore !== 'boolean') fail(`${field}.hasMoreBefore`);
  if (typeof record.hasMoreAfter !== 'boolean') fail(`${field}.hasMoreAfter`);
  optionalCursorString(record.previousCursor, `${field}.previousCursor`);
  optionalCursorString(record.nextCursor, `${field}.nextCursor`);
  if (record.items.length === 0) {
    if (
      record.hasMoreBefore || record.hasMoreAfter ||
      record.previousCursor !== undefined || record.nextCursor !== undefined
    ) fail(`${field}.items`);
    return;
  }
  if (record.hasMoreBefore !== (record.previousCursor !== undefined)) fail(`${field}.previousCursor`);
  if (record.hasMoreAfter !== (record.nextCursor !== undefined)) fail(`${field}.nextCursor`);
}

function assertResolvedMessageWindowFocus(value: unknown, field: string): void {
  const record = asRecord(value, field);
  if (record.kind === 'message') {
    assertOnlyKeys(record, ['kind', 'messageId', 'turnId', 'entryId', 'cursor'], field);
    assertIdentifier(record.messageId, `${field}.messageId`);
    assertIdentifier(record.turnId, `${field}.turnId`);
    optionalIdentifier(record.entryId, `${field}.entryId`);
    optionalCursorString(record.cursor, `${field}.cursor`);
    return;
  }
  if (record.kind !== 'compaction') fail(`${field}.kind`);
  assertOnlyKeys(record, ['kind', 'entry', 'nearestPosition', 'nearestMessageId', 'nearestTurnId'], field);
  try {
    assertConversationTimelineCompactionEntry(record.entry, {
      maximumPreview: AGENT_DEVICE_RPC_LIMITS.timelinePreviewCharacters,
    });
  } catch {
    fail(`${field}.entry`);
  }
  if (record.nearestPosition === 'none') {
    if (record.nearestMessageId !== undefined) fail(`${field}.nearestMessageId`);
    if (record.nearestTurnId !== undefined) fail(`${field}.nearestTurnId`);
    return;
  }
  if (record.nearestPosition !== 'before' && record.nearestPosition !== 'after') {
    fail(`${field}.nearestPosition`);
  }
  assertIdentifier(record.nearestMessageId, `${field}.nearestMessageId`);
  assertIdentifier(record.nearestTurnId, `${field}.nearestTurnId`);
}

function assertMessageWindowCorrelation(
  request: AgentDeviceRpcLoadAroundRequest,
  response: AgentDeviceRpcLoadAroundResponse,
): void {
  if (response.conversationId !== request.conversationId) fail('response.conversationId');
  assertRequestedByteBudget(
    request as unknown as Record<string, unknown>,
    response as unknown as Record<string, unknown>,
    AGENT_DEVICE_RPC_LIMITS.loadAroundDefaultBytes,
  );
  if (response.reset) return;
  if (response.revision !== request.expectedRevision) fail('response.revision');
  if (response.items.length > (request.maxMessages ?? AGENT_DEVICE_RPC_LIMITS.loadAroundMessages)) {
    fail('response.items');
  }
  for (const item of response.items) {
    if (item.conversationId !== request.conversationId) fail('response.items');
  }
  if (request.focus.kind === 'message') {
    if (
      response.focus.kind !== 'message' ||
      response.focus.messageId !== request.focus.messageId ||
      response.focus.turnId !== request.focus.turnId ||
      response.recenterAnchor?.messageId !== request.focus.messageId ||
      response.recenterAnchor?.turnId !== request.focus.turnId ||
      response.focus.entryId !== undefined ||
      response.focus.cursor !== request.focus.cursor
    ) {
      fail('response.focus');
    }
    return;
  }
  if (response.focus.kind === 'message') {
    if (
      response.focus.entryId !== request.focus.entryId ||
      response.focus.cursor !== request.focus.cursor ||
      response.recenterAnchor?.messageId !== response.focus.messageId ||
      response.recenterAnchor?.turnId !== response.focus.turnId
    ) fail('response.focus');
    return;
  }
  if (
    response.focus.entry.entryId !== request.focus.entryId ||
    response.focus.entry.cursor !== request.focus.cursor ||
    (response.focus.nearestPosition === 'none'
      ? response.recenterAnchor !== undefined
      : response.recenterAnchor?.messageId !== response.focus.nearestMessageId ||
        response.recenterAnchor?.turnId !== response.focus.nearestTurnId)
  ) fail('response.focus');
}

function assertTurnSummary(value: unknown, field: string): asserts value is AgentDeviceRpcTurnSummary {
  const record = asRecord(value, field);
  assertIdentifier(record.turnId, `${field}.turnId`);
  assertIdentifier(record.conversationId, `${field}.conversationId`);
  optionalCursorString(record.cursor, `${field}.cursor`);
  if (record.cursor === undefined) fail(`${field}.cursor`);
  assertBoundedInteger(record.startedAt, `${field}.startedAt`, 0, Number.MAX_SAFE_INTEGER);
  assertBoundedInteger(record.updatedAt, `${field}.updatedAt`, 0, Number.MAX_SAFE_INTEGER);
  assertPreview(record.userPreview, `${field}.userPreview`);
  assertArray(record.participantPreviews, `${field}.participantPreviews`);
  if (record.participantPreviews.length > 4 || jsonByteLength(record.participantPreviews) > 1_024) {
    fail(`${field}.participantPreviews`);
  }
  for (const [index, participantValue] of record.participantPreviews.entries()) {
    const participant = asRecord(participantValue, `${field}.participantPreviews[${index}]`);
    if (
      Reflect.ownKeys(participant).some(key => typeof key !== 'string' || !['actorId', 'actorLabel', 'role', 'preview'].includes(key)) ||
      typeof participant.actorId !== 'string' || participant.actorId.length === 0 || participant.actorId.length > 160 ||
      typeof participant.actorLabel !== 'string' || participant.actorLabel.length === 0 || participant.actorLabel.length > 160 ||
      (participant.role !== 'assistant' && participant.role !== 'agent') ||
      typeof participant.preview !== 'string' || participant.preview.length > 160
    ) fail(`${field}.participantPreviews[${index}]`);
  }
  assertBoundedInteger(record.responseCount, `${field}.responseCount`, 0, Number.MAX_SAFE_INTEGER);
  if (record.responseCount < record.participantPreviews.length) fail(`${field}.responseCount`);
  if (
    record.runState !== undefined &&
    !['accepted', 'queued', 'running', 'completed', 'failed', 'cancelled'].includes(record.runState as string)
  ) fail(`${field}.runState`);
  if (typeof record.isCompaction !== 'boolean') fail(`${field}.isCompaction`);
  optionalBoundedInteger(record.compactedMessageCount, `${field}.compactedMessageCount`, 1, Number.MAX_SAFE_INTEGER);
  if (typeof record.isTombstone !== 'boolean') fail(`${field}.isTombstone`);
  if (record.detailState !== 'summary' && record.detailState !== 'full' && record.detailState !== 'notLoaded') {
    fail(`${field}.detailState`);
  }
  if (record.messages !== undefined) {
    if (record.detailState !== 'full') fail(`${field}.messages`);
    assertArray(record.messages, `${field}.messages`);
    if (record.messages.length > AGENT_DEVICE_RPC_LIMITS.turnDetailPage) fail(`${field}.messages`);
    for (const message of record.messages) assertChatMessage(message, `${field}.messages[]`);
  }
}

function assertPageNavigation(record: Record<string, unknown>, field: string, seen = true): void {
  if (typeof record.hasMoreBefore !== 'boolean') fail(`${field}.hasMoreBefore`);
  if (typeof record.hasMoreAfter !== 'boolean') fail(`${field}.hasMoreAfter`);
  optionalCursorString(record.nextCursor, `${field}.nextCursor`);
  optionalCursorString(record.previousCursor, `${field}.previousCursor`);
  if (seen) optionalBoolean(record.seenCursorFound, `${field}.seenCursorFound`);
}

function assertDetailChunk(record: Record<string, unknown>, field: string): void {
  if (record.found === false) return;
  if (record.found !== true || record.encoding !== 'base64-json') fail(`${field}.encoding`);
  assertChunk(record, AGENT_DEVICE_RPC_LIMITS.detailChunkBytes, field);
}

function assertAttachmentChunk(record: Record<string, unknown>, field: string): void {
  if (record.found === false) return;
  if (record.found !== true || record.encoding !== 'base64') fail(`${field}.encoding`);
  assertAttachmentReference(record.reference, `${field}.reference`);
  assertChunk(record, AGENT_DEVICE_RPC_LIMITS.attachmentChunkBytes, field);
}

function assertChunk(record: Record<string, unknown>, maximumBytes: number, field: string): void {
  if (typeof record.data !== 'string' || !isCanonicalBase64(record.data)) fail(`${field}.data`);
  const byteLength = decodedBase64ByteLength(record.data);
  if (byteLength > maximumBytes) fail(`${field}.data`);
  assertBoundedInteger(record.offset, `${field}.offset`, 0, Number.MAX_SAFE_INTEGER);
  assertBoundedInteger(record.totalBytes, `${field}.totalBytes`, 0, Number.MAX_SAFE_INTEGER);
  optionalBoundedInteger(record.nextOffset, `${field}.nextOffset`, 1, Number.MAX_SAFE_INTEGER);
  if (record.offset + byteLength > record.totalBytes) fail(`${field}.totalBytes`);
  const expectedNext = record.offset + byteLength;
  if (record.nextOffset !== undefined && record.nextOffset !== expectedNext) fail(`${field}.nextOffset`);
  if (record.nextOffset === undefined && expectedNext !== record.totalBytes) fail(`${field}.nextOffset`);
}

function assertRunLog(record: Record<string, unknown>, field: string): void {
  assertArray(record.messages, `${field}.messages`);
  if (record.messages.length > AGENT_DEVICE_RPC_LIMITS.runLogPage) fail(`${field}.messages`);
  for (const value of record.messages) {
    const message = asRecord(value, `${field}.messages[]`);
    assertIdentifier(message.messageId, `${field}.messages[].messageId`);
    assertChatRole(message.role, `${field}.messages[].role`);
    if (
      typeof message.content !== 'string' ||
      message.content.length > AGENT_DEVICE_RPC_LIMITS.runLogContentCharacters
    ) fail(`${field}.messages[].content`);
  }
  optionalCursorString(record.nextCursor, `${field}.nextCursor`);
  if (typeof record.hasMoreAfter !== 'boolean') fail(`${field}.hasMoreAfter`);
  nullableRunStatus(record.runStatus, `${field}.runStatus`);
  assertJsonBytes(record, AGENT_DEVICE_RPC_LIMITS.runLogPageBytes, field);
}

function assertAgentDefinition(value: unknown, field: string): void {
  const record = asRecord(value, field);
  assertIdentifier(record.id, `${field}.id`);
  if (typeof record.name !== 'string' || typeof record.description !== 'string' || typeof record.systemPrompt !== 'string') fail(field);
  assertArray(record.tools, `${field}.tools`);
  if (!record.tools.every(tool => typeof tool === 'string')) fail(`${field}.tools`);
  if (typeof record.version !== 'string') fail(`${field}.version`);
}

function assertConversationMeta(value: unknown, field: string): asserts value is ConversationMeta {
  const record = asRecord(value, field);
  assertIdentifier(record.conversationId, `${field}.conversationId`);
  if (
    typeof record.title !== 'string' || record.title.length > 512 ||
    typeof record.lastMessagePreview !== 'string' || record.lastMessagePreview.length > 2_000 ||
    typeof record.originNodeId !== 'string' ||
    typeof record.definitionId !== 'string' ||
    typeof record.isUserInitiated !== 'boolean'
  ) fail(field);
  assertBoundedInteger(record.lastMessageTimestamp, `${field}.lastMessageTimestamp`, 0, Number.MAX_SAFE_INTEGER);
  assertBoundedInteger(record.messageCount, `${field}.messageCount`, 0, Number.MAX_SAFE_INTEGER);
  assertBoundedInteger(record.originClock, `${field}.originClock`, 0, Number.MAX_SAFE_INTEGER);
}

function optionalConversationMeta(value: unknown, field: string, nullable = false): void {
  if (value === undefined || (nullable && value === null)) return;
  assertConversationMeta(value, field);
}

function assertChatMessage(
  value: unknown,
  field: string,
  maximumBytes = AGENT_DEVICE_RPC_LIMITS.messageProjectionBytes,
): asserts value is ChatMessage {
  try {
    assertCanonicalChatMessageProjection(value);
    assertJsonBytes(value, maximumBytes, field);
  } catch {
    fail(field);
  }
}

/** Parse the complete JSON object reconstructed from getMessageDetail chunks. */
export function parseAgentDeviceRpcMessageDetail(value: unknown): ChatMessage {
  assertChatMessage(value, 'response.data', AGENT_DEVICE_RPC_LIMITS.messageDetailBytes);
  return value;
}

function assertChatRole(value: unknown, field: string): void {
  if (value !== 'user' && value !== 'assistant' && value !== 'tool' && value !== 'agent' && value !== 'error') fail(field);
}

function assertAttachmentReference(value: unknown, field: string): void {
  const record = asRecord(value, field);
  assertIdentifier(record.contentHash, `${field}.contentHash`);
  if (typeof record.filename !== 'string' || typeof record.mimeType !== 'string') fail(field);
  assertBoundedInteger(record.size, `${field}.size`, 0, Number.MAX_SAFE_INTEGER);
}

function nullableRunStatus(value: unknown, field: string): void {
  if (value === null) return;
  const record = asRecord(value, field);
  assertOnlyKeys(record, [
    'runId',
    'conversationId',
    'definitionId',
    'turnId',
    'requestPeerId',
    'requestId',
    'payloadDigest',
    'state',
    'acceptedAt',
    'updatedAt',
    'startedAt',
    'finishedAt',
    'cancelRequestedAt',
    'error',
  ], field);
  assertIdentifier(record.runId, `${field}.runId`);
  assertIdentifier(record.requestId, `${field}.requestId`);
  assertIdentifier(record.turnId, `${field}.turnId`);
  assertIdentifier(record.conversationId, `${field}.conversationId`);
  assertIdentifier(record.definitionId, `${field}.definitionId`);
  assertIdentifier(record.requestPeerId, `${field}.requestPeerId`);
  assertIdentifier(record.payloadDigest, `${field}.payloadDigest`);
  if (!['accepted', 'queued', 'running', 'completed', 'failed', 'cancelled'].includes(record.state as string)) fail(`${field}.state`);
  assertBoundedInteger(record.acceptedAt, `${field}.acceptedAt`, 0, Number.MAX_SAFE_INTEGER);
  assertBoundedInteger(record.updatedAt, `${field}.updatedAt`, 0, Number.MAX_SAFE_INTEGER);
  optionalBoundedInteger(record.startedAt, `${field}.startedAt`, 0, Number.MAX_SAFE_INTEGER);
  optionalBoundedInteger(record.finishedAt, `${field}.finishedAt`, 0, Number.MAX_SAFE_INTEGER);
  optionalBoundedInteger(record.cancelRequestedAt, `${field}.cancelRequestedAt`, 0, Number.MAX_SAFE_INTEGER);
  if (record.error !== undefined) {
    try {
      normalizeAgentRunError(record.error);
    } catch {
      fail(`${field}.error`);
    }
  }
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(field);
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  if (Object.keys(record).some(key => !allowed.includes(key))) fail(field);
}

function assertArray(value: unknown, field: string): asserts value is unknown[] {
  if (!Array.isArray(value)) fail(field);
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > AGENT_DEVICE_RPC_LIMITS.identifierCharacters ||
    value !== value.trim() ||
    hasAsciiControlText(value)
  ) fail(field);
}

function optionalIdentifier(value: unknown, field: string): void {
  if (value !== undefined) assertIdentifier(value, field);
}

function optionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'string') fail(field);
}

function optionalProjectionPageBytes(value: unknown, field: string): void {
  optionalBoundedInteger(
    value,
    field,
    AGENT_DEVICE_RPC_LIMITS.projectionPageMinBytes,
    AGENT_DEVICE_RPC_LIMITS.projectionPageMaxBytes,
  );
}

function optionalRunLogPageBytes(value: unknown, field: string): void {
  optionalBoundedInteger(
    value,
    field,
    AGENT_DEVICE_RPC_LIMITS.projectionPageMinBytes,
    AGENT_DEVICE_RPC_LIMITS.runLogPageBytes,
  );
}

function optionalTimelinePageBytes(value: unknown, field: string): void {
  optionalBoundedInteger(
    value,
    field,
    1,
    AGENT_DEVICE_RPC_LIMITS.timelinePageMaxBytes,
  );
}

function optionalLoadAroundBytes(value: unknown, field: string): void {
  optionalBoundedInteger(
    value,
    field,
    1,
    AGENT_DEVICE_RPC_LIMITS.loadAroundMaxBytes,
  );
}

function optionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'boolean') fail(field);
}

function optionalCursorString(value: unknown, field: string): void {
  if (
    value !== undefined &&
    (typeof value !== 'string' ||
      value.length === 0 ||
      value.length > AGENT_DEVICE_RPC_LIMITS.cursorCharacters ||
      value !== value.trim() ||
      hasAsciiControlText(value))
  ) fail(field);
}

function assertPreview(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.length > AGENT_DEVICE_RPC_LIMITS.timelinePreviewCharacters + 1) fail(field);
}

function hasAsciiControlText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function assertBoundedInteger(value: unknown, field: string, minimum: number, maximum: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail(field);
}

function optionalBoundedInteger(value: unknown, field: string, minimum: number, maximum: number): void {
  if (value !== undefined) assertBoundedInteger(value, field, minimum, maximum);
}

function optionalDirection(value: unknown, field: string): void {
  if (value !== undefined && value !== 'backward' && value !== 'forward') fail(field);
}

function assertJsonBytes(value: unknown, maximum: number, field: string): void {
  if (jsonByteLength(value) > maximum) fail(field);
}

function jsonByteLength(value: unknown): number {
  try {
    return canonicalJsonBytes(value, {
      maxBytes: 16 * 1024 * 1024,
      maxStringBytes: 16 * 1024 * 1024,
      maxStringCodeUnits: 16 * 1024 * 1024,
      maxNodes: 200_000,
    }).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function turnRenderLines(value: unknown): number {
  if (!Array.isArray(value)) return Number.POSITIVE_INFINITY;
  let lines = 0;
  for (const item of value) {
    const record = item as Record<string, unknown>;
    const userPreview = record.userPreview;
    if (typeof userPreview === 'string') lines += userPreview.split('\n').length;
    if (Array.isArray(record.participantPreviews)) {
      for (const participant of record.participantPreviews) {
        const preview = (participant as Record<string, unknown>)?.preview;
        if (typeof preview === 'string') lines += preview.split('\n').length;
      }
    }
  }
  return lines;
}

function isCanonicalBase64(value: string): boolean {
  return value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function decodedBase64ByteLength(value: string): number {
  if (value.length === 0) return 0;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return value.length / 4 * 3 - padding;
}

function fail(field: string): never {
  throw new AgentDeviceRpcProtocolError(field);
}
