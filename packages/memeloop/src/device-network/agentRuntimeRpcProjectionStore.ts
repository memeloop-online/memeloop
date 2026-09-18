import { decodeBase64, encodeBase64 } from '../encoding/base64.js';
import { canonicalJsonBytes } from '../encoding/canonicalJson.js';
import { sha256HexSync } from '../encoding/sha256.js';
import { boundConversationMessageProjectionForList, readConversationMessagePage, readConversationTimelinePage } from '../storage/conversationPaging.js';
import type {
  ConversationMessageCursor,
  ConversationMessageListProjection,
  ConversationTimelineEntry,
  ConversationTimelinePage,
  FullAgentStorage,
  GetConversationListPageOptions,
} from '../storage/ports.js';
import {
  AGENT_DEVICE_RPC_LIMITS,
  AGENT_DEVICE_RPC_METHODS,
  type AgentDeviceRpcContract,
  type AgentDeviceRpcGetTurnDetailRequest,
  type AgentDeviceRpcListTurnsRequest,
  type AgentDeviceRpcRequest,
  type AgentDeviceRpcTurnSummary,
} from './agentDeviceRpc.js';

/**
 * The host supplies only canonical, revisioned storage readers. Core owns the
 * RPC-specific cursor envelope, timeline-to-turn mapping, and response budgets.
 */
export interface AgentRuntimeRpcProjectionStorage extends FullAgentStorage {
  listConversationsPage: FullAgentStorage['listConversationsPage'];
  getMessagePage: NonNullable<FullAgentStorage['getMessagePage']>;
  getConversationTimelinePage: NonNullable<FullAgentStorage['getConversationTimelinePage']>;
}

/**
 * Compatibility boundary for hosts still carrying their own RPC projection
 * adapter. New hosts must use {@link createAgentRuntimeRpcProjectionStore}
 * with canonical storage instead.
 */
export interface AgentRuntimeRpcProjectionStore {
  listConversations(
    request: AgentDeviceRpcRequest<typeof AGENT_DEVICE_RPC_METHODS.listConversations>,
    context: AgentRuntimeRpcCollectionQueryContext,
  ): Promise<AgentDeviceRpcContract[typeof AGENT_DEVICE_RPC_METHODS.listConversations]['response']>;
  listTurns(
    request: AgentDeviceRpcRequest<typeof AGENT_DEVICE_RPC_METHODS.listTurns>,
    context: AgentRuntimeRpcProjectionReadContext,
  ): Promise<AgentDeviceRpcContract[typeof AGENT_DEVICE_RPC_METHODS.listTurns]['response']>;
  getTurnDetail(
    request: AgentDeviceRpcRequest<typeof AGENT_DEVICE_RPC_METHODS.getTurnDetail>,
    context: AgentRuntimeRpcProjectionReadContext,
  ): Promise<AgentDeviceRpcContract[typeof AGENT_DEVICE_RPC_METHODS.getTurnDetail]['response']>;
}

export interface AgentRuntimeRpcReadContext {
  signal?: AbortSignal;
}

/**
 * Authorization predicates must be applied by canonical storage before it
 * orders, evaluates a keyset, or reads a row payload. `undefined` means all;
 * an empty array means none.
 */
export interface AgentRuntimeRpcCollectionQueryContext extends AgentRuntimeRpcReadContext {
  allowedConversationIds?: readonly string[];
  allowedDefinitionIds?: readonly string[];
  /** Stable grant principal used to bind every RPC continuation cursor. */
  scopeKey: string;
}

/** Read context for a scoped conversation; its cursor is grant-bound as well. */
export interface AgentRuntimeRpcProjectionReadContext extends AgentRuntimeRpcReadContext {
  scopeKey: string;
}

const RPC_MESSAGE_PROJECTION_MAX_BYTES = 128 * 1024;
const CURSOR_VERSION = 1;
const CURSOR_MAX_DECODED_BYTES = 1_536;
const CURSOR_MAX_SOURCE_CHARACTERS = 1_024;

type ProjectionDirection = 'backward' | 'forward';

interface StringProjectionCursor {
  version: typeof CURSOR_VERSION;
  kind: 'conversations' | 'turns';
  scope: string;
  revision: string;
  direction: ProjectionDirection;
  cursor: string;
}

