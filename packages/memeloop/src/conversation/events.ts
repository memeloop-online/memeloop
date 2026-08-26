import { canonicalJsonBytes, CanonicalJsonError } from '../encoding/canonicalJson.js';
import { type ContextCompactionBoundaryV2, isContextCompactionBoundaryV2 } from './compactionBoundary.js';
import type { AttachmentReference, ChatMessage, ChatMessagePart, ChatRole, DetailReference, ToolCall } from './types.js';

/** 15 MiB leaves one MiB for sync/RPC framing under the 16 MiB frame ceiling. */
export const MAX_CONVERSATION_EVENT_BYTES = 15 * 1024 * 1024;
const MAX_CONVERSATION_EVENT_NODES = 200_000;

/** Frozen wire/storage limits shared by every canonical event ingress. */
export const CONVERSATION_EVENT_LIMITS = Object.freeze(
  {
    identifierBytes: 512,
    referenceBytes: 2_048,
    sourceStringBytes: 512,
    titleBytes: 64 * 1_024,
    textBytes: 8 * 1_024 * 1_024,
    metadataStringBytes: 1 * 1_024 * 1_024,
    metadataKeyBytes: 512,
    metadataDepth: 16,
    metadataKeysPerObject: 256,
    metadataArrayItems: 4_096,
    messageParts: 2_048,
    toolCalls: 256,
    attachments: 256,
    compactionOrigins: 4_096,
    filenameBytes: 1_024,
    mimeTypeBytes: 256,
    attachmentBytes: 64 * 1_024 * 1_024,
  } as const,
);

