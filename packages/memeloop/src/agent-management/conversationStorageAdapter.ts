import { assertConversationMessageProjection } from '../storage/conversationPaging.js';
import type {
  ConversationMessageCursor,
  ConversationMessagePage,
  ConversationMessageWindowResult,
  GetConversationMessageWindowAroundOptions,
  GetMessagePageOptions,
} from '../storage/ports.js';
import type { AgentConversationMessagePage, AgentConversationMessagePageOptions, AgentConversationMessageWindowRequest, AgentConversationMessageWindowResult } from './types.js';

const CURSOR_VERSION = 1;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,4096}$/u;

interface CursorEnvelope {
  version: typeof CURSOR_VERSION;
  revision: string;
  cursor: ConversationMessageCursor;
}

/** Translate an opaque management request to the exact indexed storage query. */
export function agentConversationPageOptionsToStorage(
  options: AgentConversationMessagePageOptions,
): GetMessagePageOptions {
  const direction = options.direction ?? 'backward';
  const decoded = options.cursor === undefined
    ? undefined
    : decodeAgentConversationCursor(options.cursor, options.expectedRevision);
  return {
    limit: options.limit,
    maxBytes: options.maxBytes,
    direction,
    ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
    ...(decoded === undefined ? {} : direction === 'forward' ? { after: decoded.cursor } : { before: decoded.cursor }),
  };
}

/** Project one storage page without host-local DTOs or cursor codecs. */
export function storagePageToAgentConversationPage(
  conversationId: string,
  page: ConversationMessagePage,
  options: Pick<AgentConversationMessagePageOptions, 'limit' | 'maxBytes'>,
): AgentConversationMessagePage {
  if (page.conversationId !== conversationId) throw new Error('conversation_page_scope_mismatch');
  if (page.reset) return page;
  if (page.items.length > options.limit) throw new Error('conversation_page_row_budget_exceeded');
  const items = page.items.map(item => {
    assertConversationMessageProjection(item, conversationId);
    return item;
  });
  return {
    reset: false,
    conversationId,
    revision: page.revision,
    items,
    hasMoreBefore: page.hasMoreBefore,
    hasMoreAfter: page.hasMoreAfter,
    ...(page.hasMoreBefore
      ? { previousCursor: encodeRequiredCursor(page.revision, page.startCursor) }
      : {}),
    ...(page.hasMoreAfter
      ? { nextCursor: encodeRequiredCursor(page.revision, page.endCursor) }
      : {}),
  };
}

export function agentConversationWindowRequestToStorage(
  request: AgentConversationMessageWindowRequest,
): GetConversationMessageWindowAroundOptions {
  return {
    focus: request.focus,
    expectedRevision: request.expectedRevision,
    maxMessages: request.maxMessages,
    maxBytes: request.maxBytes,
  };
}

export function storageWindowToAgentConversationWindow(
  request: AgentConversationMessageWindowRequest,
  result: ConversationMessageWindowResult,
): AgentConversationMessageWindowResult {
  if (result.conversationId !== request.conversationId) throw new Error('conversation_window_scope_mismatch');
  if (result.reset) return result;
  if (result.items.length > request.maxMessages) throw new Error('conversation_window_row_budget_exceeded');
  for (const item of result.items) assertConversationMessageProjection(item, request.conversationId);
  return {
    reset: false,
    conversationId: request.conversationId,
    revision: result.revision,
    focus: result.focus,
    ...(result.recenterAnchor === undefined ? {} : { recenterAnchor: result.recenterAnchor }),
    items: result.items,
    hasMoreBefore: result.hasMoreBefore,
    hasMoreAfter: result.hasMoreAfter,
    ...(result.hasMoreBefore
      ? { previousCursor: encodeRequiredCursor(result.revision, result.startCursor) }
      : {}),
    ...(result.hasMoreAfter
      ? { nextCursor: encodeRequiredCursor(result.revision, result.endCursor) }
      : {}),
  };
}

export function encodeAgentConversationCursor(
  revision: string,
  cursor: ConversationMessageCursor,
): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ version: CURSOR_VERSION, revision, cursor } satisfies CursorEnvelope));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function decodeAgentConversationCursor(
  value: string,
  expectedRevision?: string,
): CursorEnvelope {
  if (!CURSOR_PATTERN.test(value)) throw new TypeError('invalid conversation cursor');
  let decoded: unknown;
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError('invalid conversation cursor');
  }
  if (!isCursorEnvelope(decoded) || expectedRevision === undefined || decoded.revision !== expectedRevision) {
    throw new TypeError('conversation cursor requires its matching expected revision');
  }
  return decoded;
}

function encodeRequiredCursor(revision: string, cursor: ConversationMessageCursor | undefined): string {
  if (cursor === undefined) throw new Error('conversation_page_boundary_cursor_missing');
  return encodeAgentConversationCursor(revision, cursor);
}

function isCursorEnvelope(value: unknown): value is CursorEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 || record.version !== CURSOR_VERSION ||
    typeof record.revision !== 'string' || record.revision.length < 1 || record.revision.length > 512 ||
    !record.cursor || typeof record.cursor !== 'object' || Array.isArray(record.cursor)
  ) return false;
  const cursor = record.cursor as Record<string, unknown>;
  return Object.keys(cursor).length === 4 && Number.isSafeInteger(cursor.timestamp) &&
    Number.isSafeInteger(cursor.lamportClock) && typeof cursor.originNodeId === 'string' &&
    cursor.originNodeId.length > 0 && typeof cursor.messageId === 'string' && cursor.messageId.length > 0;
}
