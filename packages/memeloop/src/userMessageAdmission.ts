import {
  assertCanonicalChatMessageProjection,
  canonicalConversationEventBytes,
  type ChatMessage,
  conversationEventToMessage,
  type ConversationMessagePayload,
  MAX_CONVERSATION_EVENT_BYTES,
  messageToConversationEvent,
  normalizeCanonicalConversationEvent,
} from './conversation/index.js';
import { canonicalJsonBytes } from './encoding/canonicalJson.js';
import { AGENT_RUN_ERROR_MESSAGE_KEYS, AgentRunFailure, createAgentRunError } from './runState.js';

/**
 * One user root must fit an ordinary 256 KiB message page including its page
 * envelope. Larger bodies belong in attachment/detail storage and are linked
 * from the bounded root event.
 */
export const CONVERSATION_MESSAGE_ADMISSION_LIMITS = Object.freeze(
  {
    canonicalMessageBytes: 248 * 1024,
    canonicalEventBytes: 252 * 1024,
    pagingEnvelopeBytes: 256 * 1024,
  } as const,
);

export const AGENT_USER_MESSAGE_LIMITS = Object.freeze(
  {
    contentBytes: 240 * 1024,
    ...CONVERSATION_MESSAGE_ADMISSION_LIMITS,
  } as const,
);

export type AgentUserMessageLimitKind = 'content' | 'canonical-message' | 'canonical-event';

export class AgentUserMessageLimitError extends AgentRunFailure {
  public readonly kind: AgentUserMessageLimitKind;
  public readonly requestedBytes: number;
  public readonly limitBytes: number;

  public constructor(kind: AgentUserMessageLimitKind, requestedBytes: number, limitBytes: number) {
    super(createAgentRunError({
      code: 'USER_MESSAGE_TOO_LARGE',
      messageKey: AGENT_RUN_ERROR_MESSAGE_KEYS.USER_MESSAGE_TOO_LARGE,
      retryable: false,
      localizedParams: { requested: requestedBytes, limit: limitBytes },
    }));
    this.name = 'AgentUserMessageLimitError';
    this.kind = kind;
    this.requestedBytes = requestedBytes;
    this.limitBytes = limitBytes;
  }
}

export function assertAgentUserMessageContentWithinLimits(content: unknown): asserts content is string {
  if (typeof content !== 'string') throw new Error('invalid agent user message content');
  const contentBytes = new TextEncoder().encode(content).byteLength;
  if (contentBytes > AGENT_USER_MESSAGE_LIMITS.contentBytes) {
    throw new AgentUserMessageLimitError(
      'content',
      contentBytes,
      AGENT_USER_MESSAGE_LIMITS.contentBytes,
    );
  }
}

export function assertPendingAgentUserMessageWithinLimits(input: {
  readonly conversationId: string;
  readonly originNodeId: string;
  readonly timestamp: number;
  readonly message: ConversationMessagePayload;
}): void {
  normalizeAgentUserMessageForAdmission({
    ...input.message,
    conversationId: input.conversationId,
    originNodeId: input.originNodeId,
    // Allocate against the largest legal coordinate representation. The
    // eventual durable event can only be equal or smaller.
    originSequence: Number.MAX_SAFE_INTEGER,
    lamportClock: Number.MAX_SAFE_INTEGER,
    timestamp: input.timestamp,
  });
}

export function assertPendingConversationMessageWithinLimits(input: {
  readonly conversationId: string;
  readonly originNodeId: string;
  readonly timestamp: number;
  readonly message: ConversationMessagePayload;
}): void {
  const candidate = {
    ...input.message,
    conversationId: input.conversationId,
    originNodeId: input.originNodeId,
    originSequence: Number.MAX_SAFE_INTEGER,
    lamportClock: Number.MAX_SAFE_INTEGER,
    timestamp: input.timestamp,
  };
  if (input.message.role === 'user') normalizeAgentUserMessageForAdmission(candidate);
  else normalizeConversationMessageForPagingAdmission(candidate);
}

/**
 * Normalize a locally generated assistant/tool payload before persistence.
 * Exact legacy/parts duplicates are removed first. If genuinely oversized,
 * a bounded Unicode-safe durable projection is stored with an explicit loss
 * marker; untrusted synced messages never use this projector.
 */