const ATTACHMENT_CONTENT_HASH_PATTERN = /^sha256:[\da-f]{64}$/;
const MIME_TYPE_PATTERN = /^[!#$%&'*+.^_`|~\dA-Za-z-]+\/[!#$%&'*+.^_`|~\dA-Za-z-]+$/;
const utf8Encoder = new TextEncoder();

export interface ConversationEventBase {
  eventId: string;
  conversationId: string;
  originNodeId: string;
  /** Contiguous, atomically allocated in the conversation+origin domain. */
  originSequence: number;
  lamportClock: number;
  timestamp: number;
}

export interface ConversationMessagePayload {
  messageId: string;
  turnId: string;
  role: ChatRole;
  content: string;
  parts?: ChatMessagePart[];
  toolCalls?: ToolCall[];
  attachments?: ChatMessage['attachments'];
  detailRef?: DetailReference;
  reasoning_content?: string;
  contentType?: string;
  hidden?: boolean;
  duration?: number | null;
  metadata?: Record<string, unknown>;
}

export interface ConversationMessageEvent extends ConversationEventBase {
  kind: 'message';
  message: ConversationMessagePayload;
}

export interface ConversationTombstoneEvent extends ConversationEventBase {
  kind: 'tombstone';
  targetTurnId: string;
  reason?: 'user-delete' | 'retention' | 'redaction';
  digest?: string;
}

export interface ConversationCompactionSummaryEvent extends ConversationEventBase {
  kind: 'compaction';
  mode: 'summary';
  boundary: ContextCompactionBoundaryV2;
  summary: {
    turnId: string;
    content: string;
    parts?: Array<Exclude<ChatMessagePart, { type: 'attachment' }>>;
  };
}

/** Causal coverage checkpoint with no semantic text or ChatMessage projection. */
export interface ConversationCompactionCoverageEvent extends ConversationEventBase {
  kind: 'compaction';
  mode: 'coverage-only';
  boundary: ContextCompactionBoundaryV2;
  summary: null;
}

export type ConversationCompactionEvent =
  | ConversationCompactionSummaryEvent
  | ConversationCompactionCoverageEvent;

export interface ConversationMetadataPatchFields {
  title?: string;
  definitionId?: string;
  instanceDelta?: Record<string, unknown>;
  isUserInitiated?: boolean;
  sourceChannel?: {
    channelId: string;
    platform: string;
    imUserId: string;
  } | null;
}

export interface ConversationMetadataPatchEvent extends ConversationEventBase {
  kind: 'metadataPatch';
  patch: ConversationMetadataPatchFields;
}

export type ConversationEvent =
  | ConversationMessageEvent
  | ConversationTombstoneEvent
  | ConversationCompactionEvent
  | ConversationMetadataPatchEvent;

type WithoutAssignedIdentity<Event extends ConversationEvent> = Omit<
  Event,
  'originSequence' | 'lamportClock'
>;

export type ConversationEventDraft = ConversationEvent extends infer Event ? Event extends ConversationEvent ? WithoutAssignedIdentity<Event>
  : never
  : never;

export interface ConversationEventCursor {
  originNodeId: string;
  originSequence: number;
  eventId: string;
}

export function conversationEventToMessage(event: ConversationMessageEvent): ChatMessage {
  return {
    ...event.message,
    conversationId: event.conversationId,
    originNodeId: event.originNodeId,
    originSequence: event.originSequence,
    lamportClock: event.lamportClock,
    timestamp: event.timestamp,
  };
}

export function messageToConversationEvent(message: ChatMessage): ConversationMessageEvent {
  const {
    messageId,
    turnId,
    conversationId,
    originNodeId,
    originSequence,
    lamportClock,
    timestamp,
    ...payload
  } = message;
  return {
    eventId: messageId,
    conversationId,
    originNodeId,
    originSequence,
    lamportClock,
    timestamp,
    kind: 'message',
    message: { messageId, turnId, ...payload },
  };
}

/** Strict shared validator for message projections returned by storage/RPC hosts. */
export function assertCanonicalChatMessageProjection(
  value: unknown,
  conversationId?: string,
): asserts value is ChatMessage {
  try {
    canonicalJsonBytes(value, {
      maxDepth: 64,
      maxNodes: MAX_CONVERSATION_EVENT_NODES,
      maxStringCodeUnits: MAX_CONVERSATION_EVENT_BYTES,
      maxStringBytes: MAX_CONVERSATION_EVENT_BYTES,
      maxBytes: MAX_CONVERSATION_EVENT_BYTES,
    });
    const event = normalizeCanonicalConversationEvent(messageToConversationEvent(value as ChatMessage));
    if (
      event.kind !== 'message' ||
      (conversationId !== undefined && event.conversationId !== conversationId)
    ) {
      throw new Error('invalid canonical chat message projection scope');
    }
  } catch (error) {
    throw new Error('invalid canonical chat message projection', { cause: error });
  }
}

/** Binary bodies are referenced only by message events, never control events. */
export function conversationEventAttachmentReferences(
  event: ConversationEvent,
): AttachmentReference[] {
  if (event.kind !== 'message') return [];
  const references = new Map<string, AttachmentReference>();
  for (const reference of event.message.attachments ?? []) {
    references.set(reference.contentHash, reference);
  }
  for (const part of event.message.parts ?? []) {
    if (part.type === 'attachment') {
      references.set(part.attachment.contentHash, part.attachment);
    }
  }
  return [...references.values()];
}

export function isConversationEvent(value: unknown): value is ConversationEvent {
  if (!isEventBase(value)) return false;
  const event = value as ConversationEvent & Record<string, unknown>;
  switch (event.kind) {
    case 'message':
      return hasOnlyKeys(event, [...eventBaseKeys, 'kind', 'message']) &&
        isMessagePayload(event.message) && event.eventId === event.message.messageId;
    case 'tombstone':
      return hasOnlyKeys(event, [...eventBaseKeys, 'kind', 'targetTurnId', 'reason', 'digest']) &&
        isIdentifier(event.targetTurnId) &&
        (event.reason === undefined ||
          event.reason === 'user-delete' || event.reason === 'retention' || event.reason === 'redaction') &&
        (event.digest === undefined || isBoundedSourceString(event.digest, true));
    case 'compaction':
      return hasOnlyKeys(event, [...eventBaseKeys, 'kind', 'mode', 'boundary', 'summary']) &&
        isContextCompactionBoundaryV2(event.boundary) &&
        isCompactionBoundaryWithinEventLimits(event.boundary) &&
        (event.mode === 'coverage-only' && event.summary === null ||
          event.mode === 'summary' && isCompactionSummary(event.summary));
    case 'metadataPatch':
      return hasOnlyKeys(event, [...eventBaseKeys, 'kind', 'patch']) &&
        isMetadataPatch(event.patch);
    default:
      return false;
  }
}

/**
 * Validate the exact event schema and its deep JSON graph before a storage or
 * sync boundary. Known optional schema fields explicitly set to `undefined`
 * are normalized as absent; arbitrary metadata/tool arguments remain strict.
 */
export function assertCanonicalConversationEvent(
  value: unknown,
): asserts value is ConversationEvent {
  normalizeCanonicalConversationEvent(value);
}

/**
 * Return the exact schema-normalized event that must cross a storage boundary.
 * Callers must persist/project/return this value rather than the pre-validation
 * input so known optional `undefined` fields cannot diverge across hosts.
 */
export function normalizeCanonicalConversationEvent(value: unknown): ConversationEvent {
  let normalized: unknown;
  try {
    normalized = normalizeKnownOptionalEventFields(value);
    canonicalJsonBytes(normalized, {
      maxDepth: 64,
      maxNodes: MAX_CONVERSATION_EVENT_NODES,
      maxStringCodeUnits: MAX_CONVERSATION_EVENT_BYTES,
      maxStringBytes: MAX_CONVERSATION_EVENT_BYTES,
      maxBytes: MAX_CONVERSATION_EVENT_BYTES,
    });
  } catch (error) {
    throw new Error('invalid canonical conversation event', { cause: error });
  }
  if (!isConversationEvent(normalized)) {
    throw new Error('invalid canonical conversation event schema');
  }
  return normalized;
}

/** Validate an entire remote/local batch before the caller starts a transaction. */
export function assertCanonicalConversationEvents(
  values: readonly unknown[],
): asserts values is readonly ConversationEvent[] {
  for (const value of values) assertCanonicalConversationEvent(value);
}

/** Normalize a complete batch before any member is projected or persisted. */
export function normalizeCanonicalConversationEvents(
  values: readonly unknown[],
): ConversationEvent[] {
  return values.map(value => normalizeCanonicalConversationEvent(value));
}

/**
 * Validate a local draft before opening a write transaction or allocating a
 * causal sequence. Worst-case safe-integer coordinates reserve enough bytes
 * for every value the allocator may assign later.
 */
export function assertCanonicalConversationEventDraft(
  value: unknown,
): asserts value is ConversationEventDraft {
  const normalized = normalizeKnownOptionalEventFields(value);
  if (
    !isPlainObject(normalized) ||
    Object.hasOwn(normalized, 'originSequence') ||
    Object.hasOwn(normalized, 'lamportClock')
  ) {
    throw new Error('invalid canonical conversation event draft schema');
  }
  const candidate = Object.assign(Object.create(null) as Record<string, unknown>, normalized, {
    originSequence: Number.MAX_SAFE_INTEGER,
    lamportClock: Number.MAX_SAFE_INTEGER,
  });
  assertCanonicalConversationEvent(candidate);
}

export function assertCanonicalConversationEventDrafts(
  values: readonly unknown[],
): asserts values is readonly ConversationEventDraft[] {
  for (const value of values) assertCanonicalConversationEventDraft(value);
}

/** Canonical conflict/digest bytes using the same normalization as the boundary validator. */
export function canonicalConversationEventBytes(value: unknown): Uint8Array {
  const normalized = normalizeCanonicalConversationEvent(value);
  return canonicalJsonBytes(normalized, {
    maxDepth: 64,
    maxNodes: MAX_CONVERSATION_EVENT_NODES,
    maxStringCodeUnits: MAX_CONVERSATION_EVENT_BYTES,
    maxStringBytes: MAX_CONVERSATION_EVENT_BYTES,
    maxBytes: MAX_CONVERSATION_EVENT_BYTES,
  });
}

function isEventBase(value: unknown): value is ConversationEventBase & { kind: unknown } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<ConversationEventBase> & { kind?: unknown };
  return isIdentifier(event.eventId) &&
    isIdentifier(event.conversationId) &&
    isIdentifier(event.originNodeId) &&
    typeof event.originSequence === 'number' && Number.isSafeInteger(event.originSequence) &&
    event.originSequence > 0 && typeof event.lamportClock === 'number' &&
    Number.isSafeInteger(event.lamportClock) && event.lamportClock > 0 &&
    typeof event.timestamp === 'number' &&
    Number.isSafeInteger(event.timestamp) && event.timestamp >= 0 && typeof event.kind === 'string';
}