interface MessageProjectionCursor {
  version: typeof CURSOR_VERSION;
  kind: 'turn-detail';
  scope: string;
  revision: string;
  direction: ProjectionDirection;
  cursor: ConversationMessageCursor;
}

type ProjectionCursor = StringProjectionCursor | MessageProjectionCursor;

/**
 * Build the RPC projection adapter from canonical storage. This is deliberately
 * a pure Core factory so hosts do not duplicate protocol cursor or budget code.
 */
export function createAgentRuntimeRpcProjectionStore(
  storage: AgentRuntimeRpcProjectionStorage,
): AgentRuntimeRpcProjectionStore {
  return {
    async listConversations(request, context) {
      context.signal?.throwIfAborted();
      if (
        context.allowedConversationIds?.length === 0 ||
        context.allowedDefinitionIds?.length === 0
      ) {
        return {
          items: [],
          hasMoreBefore: false,
          hasMoreAfter: false,
          ...(request.seenCursor === undefined ? {} : { seenCursorFound: false }),
        };
      }
      const direction = request.direction ?? 'backward';
      const scope = projectionScope({ kind: 'conversations', scopeKey: context.scopeKey });
      const cursor = request.cursor === undefined
        ? undefined
        : decodeStringProjectionCursor(request.cursor, 'conversations', scope, direction);
      const seen = request.seenCursor === undefined
        ? undefined
        : decodeStringProjectionCursor(request.seenCursor, 'conversations', scope);
      const query: GetConversationListPageOptions = {
        limit: request.limit ?? AGENT_DEVICE_RPC_LIMITS.conversationListPage,
        maxBytes: AGENT_DEVICE_RPC_LIMITS.conversationListBytes,
        query: {
          ...(context.allowedConversationIds === undefined
            ? {}
            : { conversationIds: context.allowedConversationIds }),
          ...(context.allowedDefinitionIds === undefined
            ? {}
            : { definitionIds: context.allowedDefinitionIds }),
        },
        ...(cursor === undefined
          ? {}
          : {
            expectedRevision: cursor.revision,
            ...(direction === 'forward' ? { afterCursor: cursor.cursor } : { beforeCursor: cursor.cursor }),
          }),
      };
      const page = await storage.listConversationsPage(query, { signal: context.signal });
      context.signal?.throwIfAborted();
      assertConversationListPage(page, query);
      if (page.reset) throw new Error('conversation_list_cursor_invalidated');
      assertConversationListScope(page.items, context);
      const first = page.items[0];
      const last = page.items.at(-1);
      return {
        items: page.items,
        hasMoreBefore: page.hasMoreBefore,
        hasMoreAfter: page.hasMoreAfter,
        ...(page.hasMoreBefore && first && page.startCursor
          ? { previousCursor: encodeStringProjectionCursor('conversations', scope, page.revision, 'backward', page.startCursor) }
          : {}),
        ...(page.hasMoreAfter && last && page.endCursor
          ? { nextCursor: encodeStringProjectionCursor('conversations', scope, page.revision, 'forward', page.endCursor) }
          : {}),
        ...(seen === undefined ? {} : { seenCursorFound: seen.revision === page.revision }),
      };
    },

    async listTurns(request, context) {
      context.signal?.throwIfAborted();
      const direction = request.direction ?? 'backward';
      const scope = projectionScope({
        kind: 'turns',
        scopeKey: context.scopeKey,
        conversationId: request.conversationId,
      });
      const cursor = request.cursor === undefined
        ? undefined
        : decodeStringProjectionCursor(request.cursor, 'turns', scope, direction);
      const seen = request.seenCursor === undefined
        ? undefined
        : decodeStringProjectionCursor(request.seenCursor, 'turns', scope);
      const byteBudget = request.byteBudget ?? AGENT_DEVICE_RPC_LIMITS.projectionPageDefaultBytes;
      const page = await readConversationTimelinePage(storage, request.conversationId, {
        limit: Math.min(request.limit ?? AGENT_DEVICE_RPC_LIMITS.turnListPage, AGENT_DEVICE_RPC_LIMITS.timelinePage),
        maxBytes: Math.min(byteBudget, AGENT_DEVICE_RPC_LIMITS.timelinePageMaxBytes),
        ...(cursor === undefined
          ? {}
          : {
            expectedRevision: cursor.revision,
            ...(direction === 'forward' ? { afterCursor: cursor.cursor } : { beforeCursor: cursor.cursor }),
          }),
      }, { signal: context.signal });
      context.signal?.throwIfAborted();
      if (page.reset) throw new Error('conversation_timeline_cursor_invalidated');
      return buildTurnListResponse(request, page, scope, seen);
    },

    async getTurnDetail(request, context) {
      context.signal?.throwIfAborted();
      const direction = request.direction ?? 'backward';
      const scope = projectionScope({
        kind: 'turn-detail',
        scopeKey: context.scopeKey,
        conversationId: request.conversationId,
        turnId: request.turnId,
      });
      const cursor = request.cursor === undefined
        ? undefined
        : decodeMessageProjectionCursor(request.cursor, scope, direction);
      const seen = request.seenCursor === undefined
        ? undefined
        : decodeMessageProjectionCursor(request.seenCursor, scope);
      const page = await readConversationMessagePage(storage, request.conversationId, {
        limit: request.limit ?? AGENT_DEVICE_RPC_LIMITS.turnDetailPage,
        maxBytes: request.maxBytes ?? AGENT_DEVICE_RPC_LIMITS.turnDetailDefaultBytes,
        turnId: request.turnId,
        direction,
        ...(cursor === undefined
          ? {}
          : {
            expectedRevision: cursor.revision,
            ...(direction === 'forward' ? { after: cursor.cursor } : { before: cursor.cursor }),
          }),
      }, { signal: context.signal });
      context.signal?.throwIfAborted();
      if (page.reset) throw new Error('turn_detail_cursor_invalidated');
      if (page.items.some(item => item.turnId !== request.turnId)) {
        throw new Error('turn_detail_storage_scope_violation');
      }
      return buildTurnDetailResponse(request, page, scope, seen);
    },
  };
}

