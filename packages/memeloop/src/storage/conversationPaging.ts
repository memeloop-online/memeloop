import {
  assertCanonicalChatMessageProjection,
  assertCanonicalConversationEvent,
  type ConversationEvent,
  conversationEventToMessage,
  type ConversationMessageEvent,
} from '../conversation/events.js';
import type { ChatMessage } from '../conversation/types.js';
import { canonicalJsonBytes } from '../encoding/canonicalJson.js';
import type {
  ConversationEventStore,
  ConversationMessageCursor,
  ConversationMessagePage,
  ConversationMessagePageSuccess,
  ConversationMessageWindowResult,
  ConversationMessageWindowSuccess,
  ConversationReadCallOptions,
  ConversationTimelineCompactionEntry,
  ConversationTimelineEntry,
  ConversationTimelinePage,
  ConversationTimelinePageCallOptions,
  ConversationTimelinePageSuccess,
  ConversationTimelineParticipantPreview,
  ConversationTimelineTurnEntry,
  GetConversationMessageWindowAroundOptions,
  GetConversationTimelinePageOptions,
  GetMessagePageOptions,
} from './ports.js';

/** One shared interactive row ceiling across local, RPC, browser, and native hosts. */
export const DEFAULT_MESSAGE_PAGE_SIZE = 50;
export const MAX_MESSAGE_PAGE_SIZE = 50;
export const MAX_CONVERSATION_TIMELINE_PAGE_SIZE = 50;
/** Opening or navigating a conversation never transfers a multi-megabyte page. */
export const MAX_CONVERSATION_TIMELINE_PAGE_BYTES = 256 * 1_024;
export const MAX_CONVERSATION_TIMELINE_PREVIEW_LENGTH = 240;
export const MAX_CONVERSATION_TIMELINE_PARTICIPANT_PREVIEWS = 4;
export const MAX_CONVERSATION_TIMELINE_PARTICIPANT_PREVIEW_LENGTH = 160;
export const MAX_CONVERSATION_TIMELINE_PARTICIPANT_PREVIEWS_BYTES = 1_024;
export const MAX_CONVERSATION_TIMELINE_TURN_ENTRY_BYTES = 1_024;
export const MAX_CONVERSATION_MESSAGE_WINDOW_SIZE = 50;
export const MAX_CONVERSATION_MESSAGE_WINDOW_BYTES = 256 * 1_024;

export type ConversationMessageListProjection =
  & Omit<
    ChatMessage,
    'parts' | 'toolCalls' | 'attachments' | 'reasoning_content'
  >
  & {
    parts?: never;
    toolCalls?: never;
    attachments?: never;
    reasoning_content?: never;
  };

export interface ConversationMessageDisplayTruncation {
  truncated: true;
  originalCharacterCount: number;
  originalEstimatedBytes: number;
  originalEstimatedRenderRows: number;
  contentTruncated: boolean;
  omittedFields: Array<'parts' | 'toolCalls' | 'attachments' | 'reasoning_content'>;
  capability: 'detail' | 'export';
}

/**
 * The single portable on-demand/list projector used by storage and RPC hosts.
 * It never retains heavy structured fields, preserves detailRef/agentRunError,
 * and fits the complete canonical projection within the caller's byte budget.
 */
export function projectConversationMessageForList(
  message: ChatMessage,
  maximumBytes: number,
): ConversationMessageListProjection {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error('invalid_conversation_message_projection_byte_budget');
  }
  const {
    attachments,
    parts,
    reasoning_content: reasoningContent,
    toolCalls,
    ...lightweight
  } = message;
  const omittedFields: ConversationMessageDisplayTruncation['omittedFields'] = [
    ...(parts === undefined ? [] : ['parts' as const]),
    ...(toolCalls === undefined ? [] : ['toolCalls' as const]),
    ...(attachments === undefined ? [] : ['attachments' as const]),
    ...(reasoningContent === undefined ? [] : ['reasoning_content' as const]),
  ];
  const originalBytes = new TextEncoder().encode(message.content).byteLength;
  let originalCharacters = 0;
  for (const _character of message.content) originalCharacters += 1;
  let originalRows = 1;
  for (let index = 0; index < message.content.length; index += 1) {
    if (message.content.charCodeAt(index) === 10) originalRows += 1;
  }
  const marker = (contentTruncated: boolean): ConversationMessageDisplayTruncation => ({
    truncated: true,
    originalCharacterCount: originalCharacters,
    originalEstimatedBytes: originalBytes,
    originalEstimatedRenderRows: originalRows,
    contentTruncated,
    omittedFields,
    capability: 'detail',
  });
  const metadata = omittedFields.length === 0
    ? message.metadata
    : { ...message.metadata, displayTruncation: marker(false) };
  const initial: ConversationMessageListProjection = {
    ...lightweight,
    ...(metadata === undefined ? {} : { metadata }),
  };
  if (conversationMessageProjectionFits(initial, maximumBytes)) return initial;

  const agentRunError = message.metadata?.agentRunError;
  const fallbackMetadata = {
    ...(agentRunError === undefined ? {} : { agentRunError }),
    displayTruncation: marker(true),
  };
  const base: ConversationMessageListProjection = {
    ...lightweight,
    content: '',
    metadata: fallbackMetadata,
  };
  if (!conversationMessageProjectionFits(base, maximumBytes)) {
    throw new Error('conversation_message_projection_item_exceeds_byte_budget');
  }
  const encoded = new TextEncoder().encode(message.content);
  let lower = 0;
  let upper = encoded.byteLength;
  let best = '';
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const content = utf8ProjectionPrefix(encoded, middle);
    const candidate = { ...base, content };
    if (conversationMessageProjectionFits(candidate, maximumBytes)) {
      best = content;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return { ...base, content: best };
}

function conversationMessageProjectionFits(value: unknown, maximumBytes: number): boolean {
  try {
    canonicalJsonBytes(value, {
      maxBytes: maximumBytes,
      maxDepth: 32,
      maxNodes: 10_000,
      maxStringBytes: maximumBytes,
      maxStringCodeUnits: maximumBytes,
    });
    return true;
  } catch {
    return false;
  }
}

function utf8ProjectionPrefix(encoded: Uint8Array, maximumBytes: number): string {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = Math.min(maximumBytes, encoded.byteLength); end >= Math.max(0, maximumBytes - 3); end -= 1) {
    try {
      return decoder.decode(encoded.subarray(0, end));
    } catch {
      // Only a partial trailing code point can fail; UTF-8 code points are at most four bytes.
    }
  }
  return '';
}

export function messageCursor(message: ChatMessage): ConversationMessageCursor {
  return {
    timestamp: message.timestamp,
    lamportClock: message.lamportClock,
    originNodeId: message.originNodeId,
    messageId: message.messageId,
  };
}

export function compareMessageCursor(
  left: ConversationMessageCursor,
  right: ConversationMessageCursor,
): number {
  return left.timestamp - right.timestamp ||
    left.lamportClock - right.lamportClock ||
    compareUtf8Text(left.originNodeId, right.originNodeId) ||
    compareUtf8Text(left.messageId, right.messageId);
}