function normalizeKnownOptionalEventFields(value: unknown): unknown {
  const event = copyOptionalRecord(value, eventOptionalFields(value));
  if (!isPlainObject(event)) return event;
  if (event.kind === 'message') {
    event.message = normalizeMessagePayload(event.message);
  } else if (event.kind === 'compaction') {
    if (event.mode === 'summary') event.summary = normalizeCompactionSummary(event.summary);
  } else if (event.kind === 'metadataPatch') {
    event.patch = normalizeMetadataPatch(event.patch);
  }
  return event;
}

function eventOptionalFields(value: unknown): ReadonlySet<string> {
  const kind = safeDataProperty(value, 'kind');
  return kind === 'tombstone' ? new Set(['reason', 'digest']) : new Set();
}

function normalizeMessagePayload(value: unknown): unknown {
  const message = copyOptionalRecord(
    value,
    new Set([
      'parts',
      'toolCalls',
      'attachments',
      'detailRef',
      'reasoning_content',
      'contentType',
      'hidden',
      'duration',
      'metadata',
    ]),
  );
  if (!isPlainObject(message)) return message;
  if (message.parts !== undefined) {
    message.parts = normalizeArray(message.parts, normalizeMessagePartOptionals);
  }
  if (message.detailRef !== undefined) {
    message.detailRef = normalizeDetailReference(message.detailRef);
  }
  return message;
}