function buildTurnListResponse(
  request: AgentDeviceRpcListTurnsRequest,
  page: Exclude<ConversationTimelinePage, { reset: true }>,
  scope: string,
  seen: StringProjectionCursor | undefined,
): AgentDeviceRpcContract[typeof AGENT_DEVICE_RPC_METHODS.listTurns]['response'] {
  const direction = request.direction ?? 'backward';
  const byteBudget = request.byteBudget ?? AGENT_DEVICE_RPC_LIMITS.projectionPageDefaultBytes;
  const renderLineBudget = request.renderLineBudget ?? AGENT_DEVICE_RPC_LIMITS.turnRenderLines;
  const mapped = page.items.map(toTurnSummary);
  let items = mapped;
  let truncated = false;
  for (;;) {
    const hasMoreBefore = page.hasMoreBefore || (items.length < mapped.length && direction !== 'forward');
    const hasMoreAfter = page.hasMoreAfter || (items.length < mapped.length && direction === 'forward');
    const first = items[0];
    const last = items.at(-1);
    const response: AgentDeviceRpcContract[typeof AGENT_DEVICE_RPC_METHODS.listTurns]['response'] = {
      items,
      hasMoreBefore,
      hasMoreAfter,
      ...(hasMoreBefore && first
        ? { previousCursor: encodeStringProjectionCursor('turns', scope, page.revision, 'backward', first.cursor) }
        : {}),
      ...(hasMoreAfter && last
        ? { nextCursor: encodeStringProjectionCursor('turns', scope, page.revision, 'forward', last.cursor) }
        : {}),
      ...(seen === undefined ? {} : { seenCursorFound: seen.revision === page.revision }),
      budget: { bytes: 0, renderLines: turnRenderLines(items), truncated },
    };
    setResponseByteCount(response);
    if (response.budget.bytes <= byteBudget && response.budget.renderLines <= renderLineBudget) return response;
    if (items.length === 0) throw new Error('turn_projection_budget_too_small');
    truncated = true;
    items = direction === 'forward' ? items.slice(0, -1) : items.slice(1);
  }
}

