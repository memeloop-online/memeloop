import { assertCanonicalConversationEvent, type ConversationMessageEvent, type ConversationTombstoneEvent } from '../conversation/events.js';
import { canonicalJsonBytes } from '../encoding/canonicalJson.js';
import { assertConversationMessageProjection } from '../storage/conversationPaging.js';
import type { ConversationMessageListProjection } from '../storage/ports.js';

/**
 * Host-neutral limits for an interactive agent session.
 *
 * Network transports may impose smaller limits, but the controller must not
 * depend on a particular wire protocol merely to validate one host adapter.
 */
export const AGENT_SESSION_CONTRACT_LIMITS = Object.freeze(
  {
    cursorCharacters: 2_048,
    identifierCharacters: 512,
    messageProjectionBytes: 128 * 1_024,
    projectionPageDefaultBytes: 256 * 1_024,
    projectionPageMinBytes: 64 * 1_024,
    responseBytes: 16 * 1_024 * 1_024,
    turnDetailPage: 50,
  } as const,
);

export interface AgentConversationTurnDetailRequest {
  conversationId: string;
  turnId: string;
  cursor?: string;
  seenCursor?: string;
  direction?: 'backward' | 'forward';
  limit?: number;
  maxBytes?: number;
}

export interface AgentConversationTurnDetailResponse {
  turnId: string;
  /** Bounded list projections; callers hydrate full content on demand. */
  items: ConversationMessageListProjection[];
  nextCursor?: string;
  previousCursor?: string;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  seenCursorFound?: boolean;
}

export interface AgentConversationDeleteTurnRequest {
  conversationId: string;
  turnId: string;
  requestId: string;
  reason?: ConversationTombstoneEvent['reason'];
}

export interface AgentConversationDeleteTurnResponse {
  ok: true;
  conversationId: string;
  turnId: string;
  requestId: string;
  tombstone: ConversationTombstoneEvent;
}

export interface AgentConversationRetryTurnRequest {
  conversationId: string;
  turnId: string;
  requestId: string;
  newTurnId: string;
  definitionId?: string;
}

export interface AgentConversationRetryTurnResponse {
  ok: true;
  runId: string;
  requestId: string;
  turnId: string;
  conversationId: string;
  state: 'accepted';
  tombstone: ConversationTombstoneEvent;
  userEvent: ConversationMessageEvent;
}

export function parseAgentConversationTurnDetailResponse(
  request: AgentConversationTurnDetailRequest,
  value: unknown,
): AgentConversationTurnDetailResponse {
  const record = exactRecord(value, [
    'turnId',
    'items',
    'nextCursor',
    'previousCursor',
    'hasMoreBefore',
    'hasMoreAfter',
    'seenCursorFound',
  ], request.maxBytes ?? AGENT_SESSION_CONTRACT_LIMITS.projectionPageDefaultBytes);
  if (record.turnId !== request.turnId || !Array.isArray(record.items)) {
    throw contractError('turn_detail_identity');
  }
  const maximumItems = request.limit ?? AGENT_SESSION_CONTRACT_LIMITS.turnDetailPage;
  if (!Number.isSafeInteger(maximumItems) || maximumItems < 1 || record.items.length > maximumItems) {
    throw contractError('turn_detail_items');
  }
  for (const item of record.items) {
    try {
      assertConversationMessageProjection(item, request.conversationId);
    } catch {
      throw contractError('turn_detail_items');
    }
    if (item.turnId !== request.turnId) throw contractError('turn_detail_items');
  }
  assertPageNavigation(record);
  if (request.seenCursor !== undefined && typeof record.seenCursorFound !== 'boolean') {
    throw contractError('turn_detail_seen_cursor');
  }
  return value as AgentConversationTurnDetailResponse;
}