function normalizeMessagePartOptionals(value: unknown): unknown {
  const type = safeDataProperty(value, 'type');
  if (type !== 'tool-result') return copyOptionalRecord(value, new Set());
  const part = copyOptionalRecord(
    value,
    new Set([
      'toolCallId',
      'parameters',
      'isError',
      'payload',
      'detailRef',
    ]),
  );
  if (isPlainObject(part) && part.detailRef !== undefined) {
    part.detailRef = normalizeDetailReference(part.detailRef);
  }
  return part;
}

function normalizeDetailReference(value: unknown): unknown {
  return copyOptionalRecord(
    value,
    new Set([
      'runId',
      'conversationId',
      'sessionId',
      'nodeId',
      'fileUri',
      'exitCode',
      'resourceVersion',
    ]),
  );
}

function normalizeCompactionSummary(value: unknown): unknown {
  const summary = copyOptionalRecord(value, new Set(['parts']));
  if (isPlainObject(summary) && summary.parts !== undefined) {
    summary.parts = normalizeArray(summary.parts, normalizeMessagePartOptionals);
  }
  return summary;
}

function normalizeMetadataPatch(value: unknown): unknown {
  return copyOptionalRecord(
    value,
    new Set([
      'title',
      'definitionId',
      'instanceDelta',
      'isUserInitiated',
      'sourceChannel',
    ]),
  );
}

function copyOptionalRecord(value: unknown, optional: ReadonlySet<string>): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  let prototype: object | null;
  let keys: Array<string | symbol>;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    keys = Reflect.ownKeys(value);
  } catch (error) {
    throw new CanonicalJsonError('non_plain_object', error);
  }
  if (prototype !== Object.prototype && prototype !== null) return value;
  if (keys.length > MAX_CONVERSATION_EVENT_NODES) {
    throw new CanonicalJsonError('max_nodes');
  }
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key === 'symbol') throw new CanonicalJsonError('symbol_property');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) throw new CanonicalJsonError('non_plain_object');
    if ('get' in descriptor || 'set' in descriptor) {
      throw new CanonicalJsonError('accessor_property');
    }
    if (!descriptor.enumerable) throw new CanonicalJsonError('non_enumerable_property');
    if (optional.has(key) && descriptor.value === undefined) continue;
    copy[key] = descriptor.value;
  }
  return copy;
}