function buildTurnDetailResponse(
  request: AgentDeviceRpcGetTurnDetailRequest,
  page: Exclude<Awaited<ReturnType<AgentRuntimeRpcProjectionStorage['getMessagePage']>>, { reset: true }>,
  scope: string,
  seen: MessageProjectionCursor | undefined,
): AgentDeviceRpcContract[typeof AGENT_DEVICE_RPC_METHODS.getTurnDetail]['response'] {
  const direction = request.direction ?? 'backward';
  const maxBytes = request.maxBytes ?? AGENT_DEVICE_RPC_LIMITS.turnDetailDefaultBytes;
  // Keep eight KiB for the envelope and two continuation cursors. The RPC
  // request floor is 64 KiB, so even a single lazy list projection remains
  // representable without asking storage to materialize canonical detail.
  const itemBytes = Math.min(RPC_MESSAGE_PROJECTION_MAX_BYTES, Math.max(1, maxBytes - 8 * 1024));
  const mapped = page.items.map(item => boundConversationMessageProjectionForList(item, itemBytes, { detailAvailable: true }));
  let items = mapped;
  for (;;) {
    const hasMoreBefore = page.hasMoreBefore || (items.length < mapped.length && direction !== 'forward');
    const hasMoreAfter = page.hasMoreAfter || (items.length < mapped.length && direction === 'forward');
    const first = items[0];
    const last = items.at(-1);
    const response: AgentDeviceRpcContract[typeof AGENT_DEVICE_RPC_METHODS.getTurnDetail]['response'] = {
      turnId: request.turnId,
      items,
      hasMoreBefore,
      hasMoreAfter,
      ...(hasMoreBefore && first
        ? {
          previousCursor: encodeMessageProjectionCursor(
            scope,
            page.revision,
            'backward',
            messageCursor(first),
          ),
        }
        : {}),
      ...(hasMoreAfter && last
        ? {
          nextCursor: encodeMessageProjectionCursor(
            scope,
            page.revision,
            'forward',
            messageCursor(last),
          ),
        }
        : {}),
      ...(seen === undefined ? {} : { seenCursorFound: seen.revision === page.revision }),
    };
    if (jsonByteLength(response) <= maxBytes) return response;
    if (items.length === 0) throw new Error('turn_detail_projection_budget_too_small');
    items = direction === 'forward' ? items.slice(0, -1) : items.slice(1);
  }
}

function toTurnSummary(entry: ConversationTimelineEntry): AgentDeviceRpcTurnSummary {
  if (entry.kind === 'message') {
    const participantPreviews = entry.role === 'user'
      ? []
      : [{ actorId: entry.actorId, actorLabel: entry.actorLabel, role: entry.role, preview: entry.preview }];
    return {
      turnId: entry.turnId,
      conversationId: entry.conversationId,
      cursor: entry.cursor,
      startedAt: entry.timestamp,
      updatedAt: entry.timestamp,
      userPreview: entry.role === 'user' ? entry.preview : '',
      participantPreviews,
      responseCount: participantPreviews.length,
      isCompaction: false,
      isTombstone: false,
      detailState: 'notLoaded',
    };
  }
  return {
    turnId: entry.entryId,
    conversationId: entry.conversationId,
    cursor: entry.cursor,
    startedAt: entry.timestamp,
    updatedAt: entry.timestamp,
    userPreview: entry.summaryPreview,
    participantPreviews: [],
    responseCount: 0,
    isCompaction: true,
    compactedMessageCount: entry.compactedMessageCount,
    isTombstone: false,
    detailState: 'summary',
  };
}

function turnRenderLines(items: readonly AgentDeviceRpcTurnSummary[]): number {
  return items.reduce((total, item) => {
    const previews = [item.userPreview, ...item.participantPreviews.map(preview => preview.preview)];
    return total + previews.reduce((lines, preview) => lines + preview.split('\n').length, 0);
  }, 0);
}

function setResponseByteCount(
  response: AgentDeviceRpcContract[typeof AGENT_DEVICE_RPC_METHODS.listTurns]['response'],
): void {
  for (let attempts = 0; attempts < 8; attempts += 1) {
    const bytes = jsonByteLength(response);
    if (response.budget.bytes === bytes) return;
    response.budget.bytes = bytes;
  }
  throw new Error('turn_projection_byte_count_unstable');
}