/**
 * SQLite's default BINARY collation compares UTF-8 bytes. Comparing Unicode
 * code points gives the same order for valid strings and, unlike
 * `localeCompare`, is independent of the host locale.
 */
function compareUtf8Text(left: string, right: string): number {
  const leftIterator = left[Symbol.iterator]();
  const rightIterator = right[Symbol.iterator]();
  for (;;) {
    const leftItem = leftIterator.next();
    const rightItem = rightIterator.next();
    if (leftItem.done || rightItem.done) {
      if (leftItem.done && rightItem.done) return 0;
      return leftItem.done ? -1 : 1;
    }
    const difference = leftItem.value.codePointAt(0)! - rightItem.value.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
}

export function normalizeMessagePageLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) return DEFAULT_MESSAGE_PAGE_SIZE;
  return Math.min(limit, MAX_MESSAGE_PAGE_SIZE);
}

/** Read a bounded page from a storage host without any full-history fallback. */
export async function readConversationMessagePage(
  storage: ConversationEventStore,
  conversationId: string,
  options: GetMessagePageOptions,
  callOptions: ConversationReadCallOptions = {},
): Promise<ConversationMessagePage> {
  const normalized = { ...options, limit: normalizeMessagePageLimit(options.limit) };
  assertMessagePageOptions(normalized);
  callOptions.signal?.throwIfAborted();
  const result = await storage.getMessagePage(conversationId, normalized, callOptions);
  callOptions.signal?.throwIfAborted();
  assertConversationMessagePage(result, conversationId, normalized);
  return result;
}

/** O(n) memory-host helper; persistent hosts select the same window transactionally. */
export function buildConversationMessagePage(
  sourceMessages: readonly ChatMessage[],
  conversationId: string,
  options: GetMessagePageOptions,
  currentRevision: string,
): ConversationMessagePage {
  assertMessagePageOptions(options);
  assertOpaqueTimelineValue(currentRevision, 'revision');
  if (options.expectedRevision !== undefined && options.expectedRevision !== currentRevision) {
    return { reset: true, conversationId, revision: currentRevision };
  }
  const messages = sourceMessages
    .filter(message => message.conversationId === conversationId)
    .sort((left, right) => compareMessageCursor(messageCursor(left), messageCursor(right)));
  let start = 0;
  let end = messages.length;
  if (options.before) {
    const index = messages.findIndex(message => compareMessageCursor(messageCursor(message), options.before!) === 0);
    if (index < 0) return { reset: true, conversationId, revision: currentRevision };
    end = index;
    start = Math.max(0, end - options.limit);
  } else if (options.after) {
    const index = messages.findIndex(message => compareMessageCursor(messageCursor(message), options.after!) === 0);
    if (index < 0) return { reset: true, conversationId, revision: currentRevision };
    start = index + 1;
    end = Math.min(messages.length, start + options.limit);
  } else {
    start = Math.max(0, messages.length - options.limit);
  }
  const projectOnDemand = options.mode === 'on-demand' || options.mode === 'metadata-only';
  let items = messages.slice(start, end).map(message =>
    projectOnDemand
      ? projectConversationMessageForList(message, Math.max(1, options.maxBytes - 4_096))
      : message
  );
  let result = messagePageSuccess(conversationId, currentRevision, messages.length, start, items);
  while (!messageWindowFits(result, options.maxBytes)) {
    if (items.length <= 1) throw new Error('conversation_message_page_exceeds_byte_budget');
    if (options.after) items = items.slice(0, -1);
    else {
      items = items.slice(1);
      start += 1;
    }
    result = messagePageSuccess(conversationId, currentRevision, messages.length, start, items);
  }
  assertConversationMessagePage(result, conversationId, options);
  return result;
}

function messagePageSuccess(
  conversationId: string,
  revision: string,
  total: number,
  start: number,
  items: ChatMessage[],
): ConversationMessagePageSuccess {
  const first = items[0];
  const last = items.at(-1);
  return {
    reset: false,
    conversationId,
    revision,
    items,
    hasMoreBefore: start > 0,
    hasMoreAfter: start + items.length < total,
    ...(first ? { startCursor: messageCursor(first) } : {}),
    ...(last ? { endCursor: messageCursor(last) } : {}),
  };
}

function assertMessagePageOptions(options: GetMessagePageOptions): void {
  if (
    !options ||
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > MAX_MESSAGE_PAGE_SIZE ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    options.maxBytes > MAX_CONVERSATION_MESSAGE_WINDOW_BYTES ||
    (options.before !== undefined && options.after !== undefined)
  ) throw new Error('invalid_conversation_message_page_options');
  if ((options.before || options.after) && options.expectedRevision === undefined) {
    throw new Error('conversation_message_cursor_requires_revision');
  }
  if (options.expectedRevision !== undefined) {
    assertOpaqueTimelineValue(options.expectedRevision, 'expected_revision');
  }
}

export function assertConversationMessagePage(
  value: unknown,
  conversationId: string,
  options: GetMessagePageOptions,
): asserts value is ConversationMessagePage {
  assertMessagePageOptions(options);
  if (!messageWindowFits(value, options.maxBytes) || value === null || typeof value !== 'object') {
    throw new Error('invalid_conversation_message_page');
  }
  const result = value as ConversationMessagePage;
  if (result.conversationId !== conversationId || !isNonEmptyText(result.revision)) {
    throw new Error('invalid_conversation_message_page_scope');
  }
  if (result.reset) {
    assertWindowExactKeys(result, ['reset', 'conversationId', 'revision']);
    if (options.expectedRevision === undefined) {
      throw new Error('invalid_conversation_message_page_reset');
    }
    return;
  }
  assertWindowExactKeys(result, [
    'reset',
    'conversationId',
    'revision',
    'items',
    'hasMoreBefore',
    'hasMoreAfter',
    'startCursor',
    'endCursor',
  ]);
  if (
    result.reset ||
    (options.expectedRevision !== undefined && result.revision !== options.expectedRevision) ||
    !Array.isArray(result.items) ||
    result.items.length > options.limit ||
    typeof result.hasMoreBefore !== 'boolean' ||
    typeof result.hasMoreAfter !== 'boolean'
  ) throw new Error('invalid_conversation_message_page');
  for (let index = 0; index < result.items.length; index += 1) {
    assertWindowMessage(result.items[index], conversationId);
    if (
      index > 0 &&
      compareMessageCursor(messageCursor(result.items[index - 1]), messageCursor(result.items[index])) >= 0
    ) throw new Error('invalid_conversation_message_page_order');
  }
  const first = result.items[0];
  const last = result.items.at(-1);
  if (
    (first && (!result.startCursor || compareMessageCursor(result.startCursor, messageCursor(first)) !== 0)) ||
    (last && (!result.endCursor || compareMessageCursor(result.endCursor, messageCursor(last)) !== 0)) ||
    (!first && (result.startCursor !== undefined || result.endCursor !== undefined ||
      result.hasMoreBefore || result.hasMoreAfter))
  ) throw new Error('invalid_conversation_message_page_cursor');
}