function normalizeArray(
  value: unknown,
  normalizeItem: (item: unknown) => unknown,
): unknown {
  if (!Array.isArray(value)) return value;
  if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_CONVERSATION_EVENT_NODES) {
    return value;
  }
  const normalized: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || 'get' in descriptor || 'set' in descriptor) {
      throw new CanonicalJsonError(descriptor ? 'accessor_property' : 'sparse_array');
    }
    normalized.push(normalizeItem(descriptor.value));
  }
  return normalized;
}

function safeDataProperty(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || 'get' in descriptor || 'set' in descriptor) return undefined;
  return descriptor.value;
}

function isMessagePayload(value: unknown): value is ConversationMessagePayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Partial<ConversationMessagePayload> & Record<string, unknown>;
  if (!hasOnlyKeys(message, messagePayloadKeys)) return false;
  return isIdentifier(message.messageId) &&
    isIdentifier(message.turnId) &&
    (message.role !== 'user' || message.messageId === message.turnId) &&
    (message.role === 'user' || message.role === 'assistant' || message.role === 'tool' ||
      message.role === 'agent' || message.role === 'error') &&
    isBoundedText(message.content, CONVERSATION_EVENT_LIMITS.textBytes, true) &&
    (message.parts === undefined || Array.isArray(message.parts) &&
        message.parts.length <= CONVERSATION_EVENT_LIMITS.messageParts &&
        message.parts.every(isMessagePart)) &&
    (message.toolCalls === undefined || Array.isArray(message.toolCalls) &&
        message.toolCalls.length <= CONVERSATION_EVENT_LIMITS.toolCalls &&
        message.toolCalls.every(isToolCall)) &&
    (message.attachments === undefined || Array.isArray(message.attachments) &&
        message.attachments.length <= CONVERSATION_EVENT_LIMITS.attachments &&
        message.attachments.every(isAttachmentReference)) &&
    (message.detailRef === undefined || isDetailReference(message.detailRef)) &&
    (message.reasoning_content === undefined ||
      isBoundedText(message.reasoning_content, CONVERSATION_EVENT_LIMITS.textBytes, true)) &&
    (message.contentType === undefined || isBoundedSourceString(message.contentType, false)) &&
    (message.hidden === undefined || typeof message.hidden === 'boolean') &&
    (message.duration === undefined || message.duration === null ||
      typeof message.duration === 'number' && Number.isSafeInteger(message.duration) &&
        message.duration >= 0) &&
    (message.metadata === undefined || isBoundedJsonRecord(message.metadata));
}

function isCompactionSummary(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const summary = value as Record<string, unknown>;
  return hasOnlyKeys(summary, ['turnId', 'content', 'parts']) &&
    isIdentifier(summary.turnId) &&
    isBoundedText(summary.content, CONVERSATION_EVENT_LIMITS.textBytes, true) &&
    (summary.parts === undefined || Array.isArray(summary.parts) &&
        summary.parts.length <= CONVERSATION_EVENT_LIMITS.messageParts &&
        summary.parts.every(part => isMessagePart(part) && part.type !== 'attachment'));
}