export function normalizeGeneratedConversationMessageForAdmission(input: {
  readonly conversationId: string;
  readonly originNodeId: string;
  readonly timestamp: number;
  readonly message: ConversationMessagePayload;
}): ConversationMessagePayload {
  if (input.message.role === 'user') {
    assertPendingAgentUserMessageWithinLimits(input);
    return input.message;
  }
  const deduplicated = compactRedundantMessagePartsForPersistence(input.message);
  try {
    assertPendingConversationMessageWithinLimits({ ...input, message: deduplicated });
    return deduplicated;
  } catch (error) {
    if (!(error instanceof AgentUserMessageLimitError)) throw error;
  }

  const originalContentBytes = new TextEncoder().encode(deduplicated.content).byteLength;
  const structuredParts = (deduplicated.parts ?? []).filter(
    part => part.type !== 'text' && part.type !== 'reasoning',
  );
  const metadataVariants = projectedMetadataVariants(deduplicated.metadata);
  const maximumItemVariants = structuredParts.length > 0 || (deduplicated.toolCalls?.length ?? 0) > 0
    ? [2, 1]
    : [0];
  for (const maximumStructuredItems of maximumItemVariants) {
    const projectedParts = sampleEdges(structuredParts, maximumStructuredItems).map(part => {
      if (part.type !== 'tool-result') return part;
      return {
        type: 'tool-result' as const,
        ...(part.toolCallId === undefined ? {} : { toolCallId: part.toolCallId }),
        toolName: part.toolName,
        result: truncateUtf8(part.result, 24 * 1024),
        isError: part.isError,
        ...(part.detailRef === undefined ? {} : { detailRef: part.detailRef }),
      };
    });
    const projectedToolCalls = sampleEdges(
      deduplicated.toolCalls ?? [],
      maximumStructuredItems,
    );
    for (const metadataVariant of metadataVariants) {
      const projected: ConversationMessagePayload = {
        messageId: deduplicated.messageId,
        turnId: deduplicated.turnId,
        role: deduplicated.role,
        content: truncateUtf8(deduplicated.content, 48 * 1024),
        ...(projectedParts.length === 0 ? {} : { parts: projectedParts }),
        ...(projectedToolCalls.length === 0 ? {} : { toolCalls: projectedToolCalls }),
        ...(deduplicated.reasoning_content === undefined
          ? {}
          : { reasoning_content: truncateUtf8(deduplicated.reasoning_content, 12 * 1024) }),
        ...(deduplicated.attachments === undefined
          ? {}
          : { attachments: deduplicated.attachments.slice(0, 32) }),
        ...(deduplicated.detailRef === undefined ? {} : { detailRef: deduplicated.detailRef }),
        ...(deduplicated.contentType === undefined ? {} : { contentType: deduplicated.contentType }),
        metadata: {
          ...metadataVariant.value,
          durableProjection: {
            version: 1,
            originalContentBytes,
            contentTruncated: originalContentBytes > 48 * 1024,
            omittedStructuredParts: Math.max(0, structuredParts.length - projectedParts.length),
            omittedToolCalls: Math.max(
              0,
              (deduplicated.toolCalls?.length ?? 0) - projectedToolCalls.length,
            ),
            ...(metadataVariant.omitted ? { omittedMetadata: true } : {}),
            capability: 'not-retained',
          },
        },
      };
      try {
        assertPendingConversationMessageWithinLimits({ ...input, message: projected });
        return projected;
      } catch (error) {
        if (!(error instanceof AgentUserMessageLimitError)) throw error;
      }
    }
  }
  throw new AgentUserMessageLimitError(
    'canonical-message',
    CONVERSATION_MESSAGE_ADMISSION_LIMITS.canonicalMessageBytes + 1,
    CONVERSATION_MESSAGE_ADMISSION_LIMITS.canonicalMessageBytes,
  );
}

export function compactRedundantMessagePartsForPersistence(
  message: ConversationMessagePayload,
): ConversationMessagePayload {
  if (message.parts === undefined) return message;
  const matchingToolCalls = new Map(
    (message.toolCalls ?? []).map(call => [call.id, call]),
  );
  const matchingAttachments = new Map(
    (message.attachments ?? []).map(attachment => [attachment.contentHash, attachment]),
  );
  const parts = message.parts.filter(part =>
    !(part.type === 'text' && part.text === message.content) &&
    !(part.type === 'reasoning' && part.text === message.reasoning_content) &&
    !(part.type === 'tool-call' && (() => {
      const legacy = matchingToolCalls.get(part.toolCallId);
      return legacy !== undefined && legacy.toolName === part.toolName &&
        canonicalValuesEqual(legacy.arguments, part.arguments);
    })()) &&
    !(part.type === 'attachment' && (() => {
      const legacy = matchingAttachments.get(part.attachment.contentHash);
      return legacy !== undefined && canonicalValuesEqual(legacy, part.attachment);
    })())
  );
  const { parts: _parts, ...withoutParts } = message;
  return parts.length === 0 ? withoutParts : { ...withoutParts, parts };
}

function canonicalValuesEqual(left: unknown, right: unknown): boolean {
  try {
    const leftBytes = canonicalJsonBytes(left, {
      maxBytes: CONVERSATION_MESSAGE_ADMISSION_LIMITS.pagingEnvelopeBytes,
      maxDepth: 32,
      maxNodes: 4_096,
      maxStringBytes: CONVERSATION_MESSAGE_ADMISSION_LIMITS.pagingEnvelopeBytes,
      maxStringCodeUnits: CONVERSATION_MESSAGE_ADMISSION_LIMITS.pagingEnvelopeBytes,
    });
    const rightBytes = canonicalJsonBytes(right, {
      maxBytes: CONVERSATION_MESSAGE_ADMISSION_LIMITS.pagingEnvelopeBytes,
      maxDepth: 32,
      maxNodes: 4_096,
      maxStringBytes: CONVERSATION_MESSAGE_ADMISSION_LIMITS.pagingEnvelopeBytes,
      maxStringCodeUnits: CONVERSATION_MESSAGE_ADMISSION_LIMITS.pagingEnvelopeBytes,
    });
    if (leftBytes.byteLength !== rightBytes.byteLength) return false;
    return leftBytes.every((byte, index) => byte === rightBytes[index]);
  } catch {
    return false;
  }
}