/** Strict bounded list/live projection; structured heavy fields are detail-only. */
export function assertConversationMessageProjection(
  value: unknown,
  conversationId?: string,
): asserts value is ChatMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_conversation_message_projection');
  }
  const message = value as ChatMessage;
  assertWindowExactKeys(message, [
    'messageId',
    'turnId',
    'conversationId',
    'originNodeId',
    'originSequence',
    'timestamp',
    'lamportClock',
    'role',
    'content',
    'detailRef',
    'contentType',
    'hidden',
    'duration',
    'metadata',
  ]);
  try {
    assertCanonicalChatMessageProjection(message, conversationId);
  } catch (error) {
    throw new Error('invalid_conversation_message_projection', { cause: error });
  }
}

function preview(content: string, maxLength: number): string {
  let lineStart = 0;
  while (lineStart <= content.length) {
    const newline = content.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? content.length : newline;
    let start = lineStart;
    while (start < lineEnd && isPreviewWhitespace(content[start])) start += 1;
    let end = lineEnd;
    while (end > start && isPreviewWhitespace(content[end - 1])) end -= 1;
    if (end > start) {
      const length = end - start;
      if (length <= maxLength) return content.slice(start, end);
      if (maxLength === 1) return '…';
      let prefixEnd = start + maxLength - 1;
      const previous = content.charCodeAt(prefixEnd - 1);
      const next = content.charCodeAt(prefixEnd);
      if (
        previous >= 0xD800 && previous <= 0xDBFF &&
        next >= 0xDC00 && next <= 0xDFFF
      ) prefixEnd -= 1;
      return `${content.slice(start, prefixEnd)}…`;
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  return '';
}

function timelineParticipantPreview(
  message: ConversationMessageEvent['message'],
  originNodeId: string,
  requestedPreviewLength: number,
): ConversationTimelineParticipantPreview {
  if (message.role !== 'assistant' && message.role !== 'agent') {
    throw new Error('invalid_conversation_timeline_participant_role');
  }
  const metadata = message.metadata;
  const actorId = boundedParticipantIdentity(
    metadataText(metadata, 'actorId') ?? metadataText(metadata, 'agentId') ?? originNodeId,
  );
  const actorLabel = boundedParticipantIdentity(
    metadataText(metadata, 'actorLabel') ?? metadataText(metadata, 'agentName') ?? actorId,
  );
  return {
    actorId,
    actorLabel,
    role: message.role,
    preview: preview(
      message.content,
      Math.min(requestedPreviewLength, MAX_CONVERSATION_TIMELINE_PARTICIPANT_PREVIEW_LENGTH),
    ),
  };
}

function metadataText(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function boundedParticipantIdentity(value: string): string {
  return preview(value, 64) || 'unknown';
}

function boundedParticipantPreviewSample(
  responses: readonly ConversationTimelineParticipantPreview[],
): ConversationTimelineParticipantPreview[] {
  const sample = responses.length <= MAX_CONVERSATION_TIMELINE_PARTICIPANT_PREVIEWS
    ? [...responses]
    : [...responses.slice(0, 2), ...responses.slice(-2)];
  return sample;
}

function participantPreviewsFit(value: unknown): boolean {
  try {
    canonicalJsonBytes(value, {
      maxBytes: MAX_CONVERSATION_TIMELINE_PARTICIPANT_PREVIEWS_BYTES,
      maxDepth: 4,
      maxNodes: 64,
      maxStringBytes: MAX_CONVERSATION_TIMELINE_PARTICIPANT_PREVIEWS_BYTES,
      maxStringCodeUnits: MAX_CONVERSATION_TIMELINE_PARTICIPANT_PREVIEWS_BYTES,
    });
    return true;
  } catch {
    return false;
  }
}

export function boundConversationTimelineTurnEntry(
  source: ConversationTimelineTurnEntry,
): ConversationTimelineTurnEntry {
  const entry: ConversationTimelineTurnEntry = {
    ...source,
    participantPreviews: source.participantPreviews.map(item => ({
      actorId: preview(item.actorId, MAX_CONVERSATION_TIMELINE_PARTICIPANT_PREVIEW_LENGTH),
      actorLabel: preview(item.actorLabel, MAX_CONVERSATION_TIMELINE_PARTICIPANT_PREVIEW_LENGTH),
      role: item.role,
      preview: preview(item.preview, MAX_CONVERSATION_TIMELINE_PARTICIPANT_PREVIEW_LENGTH),
    })),
  };
  while (
    !timelineTurnEntryFits(entry) &&
    entry.participantPreviews.some(item => item.preview.length > 1)
  ) {
    entry.participantPreviews = entry.participantPreviews.map(item => ({
      ...item,
      preview: preview(item.preview, Math.max(1, Math.floor(item.preview.length / 2))),
    }));
  }
  while (
    !timelineTurnEntryFits(entry) &&
    entry.participantPreviews.some(item => item.actorId.length > 16 || item.actorLabel.length > 16)
  ) {
    entry.participantPreviews = entry.participantPreviews.map(item => ({
      ...item,
      actorId: preview(item.actorId, Math.max(16, Math.floor(item.actorId.length / 2))),
      actorLabel: preview(item.actorLabel, Math.max(16, Math.floor(item.actorLabel.length / 2))),
    }));
  }
  while (!timelineTurnEntryFits(entry) && entry.userPreview.length > 1) {
    entry.userPreview = preview(entry.userPreview, Math.max(1, Math.floor(entry.userPreview.length / 2)));
  }
  if (!timelineTurnEntryFits(entry)) {
    throw new Error('conversation_timeline_turn_entry_exceeds_byte_budget');
  }
  return entry;
}

function timelineTurnEntryFits(value: unknown): boolean {
  try {
    canonicalJsonBytes(value, {
      maxBytes: MAX_CONVERSATION_TIMELINE_TURN_ENTRY_BYTES,
      maxDepth: 6,
      maxNodes: 128,
      maxStringBytes: MAX_CONVERSATION_TIMELINE_TURN_ENTRY_BYTES,
      maxStringCodeUnits: MAX_CONVERSATION_TIMELINE_TURN_ENTRY_BYTES,
    });
    return true;
  } catch {
    return false;
  }
}

function assertTimelineParticipantPreview(value: unknown): asserts value is ConversationTimelineParticipantPreview {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_conversation_timeline_participant_preview');
  }
  const participant = value as ConversationTimelineParticipantPreview;
  assertExactKeys(participant, ['actorId', 'actorLabel', 'role', 'preview'], 'participant_preview');
  if (
    !isNonEmptyText(participant.actorId) ||
    participant.actorId.length > MAX_CONVERSATION_TIMELINE_PARTICIPANT_PREVIEW_LENGTH ||
    !isNonEmptyText(participant.actorLabel) ||
    participant.actorLabel.length > MAX_CONVERSATION_TIMELINE_PARTICIPANT_PREVIEW_LENGTH ||
    (participant.role !== 'assistant' && participant.role !== 'agent') ||
    typeof participant.preview !== 'string' ||
    participant.preview.length > MAX_CONVERSATION_TIMELINE_PARTICIPANT_PREVIEW_LENGTH
  ) throw new Error('invalid_conversation_timeline_participant_preview');
}

function isPreviewWhitespace(value: string): boolean {
  return value.trim().length === 0;
}

function normalizeTimelinePreviewLength(requested: number | undefined): number {
  return Math.max(
    1,
    Math.min(
      Number.isSafeInteger(requested) ? requested! : 96,
      MAX_CONVERSATION_TIMELINE_PREVIEW_LENGTH,
    ),
  );
}

/** Read the required revisioned projection with no getMessages fallback. */
export async function readConversationTimelinePage(
  storage: ConversationEventStore,
  conversationId: string,
  options: GetConversationTimelinePageOptions,
  callOptions: ConversationTimelinePageCallOptions = {},
): Promise<ConversationTimelinePage> {
  assertTimelinePageOptions(options);
  callOptions.signal?.throwIfAborted();
  if (typeof storage.getConversationTimelinePage !== 'function') {
    throw new Error('conversation timeline page reader unavailable');
  }
  const page = await storage.getConversationTimelinePage(conversationId, options, callOptions);
  callOptions.signal?.throwIfAborted();
  assertConversationTimelinePage(page, conversationId, options);
  return page;
}

/** Explicit full-array builder for memory-only hosts; currentRevision is host-owned. */
export function buildConversationTimelinePage(
  sourceEvents: readonly ConversationEvent[],
  conversationId: string,
  options: GetConversationTimelinePageOptions,
  currentRevision: string,
): ConversationTimelinePage {
  assertTimelinePageOptions(options);
  assertOpaqueTimelineValue(currentRevision, 'revision');
  if (
    options.expectedRevision !== undefined &&
    options.expectedRevision !== currentRevision
  ) return boundedTimelineReset(currentRevision, options.maxBytes);

  const materialized = materializeTimeline(
    sourceEvents,
    conversationId,
    normalizeTimelinePreviewLength(options.previewLength),
  );
  const { entries, messageEvents, totalTurns: turnIndex } = materialized;
  const range = timelinePageRange(entries, options);
  if (range === null) return boundedTimelineReset(currentRevision, options.maxBytes);
  let items = entries.slice(range.start, range.end);
  let page = timelineSuccessPage(items, messageEvents.length, turnIndex, entries.length, currentRevision, range);
  while (!timelinePageFits(page, options.maxBytes)) {
    if (items.length === 0) throw new Error('conversation_timeline_page_exceeds_byte_budget');
    items = trimTimelineItems(items, options);
    if (items.length === 0) throw new Error('conversation_timeline_entry_exceeds_byte_budget');
    page = timelineSuccessPage(items, messageEvents.length, turnIndex, entries.length, currentRevision, range);
  }
  assertConversationTimelinePage(page, conversationId, options);
  return page;
}

interface MaterializedTimeline {
  events: ConversationEvent[];
  messageEvents: ConversationMessageEvent[];
  entries: ConversationTimelineEntry[];
  totalTurns: number;
}

function materializeTimeline(
  sourceEvents: readonly ConversationEvent[],
  conversationId: string,
  previewLength: number,
): MaterializedTimeline {
  for (const event of sourceEvents) assertCanonicalConversationEvent(event);
  const events = [...sourceEvents]
    .filter(event => event.conversationId === conversationId)
    .sort(compareTimelineEvents);
  const tombstonedTurnIds = new Set(
    events.filter(event => event.kind === 'tombstone').map(event => event.targetTurnId),
  );
  const messageEvents = events.filter((event): event is ConversationMessageEvent =>
    event.kind === 'message' &&
    event.message.hidden !== true &&
    !tombstonedTurnIds.has(event.message.turnId)
  );
  const visibleMessageEventIds = new Set(messageEvents.map(event => event.eventId));
  const entries: ConversationTimelineEntry[] = [];
  const turnsById = new Map<string, ConversationTimelineTurnEntry>();
  const compactionEventIds = new Set<string>();
  let turnIndex = 0;
  for (const event of events) {
    if (
      event.kind === 'compaction' &&
      event.mode === 'summary' &&
      !tombstonedTurnIds.has(event.summary.turnId) &&
      preview(event.summary.content, previewLength).length > 0
    ) {
      const entry: ConversationTimelineCompactionEntry = {
        kind: 'compaction',
        entryId: event.eventId,
        conversationId,
        timestamp: event.timestamp,
        lamportClock: event.lamportClock,
        originNodeId: event.originNodeId,
        cursor: memoryTimelineCursor(event),
        entryIndex: entries.length,
        turnIndex,
        summaryPreview: preview(event.summary.content, previewLength),
        compactedMessageCount: event.boundary.droppedMessageCount,
        compactedTurnCount: event.boundary.droppedTurnCount,
      };
      entries.push(entry);
      compactionEventIds.add(event.eventId);
      continue;
    }
    if (event.kind !== 'message' || !visibleMessageEventIds.has(event.eventId)) continue;
    const message = event.message;
    if (
      message.role !== 'user' ||
      message.messageId !== message.turnId ||
      turnsById.has(message.turnId)
    ) continue;
    const entry: ConversationTimelineTurnEntry = {
      kind: 'turn',
      entryId: message.messageId,
      messageId: message.messageId,
      conversationId,
      timestamp: event.timestamp,
      lamportClock: event.lamportClock,
      originNodeId: event.originNodeId,
      cursor: memoryTimelineCursor(event),
      entryIndex: entries.length,
      turnIndex,
      turnId: message.turnId,
      userPreview: preview(message.content, previewLength),
      participantPreviews: [],
      responseCount: 0,
    };
    entries.push(entry);
    turnsById.set(message.turnId, entry);
    turnIndex += 1;
  }
  for (const event of messageEvents) {
    const message = event.message;
    if (
      compactionEventIds.has(event.eventId) ||
      (message.role !== 'assistant' && message.role !== 'agent')
    ) continue;
    const entry = turnsById.get(message.turnId);
    if (!entry) continue;
    entry.responseCount += 1;
    entry.participantPreviews.push(timelineParticipantPreview(
      message,
      event.originNodeId,
      previewLength,
    ));
  }
  for (const entry of turnsById.values()) {
    entry.participantPreviews = boundedParticipantPreviewSample(entry.participantPreviews);
    Object.assign(entry, boundConversationTimelineTurnEntry(entry));
  }

  return { events, messageEvents, entries, totalTurns: turnIndex };
}

/** Required single-read wrapper; never composes timeline and message pages client-side. */
export async function readConversationMessageWindowAround(
  storage: ConversationEventStore,
  conversationId: string,
  options: GetConversationMessageWindowAroundOptions,
  callOptions: ConversationTimelinePageCallOptions = {},
): Promise<ConversationMessageWindowResult> {
  assertMessageWindowOptions(options);
  callOptions.signal?.throwIfAborted();
  const result = await storage.getMessageWindowAround(conversationId, options, callOptions);
  callOptions.signal?.throwIfAborted();
  assertConversationMessageWindowResult(result, conversationId, options);
  return result;
}

/** Explicit O(n) memory-host builder. Persistent hosts use indexed transactional reads. */
export function buildConversationMessageWindowAround(
  sourceEvents: readonly ConversationEvent[],
  conversationId: string,
  options: GetConversationMessageWindowAroundOptions,
  currentRevision: string,
): ConversationMessageWindowResult {
  assertMessageWindowOptions(options);
  assertOpaqueTimelineValue(currentRevision, 'revision');
  if (options.expectedRevision !== currentRevision) {
    const reset = boundedMessageWindowReset(conversationId, currentRevision, options.maxBytes);
    assertConversationMessageWindowResult(reset, conversationId, options);
    return reset;
  }
  const materialized = materializeTimeline(sourceEvents, conversationId, 96);
  const requestedFocus = options.focus;
  const requestedEntry = requestedFocus.kind === 'timeline-entry'
    ? materialized.entries.find(entry => entry.entryId === requestedFocus.entryId && entry.cursor === requestedFocus.cursor)
    : materialized.entries.find(entry =>
      entry.kind === 'turn' &&
      entry.turnId === requestedFocus.turnId &&
      (requestedFocus.cursor === undefined || entry.cursor === requestedFocus.cursor)
    );
  if (!requestedEntry) {
    const reset = boundedMessageWindowReset(conversationId, currentRevision, options.maxBytes);
    assertConversationMessageWindowResult(reset, conversationId, options);
    return reset;
  }

  let focus: ConversationMessageWindowSuccess['focus'];
  let anchorTurnId: string | undefined;
  if (requestedEntry.kind === 'turn') {
    anchorTurnId = requestedEntry.turnId;
    focus = {
      kind: 'turn',
      turnId: requestedEntry.turnId,
      ...(options.focus.kind === 'timeline-entry'
        ? { entryId: requestedEntry.entryId, cursor: requestedEntry.cursor }
        : options.focus.cursor === undefined
        ? {}
        : { cursor: requestedEntry.cursor }),
    };
  } else {
    const nearest = nearestTimelineTurn(materialized.entries, requestedEntry.entryIndex);
    anchorTurnId = nearest?.entry.turnId;
    focus = {
      kind: 'compaction',
      entry: requestedEntry,
      ...(nearest
        ? { nearestPosition: nearest.position, nearestTurnId: nearest.entry.turnId }
        : { nearestPosition: 'none' }),
    };
  }

  const messages = materialized.messageEvents.map(event =>
    projectConversationMessageForList(
      conversationEventToMessage(event),
      Math.max(1, options.maxBytes - 4_096),
    )
  );
  const anchorIndex = anchorTurnId === undefined
    ? -1
    : messages.findIndex(message => message.turnId === anchorTurnId);
  let start = anchorIndex < 0
    ? 0
    : Math.max(
      0,
      Math.min(
        anchorIndex - Math.floor(options.maxMessages / 2),
        Math.max(0, messages.length - options.maxMessages),
      ),
    );
  let end = anchorIndex < 0 ? 0 : Math.min(messages.length, start + options.maxMessages);
  let result = messageWindowSuccess(
    conversationId,
    currentRevision,
    focus,
    messages,
    start,
    end,
  );
  while (!messageWindowFits(result, options.maxBytes)) {
    if (end <= start + 1) throw new Error('conversation_message_window_focus_exceeds_byte_budget');
    const distanceBefore = anchorIndex - start;
    const distanceAfter = end - 1 - anchorIndex;
    if (distanceAfter > distanceBefore) end -= 1;
    else start += 1;
    result = messageWindowSuccess(
      conversationId,
      currentRevision,
      focus,
      messages,
      start,
      end,
    );
  }
  assertConversationMessageWindowResult(result, conversationId, options);
  return result;
}

function nearestTimelineTurn(
  entries: readonly ConversationTimelineEntry[],
  focusEntryIndex: number,
): { entry: ConversationTimelineTurnEntry; position: 'before' | 'after' } | undefined {
  let before: ConversationTimelineTurnEntry | undefined;
  let after: ConversationTimelineTurnEntry | undefined;
  for (let index = focusEntryIndex - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === 'turn') {
      before = entry;
      break;
    }
  }
  for (let index = focusEntryIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.kind === 'turn') {
      after = entry;
      break;
    }
  }
  if (!before) return after ? { entry: after, position: 'after' } : undefined;
  if (!after) return { entry: before, position: 'before' };
  return after.entryIndex - focusEntryIndex <= focusEntryIndex - before.entryIndex
    ? { entry: after, position: 'after' }
    : { entry: before, position: 'before' };
}