function isMetadataPatch(value: unknown): value is ConversationMetadataPatchFields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const patch = value as Record<string, unknown>;
  const allowed = new Set(['title', 'definitionId', 'instanceDelta', 'isUserInitiated', 'sourceChannel']);
  if (Object.keys(patch).length === 0 || Object.keys(patch).some(key => !allowed.has(key))) return false;
  if (
    patch.title !== undefined &&
    !isBoundedText(patch.title, CONVERSATION_EVENT_LIMITS.titleBytes, true)
  ) return false;
  if (patch.definitionId !== undefined && !isIdentifier(patch.definitionId)) return false;
  if (patch.instanceDelta !== undefined && !isBoundedJsonRecord(patch.instanceDelta)) return false;
  if (patch.isUserInitiated !== undefined && typeof patch.isUserInitiated !== 'boolean') return false;
  if (patch.sourceChannel !== undefined && patch.sourceChannel !== null) {
    if (!isPlainObject(patch.sourceChannel)) return false;
    const source = patch.sourceChannel;
    if (
      !hasOnlyKeys(source, ['channelId', 'platform', 'imUserId']) ||
      !isBoundedSourceString(source.channelId, false) ||
      !isBoundedSourceString(source.platform, false) ||
      !isBoundedSourceString(source.imUserId, false)
    ) return false;
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

const eventBaseKeys = [
  'eventId',
  'conversationId',
  'originNodeId',
  'originSequence',
  'lamportClock',
  'timestamp',
] as const;

const messagePayloadKeys = [
  'messageId',
  'turnId',
  'role',
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
] as const;

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every(key => keys.has(key));
}

function isAttachmentReference(value: unknown): boolean {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['contentHash', 'filename', 'mimeType', 'size'])) {
    return false;
  }
  return typeof value.contentHash === 'string' &&
    ATTACHMENT_CONTENT_HASH_PATTERN.test(value.contentHash) &&
    isSafeFilename(value.filename) && isSafeMimeType(value.mimeType) &&
    typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0 &&
    value.size <= CONVERSATION_EVENT_LIMITS.attachmentBytes;
}

function isToolCall(value: unknown): boolean {
  return isPlainObject(value) && hasOnlyKeys(value, ['id', 'toolName', 'arguments']) &&
    isIdentifier(value.id) && isToolName(value.toolName) &&
    Object.hasOwn(value, 'arguments') && isBoundedJsonFragment(value.arguments);
}

function isDetailReference(value: unknown): boolean {
  if (
    !isPlainObject(value) || !hasOnlyKeys(value, [
      'type',
      'runId',
      'conversationId',
      'sessionId',
      'nodeId',
      'fileUri',
      'exitCode',
      'resourceVersion',
    ])
  ) return false;
  if (value.type !== 'agent-run' && value.type !== 'terminal-session' && value.type !== 'file') {
    return false;
  }
  if (
    !['runId', 'conversationId', 'sessionId', 'nodeId', 'resourceVersion']
      .every(key => value[key] === undefined || isIdentifier(value[key])) ||
    value.fileUri !== undefined &&
      !isBoundedText(value.fileUri, CONVERSATION_EVENT_LIMITS.referenceBytes, false)
  ) return false;
  if (
    value.exitCode !== undefined &&
    (typeof value.exitCode !== 'number' || !Number.isSafeInteger(value.exitCode))
  ) return false;
  if (value.type === 'agent-run') {
    return value.runId !== undefined || value.conversationId !== undefined;
  }
  if (value.type === 'terminal-session') return value.sessionId !== undefined;
  return value.fileUri !== undefined;
}