function projectionScope(value: unknown): string {
  return sha256HexSync(canonicalJsonBytes(value, {
    maxDepth: 8,
    maxNodes: 2_000,
    maxStringCodeUnits: 1_048_576,
    maxStringBytes: 1_048_576,
    maxBytes: 1_048_576,
  }));
}

function encodeStringProjectionCursor(
  kind: StringProjectionCursor['kind'],
  scope: string,
  revision: string,
  direction: ProjectionDirection,
  cursor: string,
): string {
  assertSourceCursor(cursor);
  return encodeProjectionCursor({ version: CURSOR_VERSION, kind, scope, revision, direction, cursor });
}

function encodeMessageProjectionCursor(
  scope: string,
  revision: string,
  direction: ProjectionDirection,
  cursor: ConversationMessageCursor,
): string {
  assertMessageCursor(cursor);
  return encodeProjectionCursor({ version: CURSOR_VERSION, kind: 'turn-detail', scope, revision, direction, cursor });
}

function encodeProjectionCursor(cursor: ProjectionCursor): string {
  assertCursorCommon(cursor);
  const encoded = encodeBase64(
    canonicalJsonBytes(cursor, {
      maxDepth: 8,
      maxNodes: 32,
      maxStringCodeUnits: CURSOR_MAX_SOURCE_CHARACTERS,
      maxStringBytes: CURSOR_MAX_SOURCE_CHARACTERS,
      maxBytes: CURSOR_MAX_DECODED_BYTES,
    }),
    'url',
  );
  if (encoded.length > AGENT_DEVICE_RPC_LIMITS.cursorCharacters) {
    throw new Error('agent_runtime_projection_cursor_too_large');
  }
  return encoded;
}

function decodeStringProjectionCursor(
  value: string,
  kind: StringProjectionCursor['kind'],
  scope: string,
  direction?: ProjectionDirection,
): StringProjectionCursor {
  const cursor = decodeProjectionCursor(value);
  if (
    cursor.kind !== kind || cursor.scope !== scope ||
    (direction !== undefined && cursor.direction !== direction) ||
    typeof cursor.cursor !== 'string'
  ) throw new Error('agent_runtime_projection_cursor_invalid');
  assertSourceCursor(cursor.cursor);
  return cursor;
}

function decodeMessageProjectionCursor(
  value: string,
  scope: string,
  direction?: ProjectionDirection,
): MessageProjectionCursor {
  const cursor = decodeProjectionCursor(value);
  if (
    cursor.kind !== 'turn-detail' || cursor.scope !== scope ||
    (direction !== undefined && cursor.direction !== direction) ||
    typeof cursor.cursor !== 'object' || cursor.cursor === null || Array.isArray(cursor.cursor)
  ) throw new Error('agent_runtime_projection_cursor_invalid');
  assertMessageCursor(cursor.cursor);
  return cursor;
}

function decodeProjectionCursor(value: string): ProjectionCursor {
  if (typeof value !== 'string' || value.length === 0 || value.length > AGENT_DEVICE_RPC_LIMITS.cursorCharacters) {
    throw new Error('agent_runtime_projection_cursor_invalid');
  }
  let parsed: unknown;
  try {
    const bytes = decodeBase64(value, { variant: 'url', padding: 'optional', allowEmpty: false, maxBytes: CURSOR_MAX_DECODED_BYTES });
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('agent_runtime_projection_cursor_invalid');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('agent_runtime_projection_cursor_invalid');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.version !== CURSOR_VERSION ||
    (record.kind !== 'conversations' && record.kind !== 'turns' && record.kind !== 'turn-detail') ||
    typeof record.scope !== 'string' || typeof record.revision !== 'string' ||
    (record.direction !== 'backward' && record.direction !== 'forward') ||
    !Object.hasOwn(record, 'cursor') ||
    Object.keys(record).sort().join(',') !== 'cursor,direction,kind,revision,scope,version'
  ) throw new Error('agent_runtime_projection_cursor_invalid');
  const cursor = record as unknown as ProjectionCursor;
  try {
    if (encodeProjectionCursor(cursor) !== value) throw new Error('noncanonical');
  } catch {
    throw new Error('agent_runtime_projection_cursor_invalid');
  }
  return cursor;
}