function messageWindowSuccess(
  conversationId: string,
  revision: string,
  focus: ConversationMessageWindowSuccess['focus'],
  allMessages: readonly ChatMessage[],
  start: number,
  end: number,
): ConversationMessageWindowSuccess {
  const items = allMessages.slice(start, end);
  const first = items[0];
  const last = items.at(-1);
  return {
    reset: false,
    conversationId,
    revision,
    focus,
    items,
    hasMoreBefore: start > 0,
    hasMoreAfter: end < allMessages.length,
    ...(first ? { startCursor: messageCursor(first) } : {}),
    ...(last ? { endCursor: messageCursor(last) } : {}),
  };
}

function boundedMessageWindowReset(
  conversationId: string,
  revision: string,
  maxBytes: number,
): ConversationMessageWindowResult {
  const reset = { reset: true as const, conversationId, revision };
  if (!messageWindowFits(reset, maxBytes)) {
    throw new Error('conversation_message_window_exceeds_byte_budget');
  }
  return reset;
}

function assertMessageWindowOptions(options: GetConversationMessageWindowAroundOptions): void {
  if (
    !options ||
    !Number.isSafeInteger(options.maxMessages) ||
    options.maxMessages < 1 ||
    options.maxMessages > MAX_CONVERSATION_MESSAGE_WINDOW_SIZE
  ) throw new Error('invalid_conversation_message_window_limit');
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    options.maxBytes > MAX_CONVERSATION_MESSAGE_WINDOW_BYTES
  ) throw new Error('invalid_conversation_message_window_byte_budget');
  assertOpaqueTimelineValue(options.expectedRevision, 'expected_revision');
  if (!options.focus || !isNonEmptyText(options.focus.kind)) {
    throw new Error('invalid_conversation_message_window_focus');
  }
  if (options.focus.kind === 'turn') {
    if (!isNonEmptyText(options.focus.turnId)) {
      throw new Error('invalid_conversation_message_window_focus');
    }
    if (options.focus.cursor !== undefined) {
      assertOpaqueTimelineValue(options.focus.cursor, 'focus.cursor');
    }
    return;
  }
  if (
    options.focus.kind !== 'timeline-entry' ||
    !isNonEmptyText(options.focus.entryId)
  ) throw new Error('invalid_conversation_message_window_focus');
  assertOpaqueTimelineValue(options.focus.cursor, 'focus.cursor');
}