function sampleEdges<Value>(values: readonly Value[], maximum: number): Value[] {
  if (maximum <= 0) return [];
  if (values.length <= maximum) return [...values];
  if (maximum === 1) return values.slice(0, 1);
  const head = Math.ceil(maximum / 2);
  return [...values.slice(0, head), ...values.slice(values.length - (maximum - head))];
}

function projectedMetadataVariants(
  metadata: Record<string, unknown> | undefined,
): Array<{ value: Record<string, unknown>; omitted: boolean }> {
  if (metadata === undefined) return [{ value: {}, omitted: false }];
  const full = descriptorSafeMetadataSubset(metadata, Reflect.ownKeys(metadata));
  const stable = descriptorSafeMetadataSubset(metadata, [
    'modelUsage',
    'containsToolCall',
    'provenance',
    'actorId',
    'actorLabel',
    'agentId',
    'agentName',
    'participantId',
    'participantLabel',
  ]);
  return [
    { value: full, omitted: false },
    { value: stable, omitted: Object.keys(stable).length !== Object.keys(full).length },
    { value: {}, omitted: Object.keys(full).length > 0 },
  ];
}

function descriptorSafeMetadataSubset(
  metadata: Record<string, unknown>,
  keys: readonly PropertyKey[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string') continue;
    const descriptor = Object.getOwnPropertyDescriptor(metadata, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) continue;
    result[key] = descriptor.value;
  }
  return result;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maximumBytes) return value;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = maximumBytes; end >= Math.max(0, maximumBytes - 3); end -= 1) {
    try {
      return decoder.decode(encoded.subarray(0, end));
    } catch {
      // Only a trailing partial code point can fail; UTF-8 code points use at most four bytes.
    }
  }
  return '';
}

/**
 * Strictly normalize and admit one user-root event. This validates content,
 * structured parts and metadata together so no alternate field can bypass the
 * paging/compaction ceiling.
 */
export function normalizeAgentUserMessageForAdmission(value: unknown): ChatMessage {
  const normalizedMessage = normalizeConversationMessageForPagingAdmission(value);
  if (normalizedMessage.role !== 'user' || normalizedMessage.messageId !== normalizedMessage.turnId) {
    throw new Error('invalid canonical user-root message');
  }
  assertAgentUserMessageContentWithinLimits(normalizedMessage.content);
  return normalizedMessage;
}

/** Admit every role before it can enter a 256 KiB full-content page. */
export function normalizeConversationMessageForPagingAdmission(value: unknown): ChatMessage {
  // Reject accessors, cycles and an unbounded object graph before schema code
  // observes any property.
  canonicalJsonBytes(value, {
    maxBytes: MAX_CONVERSATION_EVENT_BYTES,
    maxDepth: 64,
    maxNodes: 200_000,
    maxStringBytes: MAX_CONVERSATION_EVENT_BYTES,
    maxStringCodeUnits: MAX_CONVERSATION_EVENT_BYTES,
  });
  assertCanonicalChatMessageProjection(value);
  const normalizedEvent = normalizeCanonicalConversationEvent(messageToConversationEvent(value));
  if (normalizedEvent.kind !== 'message') throw new Error('invalid canonical conversation message event');
  const normalizedMessage = conversationEventToMessage(normalizedEvent);
  const messageBytes = canonicalJsonBytes(normalizedMessage, {
    maxBytes: MAX_CONVERSATION_EVENT_BYTES,
    maxDepth: 64,
    maxNodes: 200_000,
    maxStringBytes: MAX_CONVERSATION_EVENT_BYTES,
    maxStringCodeUnits: MAX_CONVERSATION_EVENT_BYTES,
  }).byteLength;
  if (messageBytes > AGENT_USER_MESSAGE_LIMITS.canonicalMessageBytes) {
    throw new AgentUserMessageLimitError(
      'canonical-message',
      messageBytes,
      AGENT_USER_MESSAGE_LIMITS.canonicalMessageBytes,
    );
  }
  const eventBytes = canonicalConversationEventBytes(normalizedEvent).byteLength;
  if (eventBytes > AGENT_USER_MESSAGE_LIMITS.canonicalEventBytes) {
    throw new AgentUserMessageLimitError(
      'canonical-event',
      eventBytes,
      AGENT_USER_MESSAGE_LIMITS.canonicalEventBytes,
    );
  }
  return normalizedMessage;
}

export function assertAgentUserMessageWithinLimits(value: unknown): asserts value is ChatMessage {
  normalizeAgentUserMessageForAdmission(value);
}

export function assertConversationMessageWithinPagingLimits(value: unknown): asserts value is ChatMessage {
  normalizeConversationMessageForPagingAdmission(value);
}