function isMessagePart(value: unknown): value is ChatMessagePart {
  if (!isPlainObject(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'text':
    case 'reasoning':
      return hasOnlyKeys(value, ['type', 'text']) &&
        isBoundedText(value.text, CONVERSATION_EVENT_LIMITS.textBytes, true);
    case 'tool-call':
      return hasOnlyKeys(value, ['type', 'toolCallId', 'toolName', 'arguments']) &&
        isIdentifier(value.toolCallId) && isToolName(value.toolName) &&
        Object.hasOwn(value, 'arguments') && isBoundedJsonFragment(value.arguments);
    case 'attachment':
      return hasOnlyKeys(value, ['type', 'attachment']) && isAttachmentReference(value.attachment);
    case 'tool-result':
      return hasOnlyKeys(value, [
        'type',
        'toolCallId',
        'toolName',
        'parameters',
        'result',
        'isError',
        'payload',
        'detailRef',
      ]) && (value.toolCallId === undefined || isIdentifier(value.toolCallId)) &&
        isToolName(value.toolName) &&
        isBoundedText(value.result, CONVERSATION_EVENT_LIMITS.textBytes, true) &&
        (value.parameters === undefined || isBoundedJsonFragment(value.parameters)) &&
        (value.isError === undefined || typeof value.isError === 'boolean') &&
        (value.payload === undefined || isBoundedJsonFragment(value.payload)) &&
        (value.detailRef === undefined || isDetailReference(value.detailRef));
    default:
      return false;
  }
}

function isCompactionBoundaryWithinEventLimits(boundary: ContextCompactionBoundaryV2): boolean {
  const maps = [
    boundary.coveredVersion,
    boundary.coveredMessageCountByOrigin,
    boundary.coveredUserTurnCountByOrigin,
  ];
  if (maps.some(map => Object.keys(map).length > CONVERSATION_EVENT_LIMITS.compactionOrigins)) {
    return false;
  }
  if (maps.some(map => Object.keys(map).some(key => !isIdentifier(key)))) return false;
  return boundary.previousSummaryMessageIds?.every(isIdentifier) ?? true;
}

function isIdentifier(value: unknown): value is string {
  return isBoundedText(value, CONVERSATION_EVENT_LIMITS.identifierBytes, false) &&
    !hasAsciiControl(value);
}

function isToolName(value: unknown): value is string {
  return isBoundedText(value, CONVERSATION_EVENT_LIMITS.sourceStringBytes, false) &&
    !hasAsciiControl(value);
}

function isBoundedSourceString(value: unknown, allowEmpty: boolean): value is string {
  return isBoundedText(value, CONVERSATION_EVENT_LIMITS.sourceStringBytes, allowEmpty) &&
    !hasAsciiControl(value);
}

function isBoundedText(value: unknown, maxBytes: number, allowEmpty: boolean): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) &&
    utf8Encoder.encode(value).byteLength <= maxBytes;
}

function isSafeFilename(value: unknown): value is string {
  return isBoundedText(value, CONVERSATION_EVENT_LIMITS.filenameBytes, false) &&
    value !== '.' && value !== '..' && !hasAsciiControl(value) &&
    !value.includes('/') && !value.includes('\\');
}

function isSafeMimeType(value: unknown): value is string {
  return isBoundedText(value, CONVERSATION_EVENT_LIMITS.mimeTypeBytes, false) &&
    MIME_TYPE_PATTERN.test(value);
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x20 || codeUnit === 0x7f) return true;
  }
  return false;
}

interface JsonFragmentValidationState {
  active: WeakSet<object>;
  nodes: number;
}

function isBoundedJsonRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && isBoundedJsonFragment(value);
}

function isBoundedJsonFragment(
  value: unknown,
  depth = 0,
  state: JsonFragmentValidationState = { active: new WeakSet(), nodes: 0 },
): boolean {
  state.nodes += 1;
  if (state.nodes > MAX_CONVERSATION_EVENT_NODES || depth > CONVERSATION_EVENT_LIMITS.metadataDepth) {
    return false;
  }
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') {
    return isBoundedText(value, CONVERSATION_EVENT_LIMITS.metadataStringBytes, true);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  }
  if (typeof value !== 'object') return false;
  if (state.active.has(value)) return false;
  state.active.add(value);
  let valid = false;
  if (Array.isArray(value)) {
    valid = Object.getPrototypeOf(value) === Array.prototype &&
      value.length <= CONVERSATION_EVENT_LIMITS.metadataArrayItems &&
      value.every(item => isBoundedJsonFragment(item, depth + 1, state));
  } else if (isPlainObject(value)) {
    const keys = Reflect.ownKeys(value);
    valid = keys.length <= CONVERSATION_EVENT_LIMITS.metadataKeysPerObject && keys.every(key => {
      if (
        typeof key !== 'string' ||
        !isBoundedText(key, CONVERSATION_EVENT_LIMITS.metadataKeyBytes, false)
      ) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable &&
        !('get' in descriptor) && !('set' in descriptor) &&
        isBoundedJsonFragment(descriptor.value, depth + 1, state);
    });
  }
  state.active.delete(value);
  return valid;
}