function messageWindowFits(value: unknown, maxBytes: number): boolean {
  try {
    canonicalJsonBytes(value, {
      maxBytes,
      maxDepth: 32,
      maxNodes: 100_000,
      maxStringBytes: maxBytes,
      maxStringCodeUnits: maxBytes,
    });
    return true;
  } catch {
    return false;
  }
}

/** Strict storage/wire assertion shared by hosts and the device RPC boundary. */
export function assertConversationMessageWindowResult(
  value: unknown,
  conversationId: string,
  options: GetConversationMessageWindowAroundOptions,
): asserts value is ConversationMessageWindowResult {
  assertMessageWindowOptions(options);
  if (!messageWindowFits(value, options.maxBytes)) {
    throw new Error('conversation_message_window_exceeds_byte_budget');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_conversation_message_window');
  }
  const result = value as ConversationMessageWindowResult;
  if (result.conversationId !== conversationId) {
    throw new Error('invalid_conversation_message_window_scope');
  }
  assertOpaqueTimelineValue(result.revision, 'message_window_revision');
  if (result.reset) {
    assertWindowExactKeys(result, ['reset', 'conversationId', 'revision']);
    return;
  }
  assertWindowExactKeys(result, [
    'reset',
    'conversationId',
    'revision',
    'focus',
    'items',
    'hasMoreBefore',
    'hasMoreAfter',
    'startCursor',
    'endCursor',
  ]);
  if (
    result.reset ||
    result.revision !== options.expectedRevision ||
    !Array.isArray(result.items) ||
    result.items.length > options.maxMessages ||
    typeof result.hasMoreBefore !== 'boolean' ||
    typeof result.hasMoreAfter !== 'boolean'
  ) throw new Error('invalid_conversation_message_window');
  const ids = new Set<string>();
  for (let index = 0; index < result.items.length; index += 1) {
    const message = result.items[index];
    assertWindowMessage(message, conversationId);
    if (ids.has(message.messageId)) throw new Error('invalid_conversation_message_window_items');
    ids.add(message.messageId);
    if (
      index > 0 &&
      compareMessageCursor(messageCursor(result.items[index - 1]), messageCursor(message)) >= 0
    ) throw new Error('invalid_conversation_message_window_order');
  }
  const first = result.items[0];
  const last = result.items.at(-1);
  if (
    (first && (!result.startCursor || compareMessageCursor(result.startCursor, messageCursor(first)) !== 0)) ||
    (last && (!result.endCursor || compareMessageCursor(result.endCursor, messageCursor(last)) !== 0)) ||
    (!first && (result.startCursor !== undefined || result.endCursor !== undefined ||
      result.hasMoreBefore || result.hasMoreAfter))
  ) throw new Error('invalid_conversation_message_window_cursor');
  assertResolvedWindowFocus(result, options);
}