export function parseAgentConversationDeleteTurnResponse(
  request: AgentConversationDeleteTurnRequest,
  value: unknown,
): AgentConversationDeleteTurnResponse {
  const record = exactRecord(value, [
    'ok',
    'conversationId',
    'turnId',
    'requestId',
    'tombstone',
  ]);
  if (
    record.ok !== true ||
    record.conversationId !== request.conversationId ||
    record.turnId !== request.turnId ||
    record.requestId !== request.requestId
  ) throw contractError('delete_turn_identity');
  assertTombstone(record.tombstone, request.conversationId, request.turnId);
  if (
    request.reason !== undefined &&
    (record.tombstone as ConversationTombstoneEvent).reason !== request.reason
  ) throw contractError('delete_turn_reason');
  return value as AgentConversationDeleteTurnResponse;
}

export function parseAgentConversationRetryTurnResponse(
  request: AgentConversationRetryTurnRequest,
  value: unknown,
): AgentConversationRetryTurnResponse {
  const record = exactRecord(value, [
    'ok',
    'runId',
    'requestId',
    'turnId',
    'conversationId',
    'state',
    'tombstone',
    'userEvent',
  ]);
  if (
    record.ok !== true ||
    record.state !== 'accepted' ||
    !isIdentifier(record.runId) ||
    record.requestId !== request.requestId ||
    record.turnId !== request.newTurnId ||
    record.conversationId !== request.conversationId
  ) throw contractError('retry_turn_identity');
  assertTombstone(record.tombstone, request.conversationId, request.turnId);
  try {
    assertCanonicalConversationEvent(record.userEvent);
  } catch {
    throw contractError('retry_turn_user_event');
  }
  const userEvent = record.userEvent as ConversationMessageEvent;
  if (
    userEvent.kind !== 'message' ||
    userEvent.conversationId !== request.conversationId ||
    userEvent.message.messageId !== request.newTurnId ||
    userEvent.message.turnId !== request.newTurnId ||
    userEvent.message.role !== 'user'
  ) throw contractError('retry_turn_user_event');
  return value as AgentConversationRetryTurnResponse;
}

function exactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  maximumBytes = AGENT_SESSION_CONTRACT_LIMITS.responseBytes,
): Record<string, unknown> {
  try {
    canonicalJsonBytes(value, {
      maxBytes: maximumBytes,
      maxDepth: 64,
      maxNodes: 200_000,
      maxStringBytes: maximumBytes,
      maxStringCodeUnits: maximumBytes,
    });
  } catch {
    throw contractError('response_json');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw contractError('response_object');
  }
  const record = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(record).some(key => typeof key !== 'string' || !allowedKeys.includes(key))
  ) throw contractError('response_keys');
  return record;
}

function assertPageNavigation(record: Record<string, unknown>): void {
  if (typeof record.hasMoreBefore !== 'boolean' || typeof record.hasMoreAfter !== 'boolean') {
    throw contractError('page_navigation');
  }
  for (const value of [record.nextCursor, record.previousCursor]) {
    if (value !== undefined && !isOpaqueCursor(value)) throw contractError('page_cursor');
  }
  if (record.seenCursorFound !== undefined && typeof record.seenCursorFound !== 'boolean') {
    throw contractError('page_seen_cursor');
  }
}

function assertTombstone(value: unknown, conversationId: string, turnId: string): void {
  try {
    assertCanonicalConversationEvent(value);
  } catch {
    throw contractError('turn_tombstone');
  }
  const tombstone = value as ConversationTombstoneEvent;
  if (
    tombstone.kind !== 'tombstone' ||
    tombstone.conversationId !== conversationId ||
    tombstone.targetTurnId !== turnId
  ) throw contractError('turn_tombstone');
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= AGENT_SESSION_CONTRACT_LIMITS.identifierCharacters &&
    value === value.trim() &&
    !hasControlCharacters(value) &&
    new TextEncoder().encode(value).byteLength <= AGENT_SESSION_CONTRACT_LIMITS.identifierCharacters * 4;
}

function isOpaqueCursor(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= AGENT_SESSION_CONTRACT_LIMITS.cursorCharacters &&
    value === value.trim() &&
    !hasControlCharacters(value) &&
    new TextEncoder().encode(value).byteLength <= AGENT_SESSION_CONTRACT_LIMITS.cursorCharacters * 4;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7F) return true;
  }
  return false;
}

function contractError(field: string): Error {
  return new Error(`invalid_agent_conversation_${field}`);
}