function assertCursorCommon(cursor: ProjectionCursor): void {
  if (
    !/^[\da-f]{64}$/u.test(cursor.scope) ||
    typeof cursor.revision !== 'string' || cursor.revision.length === 0 ||
    cursor.revision.length > CURSOR_MAX_SOURCE_CHARACTERS
  ) throw new Error('agent_runtime_projection_cursor_invalid');
}

function assertSourceCursor(cursor: string): void {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > CURSOR_MAX_SOURCE_CHARACTERS) {
    throw new Error('agent_runtime_projection_cursor_invalid');
  }
}

function assertMessageCursor(value: unknown): asserts value is ConversationMessageCursor {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'lamportClock,messageId,originNodeId,timestamp'
  ) throw new Error('agent_runtime_projection_cursor_invalid');
  const cursor = value as ConversationMessageCursor;
  if (
    !Number.isSafeInteger(cursor.timestamp) || cursor.timestamp < 0 ||
    !Number.isSafeInteger(cursor.lamportClock) || cursor.lamportClock < 0 ||
    typeof cursor.originNodeId !== 'string' || cursor.originNodeId.length === 0 || cursor.originNodeId.length > CURSOR_MAX_SOURCE_CHARACTERS ||
    typeof cursor.messageId !== 'string' || cursor.messageId.length === 0 || cursor.messageId.length > CURSOR_MAX_SOURCE_CHARACTERS
  ) throw new Error('agent_runtime_projection_cursor_invalid');
}

function assertConversationListPage(
  value: unknown,
  options: GetConversationListPageOptions,
): asserts value is Awaited<ReturnType<AgentRuntimeRpcProjectionStorage['listConversationsPage']>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_conversation_list_page');
  }
  const page = value as Record<string, unknown>;
  if (page.reset === true) {
    if (
      Object.keys(page).sort().join(',') !== 'reset,revision' ||
      typeof page.revision !== 'string' || page.revision.length === 0 ||
      options.expectedRevision === undefined
    ) throw new Error('invalid_conversation_list_page');
    return;
  }
  if (
    Object.keys(page).sort().join(',') !==
      'endCursor,hasMoreAfter,hasMoreBefore,items,reset,revision,startCursor,total' ||
    page.reset !== false || !Array.isArray(page.items) || page.items.length > options.limit ||
    typeof page.revision !== 'string' || page.revision.length === 0 ||
    !Number.isSafeInteger(page.total) || (page.total as number) < page.items.length ||
    typeof page.hasMoreBefore !== 'boolean' || typeof page.hasMoreAfter !== 'boolean' ||
    (options.expectedRevision !== undefined && page.revision !== options.expectedRevision)
  ) throw new Error('invalid_conversation_list_page');
  const items = page.items as unknown[];
  const first = items[0];
  if (
    (first !== undefined && (typeof page.startCursor !== 'string' || typeof page.endCursor !== 'string')) ||
    (first === undefined && (page.startCursor !== undefined || page.endCursor !== undefined || page.hasMoreBefore || page.hasMoreAfter))
  ) throw new Error('invalid_conversation_list_page');
  if (first !== undefined) {
    assertSourceCursor(page.startCursor as string);
    assertSourceCursor(page.endCursor as string);
  }
}

function assertConversationListScope(
  items: readonly unknown[],
  context: AgentRuntimeRpcCollectionQueryContext,
): void {
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('invalid_conversation_list_page');
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.conversationId !== 'string' || typeof record.definitionId !== 'string' ||
      (context.allowedConversationIds !== undefined && !context.allowedConversationIds.includes(record.conversationId)) ||
      (context.allowedDefinitionIds !== undefined && !context.allowedDefinitionIds.includes(record.definitionId))
    ) throw new Error('rpc_collection_scope_violation');
  }
}

function messageCursor(
  message: Pick<ConversationMessageListProjection, 'timestamp' | 'lamportClock' | 'originNodeId' | 'messageId'>,
): ConversationMessageCursor {
  return {
    timestamp: message.timestamp,
    lamportClock: message.lamportClock,
    originNodeId: message.originNodeId,
    messageId: message.messageId,
  };
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