function assertResolvedWindowFocus(
  result: ConversationMessageWindowSuccess,
  options: GetConversationMessageWindowAroundOptions,
): void {
  const focus = result.focus;
  if (focus.kind === 'turn') {
    assertWindowExactKeys(focus, ['kind', 'turnId', 'entryId', 'cursor']);
    if (
      !isNonEmptyText(focus.turnId) ||
      !result.items.some(message => message.turnId === focus.turnId) ||
      (options.focus.kind === 'turn' && (
        focus.turnId !== options.focus.turnId ||
        focus.entryId !== undefined ||
        focus.cursor !== options.focus.cursor
      )) ||
      (options.focus.kind === 'timeline-entry' && (
        focus.entryId !== options.focus.entryId || focus.cursor !== options.focus.cursor
      ))
    ) throw new Error('invalid_conversation_message_window_focus');
    return;
  }
  assertWindowExactKeys(focus, ['kind', 'entry', 'nearestPosition', 'nearestTurnId']);
  if (options.focus.kind !== 'timeline-entry' || focus.kind !== 'compaction') {
    throw new Error('invalid_conversation_message_window_focus');
  }
  const entry = focus.entry;
  assertConversationTimelineCompactionEntry(entry, {
    conversationId: result.conversationId,
  });
  if (
    entry.entryId !== options.focus.entryId ||
    entry.cursor !== options.focus.cursor
  ) throw new Error('invalid_conversation_message_window_compaction');
  if (focus.nearestPosition === 'none') {
    if (focus.nearestTurnId !== undefined || result.items.length !== 0) {
      throw new Error('invalid_conversation_message_window_compaction');
    }
    return;
  }
  if (
    (focus.nearestPosition !== 'before' && focus.nearestPosition !== 'after') ||
    !isNonEmptyText(focus.nearestTurnId) ||
    !result.items.some(message => message.turnId === focus.nearestTurnId)
  ) throw new Error('invalid_conversation_message_window_compaction');
}

/** Exact standalone compaction-entry validator reused by storage and RPC focus envelopes. */
export function assertConversationTimelineCompactionEntry(
  value: unknown,
  options: { conversationId?: string; maximumPreview?: number } = {},
): asserts value is ConversationTimelineCompactionEntry {
  const page: ConversationTimelinePageSuccess = {
    reset: false,
    items: [],
    revision: 'validation',
    totalMessages: Number.MAX_SAFE_INTEGER,
    totalTurns: Number.MAX_SAFE_INTEGER,
    totalEntries: Number.MAX_SAFE_INTEGER,
    hasMoreBefore: false,
    hasMoreAfter: false,
  };
  assertTimelineEntryShape(
    value,
    page,
    options.maximumPreview ?? MAX_CONVERSATION_TIMELINE_PREVIEW_LENGTH,
  );
  if (
    value.kind !== 'compaction' ||
    (options.conversationId !== undefined && value.conversationId !== options.conversationId)
  ) throw new Error('invalid_conversation_timeline_compaction');
}

function assertWindowMessage(message: ChatMessage, conversationId: string): void {
  try {
    assertCanonicalChatMessageProjection(message, conversationId);
  } catch (error) {
    throw new Error('invalid_conversation_message_window_message', { cause: error });
  }
}

function assertWindowExactKeys(value: object, allowed: readonly string[]): void {
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key))) {
    throw new Error('invalid_conversation_message_window');
  }
}

function assertTimelinePageOptions(options: GetConversationTimelinePageOptions): void {
  if (
    !options ||
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > MAX_CONVERSATION_TIMELINE_PAGE_SIZE
  ) throw new Error('invalid_conversation_timeline_page_limit');
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    options.maxBytes > MAX_CONVERSATION_TIMELINE_PAGE_BYTES
  ) {
    throw new Error('invalid_conversation_timeline_page_byte_budget');
  }
  if (
    options.previewLength !== undefined &&
    (!Number.isSafeInteger(options.previewLength) || options.previewLength < 1)
  ) throw new Error('invalid_conversation_timeline_preview_length');
  const cursors = [options.beforeCursor, options.afterCursor, options.aroundEntryIndex]
    .filter(value => value !== undefined);
  if (cursors.length > 1) throw new Error('conversation_timeline_page_cursor_conflict');
  if (options.beforeCursor !== undefined) assertOpaqueTimelineValue(options.beforeCursor, 'before_cursor');
  if (options.afterCursor !== undefined) assertOpaqueTimelineValue(options.afterCursor, 'after_cursor');
  if (
    (options.beforeCursor !== undefined || options.afterCursor !== undefined) &&
    options.expectedRevision === undefined
  ) throw new Error('conversation_timeline_cursor_requires_revision');
  if (
    options.aroundEntryIndex !== undefined &&
    (!Number.isSafeInteger(options.aroundEntryIndex) || options.aroundEntryIndex < 0)
  ) throw new Error('invalid_conversation_timeline_page_cursor');
  if (options.expectedRevision !== undefined) {
    assertOpaqueTimelineValue(options.expectedRevision, 'expected_revision');
  }
}

function timelinePageRange(
  entries: readonly ConversationTimelineEntry[],
  options: GetConversationTimelinePageOptions,
): { start: number; end: number } | null {
  if (options.beforeCursor !== undefined) {
    const cursorIndex = entries.findIndex(entry => entry.cursor === options.beforeCursor);
    if (cursorIndex < 0) return null;
    return { start: Math.max(0, cursorIndex - options.limit), end: cursorIndex };
  }
  if (options.afterCursor !== undefined) {
    const cursorIndex = entries.findIndex(entry => entry.cursor === options.afterCursor);
    if (cursorIndex < 0) return null;
    const start = cursorIndex + 1;
    return { start, end: Math.min(entries.length, start + options.limit) };
  }
  if (options.aroundEntryIndex !== undefined) {
    const maximumStart = Math.max(0, entries.length - options.limit);
    const start = Math.max(
      0,
      Math.min(options.aroundEntryIndex - Math.floor(options.limit / 2), maximumStart),
    );
    return { start, end: Math.min(entries.length, start + options.limit) };
  }
  return {
    start: Math.max(0, entries.length - options.limit),
    end: entries.length,
  };
}

function timelineSuccessPage(
  items: ConversationTimelineEntry[],
  totalMessages: number,
  totalTurns: number,
  totalEntries: number,
  revision: string,
  requestedRange: { start: number; end: number },
): ConversationTimelinePageSuccess {
  const first = items[0];
  const last = items.at(-1);
  const conceptualStart = first?.entryIndex ?? requestedRange.start;
  const conceptualEnd = last ? last.entryIndex + 1 : requestedRange.end;
  return {
    reset: false,
    items,
    revision,
    totalMessages,
    totalTurns,
    totalEntries,
    hasMoreBefore: conceptualStart > 0,
    hasMoreAfter: conceptualEnd < totalEntries,
    ...(first
      ? { startEntryIndex: first.entryIndex, startCursor: first.cursor }
      : {}),
    ...(last
      ? { endEntryIndex: last.entryIndex, endCursor: last.cursor }
      : {}),
  };
}

function trimTimelineItems(
  items: readonly ConversationTimelineEntry[],
  options: GetConversationTimelinePageOptions,
): ConversationTimelineEntry[] {
  if (options.afterCursor !== undefined) return items.slice(0, -1);
  if (options.aroundEntryIndex !== undefined && items.length > 1) {
    const firstDistance = Math.abs(items[0].entryIndex - options.aroundEntryIndex);
    const lastDistance = Math.abs(items.at(-1)!.entryIndex - options.aroundEntryIndex);
    return firstDistance > lastDistance ? items.slice(1) : items.slice(0, -1);
  }
  return items.slice(1);
}

function boundedTimelineReset(revision: string, maxBytes: number): ConversationTimelinePage {
  const reset = { reset: true as const, revision };
  if (!timelinePageFits(reset, maxBytes)) {
    throw new Error('conversation_timeline_page_exceeds_byte_budget');
  }
  return reset;
}

function timelinePageFits(page: ConversationTimelinePage, maxBytes: number): boolean {
  try {
    canonicalJsonBytes(page, {
      maxBytes,
      maxDepth: 12,
      maxNodes: 10_000,
      maxStringBytes: maxBytes,
      maxStringCodeUnits: maxBytes,
    });
    return true;
  } catch {
    return false;
  }
}

/** Strict storage/wire envelope assertion shared by RPC and persistent hosts. */
export function assertConversationTimelinePageEnvelope(
  value: unknown,
  options: Pick<GetConversationTimelinePageOptions, 'limit' | 'maxBytes' | 'previewLength'>,
): asserts value is ConversationTimelinePage {
  assertTimelinePageOptions({ ...options });
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_conversation_timeline_page');
  }
  const page = value as ConversationTimelinePage;
  if (!timelinePageFits(page, options.maxBytes)) {
    throw new Error('conversation_timeline_page_exceeds_byte_budget');
  }
  if (page.reset) {
    assertExactKeys(page, ['reset', 'revision'], 'reset');
    assertOpaqueTimelineValue(page.revision, 'revision');
    return;
  }
  assertExactKeys(page, [
    'reset',
    'items',
    'revision',
    'totalMessages',
    'totalTurns',
    'totalEntries',
    'hasMoreBefore',
    'hasMoreAfter',
    'startEntryIndex',
    'endEntryIndex',
    'startCursor',
    'endCursor',
  ], 'page');
  if (
    page.reset ||
    !Array.isArray(page.items) ||
    page.items.length > options.limit ||
    !Number.isSafeInteger(page.totalMessages) ||
    page.totalMessages < 0 ||
    !Number.isSafeInteger(page.totalTurns) ||
    page.totalTurns < 0 ||
    !Number.isSafeInteger(page.totalEntries) ||
    page.totalEntries < 0 ||
    page.totalTurns > page.totalMessages ||
    typeof page.hasMoreBefore !== 'boolean' ||
    typeof page.hasMoreAfter !== 'boolean'
  ) throw new Error('invalid_conversation_timeline_page');
  assertOpaqueTimelineValue(page.revision, 'revision');
  const maximumPreview = normalizeTimelinePreviewLength(options.previewLength);
  const cursors = new Set<string>();
  let previousEntryIndex = -1;
  let expectedTurnIndex: number | undefined;
  for (const entry of page.items) {
    assertTimelineEntryShape(entry, page, maximumPreview);
    expectedTurnIndex ??= entry.turnIndex;
    if (
      entry.entryIndex <= previousEntryIndex ||
      (previousEntryIndex >= 0 && entry.entryIndex !== previousEntryIndex + 1) ||
      entry.turnIndex !== expectedTurnIndex ||
      cursors.has(entry.cursor)
    ) throw new Error('invalid_conversation_timeline_entry_order');
    previousEntryIndex = entry.entryIndex;
    cursors.add(entry.cursor);
    if (entry.kind === 'turn') expectedTurnIndex += 1;
  }
  assertTimelineBounds(page);
}

/** Full request-correlated assertion used after a persistent/RPC page read. */
export function assertConversationTimelinePage(
  page: unknown,
  conversationId: string,
  options: GetConversationTimelinePageOptions,
): asserts page is ConversationTimelinePage {
  assertConversationTimelinePageEnvelope(page, options);
  if (page.reset) {
    return;
  }
  if (
    options.expectedRevision !== undefined &&
    page.revision !== options.expectedRevision
  ) throw new Error('conversation_timeline_revision_mismatch');
  for (const entry of page.items) {
    if (entry.conversationId !== conversationId) {
      throw new Error('invalid_conversation_timeline_entry');
    }
  }
  assertTimelineEmptyBoundsForRequest(page, options);
}

function assertTimelineBounds(
  page: ConversationTimelinePageSuccess,
): void {
  const first = page.items[0];
  const last = page.items.at(-1);
  if (
    page.startEntryIndex !== first?.entryIndex ||
    page.endEntryIndex !== last?.entryIndex ||
    page.startCursor !== first?.cursor ||
    page.endCursor !== last?.cursor ||
    (first && page.hasMoreBefore !== (first.entryIndex > 0)) ||
    (last && page.hasMoreAfter !== (last.entryIndex + 1 < page.totalEntries)) ||
    (!first && (
      page.startEntryIndex !== undefined ||
      page.endEntryIndex !== undefined ||
      page.startCursor !== undefined ||
      page.endCursor !== undefined
    ))
  ) throw new Error('invalid_conversation_timeline_page_bounds');
}

function assertTimelineEmptyBoundsForRequest(
  page: ConversationTimelinePageSuccess,
  options: Pick<GetConversationTimelinePageOptions, 'beforeCursor' | 'afterCursor'>,
): void {
  if (page.items.length > 0) return;
  const valid = options.beforeCursor !== undefined
    ? !page.hasMoreBefore && page.hasMoreAfter === (page.totalEntries > 0)
    : options.afterCursor !== undefined
    ? page.hasMoreBefore === (page.totalEntries > 0) && !page.hasMoreAfter
    : page.totalEntries === 0 && !page.hasMoreBefore && !page.hasMoreAfter;
  if (!valid) throw new Error('invalid_conversation_timeline_page_bounds');
}

function assertTimelineEntryShape(
  value: unknown,
  page: ConversationTimelinePageSuccess,
  maximumPreview: number,
): asserts value is ConversationTimelineEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_conversation_timeline_entry');
  }
  const entry = value as ConversationTimelineEntry;
  const common = [
    'kind',
    'entryId',
    'conversationId',
    'timestamp',
    'lamportClock',
    'originNodeId',
    'cursor',
    'entryIndex',
    'turnIndex',
  ] as const;
  if (entry.kind === 'turn') {
    assertExactKeys(entry, [
      ...common,
      'messageId',
      'turnId',
      'userPreview',
      'participantPreviews',
      'responseCount',
    ], 'turn');
  } else if (entry.kind === 'compaction') {
    assertExactKeys(entry, [
      ...common,
      'summaryPreview',
      'compactedMessageCount',
      'compactedTurnCount',
    ], 'compaction');
  } else {
    throw new Error('invalid_conversation_timeline_entry');
  }
  if (
    !isNonEmptyText(entry.conversationId) ||
    !isNonEmptyText(entry.entryId) ||
    !isNonEmptyText(entry.originNodeId) ||
    !Number.isSafeInteger(entry.timestamp) ||
    entry.timestamp < 0 ||
    !Number.isSafeInteger(entry.lamportClock) ||
    entry.lamportClock < 0 ||
    !Number.isSafeInteger(entry.entryIndex) ||
    entry.entryIndex < 0 ||
    entry.entryIndex >= page.totalEntries ||
    !Number.isSafeInteger(entry.turnIndex) ||
    entry.turnIndex < 0 ||
    entry.turnIndex > page.totalTurns
  ) throw new Error('invalid_conversation_timeline_entry');
  assertOpaqueTimelineValue(entry.cursor, 'cursor');
  if (entry.kind === 'turn') {
    if (
      !isNonEmptyText(entry.messageId) ||
      !isNonEmptyText(entry.turnId) ||
      entry.entryId !== entry.messageId ||
      entry.messageId !== entry.turnId ||
      typeof entry.userPreview !== 'string' ||
      entry.userPreview.length > maximumPreview ||
      !Array.isArray(entry.participantPreviews) ||
      entry.participantPreviews.length > MAX_CONVERSATION_TIMELINE_PARTICIPANT_PREVIEWS ||
      !Number.isSafeInteger(entry.responseCount) ||
      entry.responseCount < entry.participantPreviews.length ||
      !participantPreviewsFit(entry.participantPreviews) ||
      !timelineTurnEntryFits(entry)
    ) throw new Error('invalid_conversation_timeline_turn');
    for (const participant of entry.participantPreviews) {
      assertTimelineParticipantPreview(participant);
    }
    return;
  }
  if (
    entry.kind !== 'compaction' ||
    entry.entryId.length === 0 ||
    typeof entry.summaryPreview !== 'string' ||
    entry.summaryPreview.length === 0 ||
    entry.summaryPreview.length > maximumPreview ||
    !Number.isSafeInteger(entry.compactedMessageCount) ||
    entry.compactedMessageCount < 0 ||
    !Number.isSafeInteger(entry.compactedTurnCount) ||
    entry.compactedTurnCount < 0
  ) throw new Error('invalid_conversation_timeline_compaction');
}

function assertExactKeys(
  value: object,
  allowed: readonly string[],
  kind: string,
): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(key => typeof key !== 'string' || !allowed.includes(key)) ||
    allowed.some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && (!descriptor.enumerable || !('value' in descriptor));
    })
  ) throw new Error(`invalid_conversation_timeline_${kind}`);
}

function memoryTimelineCursor(event: ConversationEvent): string {
  return `timeline-v2:${encodeURIComponent(event.originNodeId)}:${event.originSequence}:${encodeURIComponent(event.eventId)}`;
}

function compareTimelineEvents(left: ConversationEvent, right: ConversationEvent): number {
  return left.timestamp - right.timestamp ||
    left.lamportClock - right.lamportClock ||
    compareUtf8Text(left.originNodeId, right.originNodeId) ||
    compareUtf8Text(left.eventId, right.eventId);
}

function assertOpaqueTimelineValue(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2_048 ||
    value !== value.trim() ||
    hasAsciiControlToken(value)
  ) throw new Error(`invalid_conversation_timeline_${field}`);
}

function hasAsciiControlToken(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
