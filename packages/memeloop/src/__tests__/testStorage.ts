import { vi } from 'vitest';

import { type ChatMessage, type ConversationEvent, type ConversationEventDraft, conversationEventToMessage, normalizeCanonicalConversationEvent } from '../conversation/index.js';
import { canonicalJsonBytes } from '../encoding/canonicalJson.js';
import { buildConversationTimelinePage, compareMessageCursor, messageCursor } from '../storage/conversationPaging.js';
import type {
  ConversationMessageWindowResult,
  FullAgentStorage,
  GetConversationEventPageOptions,
  GetConversationListPageOptions,
  GetConversationMessageWindowAroundOptions,
  GetConversationTimelinePageOptions,
  GetMessagePageOptions,
  MessageVersionFrontierCursor,
} from '../storage/ports.js';
import type { ConversationMeta } from '../sync/protocol.js';

export interface TestStorageState {
  conversations: Map<string, ConversationMeta>;
  events: ConversationEvent[];
  messages: ChatMessage[];
}

export interface TestStorage extends FullAgentStorage {
  readonly state: TestStorageState;
}

/**
 * Strict v2 event-store fixture shared by runtime/loop tests.
 *
 * This deliberately exposes no appendMessage compatibility shim: tests append
 * through the same causal event API as production hosts.
 */
export function createTestStorage(
  initial?: Partial<TestStorageState>,
  overrides: Partial<FullAgentStorage> = {},
): TestStorage {
  const state: TestStorageState = {
    conversations: initial?.conversations ?? new Map<string, ConversationMeta>(),
    events: initial?.events ?? [],
    messages: initial?.messages ?? [],
  };

  const projectEvent = (event: ConversationEvent): void => {
    if (event.kind === 'message') {
      const message = conversationEventToMessage(event);
      state.messages.push(message);
      const previous = state.conversations.get(event.conversationId);
      state.conversations.set(event.conversationId, {
        conversationId: event.conversationId,
        title: previous?.title ?? '',
        lastMessagePreview: message.content,
        lastMessageTimestamp: message.timestamp,
        messageCount: (previous?.messageCount ?? 0) + 1,
        originNodeId: previous?.originNodeId ?? event.originNodeId,
        originClock: Math.max(previous?.originClock ?? 0, event.lamportClock),
        definitionId: previous?.definitionId ?? '',
        instanceDelta: previous?.instanceDelta,
        isUserInitiated: previous?.isUserInitiated ?? message.role === 'user',
        sourceChannel: previous?.sourceChannel,
      });
      return;
    }
    if (event.kind === 'metadataPatch') {
      const previous = state.conversations.get(event.conversationId);
      const sourceChannel = event.patch.sourceChannel === null
        ? undefined
        : event.patch.sourceChannel ?? previous?.sourceChannel;
      state.conversations.set(event.conversationId, {
        conversationId: event.conversationId,
        title: event.patch.title ?? previous?.title ?? '',
        lastMessagePreview: previous?.lastMessagePreview ?? '',
        lastMessageTimestamp: previous?.lastMessageTimestamp ?? event.timestamp,
        messageCount: previous?.messageCount ?? 0,
        originNodeId: event.originNodeId,
        originClock: Math.max(previous?.originClock ?? 0, event.lamportClock),
        definitionId: event.patch.definitionId ?? previous?.definitionId ?? '',
        instanceDelta: event.patch.instanceDelta ?? previous?.instanceDelta,
        isUserInitiated: event.patch.isUserInitiated ?? previous?.isUserInitiated ?? false,
        sourceChannel,
      });
      return;
    }
    if (event.kind === 'tombstone') {
      const removed = state.messages.filter(message => message.conversationId === event.conversationId && message.turnId === event.targetTurnId);
      state.messages.splice(
        0,
        state.messages.length,
        ...state.messages.filter(message => message.conversationId !== event.conversationId || message.turnId !== event.targetTurnId),
      );
      const previous = state.conversations.get(event.conversationId);
      if (previous && removed.length > 0) {
        state.conversations.set(event.conversationId, {
          ...previous,
          messageCount: Math.max(0, previous.messageCount - removed.length),
          originClock: Math.max(previous.originClock, event.lamportClock),
        });
      }
    }
  };

  const appendLocalEvent = vi.fn(async (draft: ConversationEventDraft): Promise<ConversationEvent> => {
    const existing = state.events.find(event => event.eventId === draft.eventId);
    if (existing) {
      const candidate = normalizeCanonicalConversationEvent({
        ...draft,
        originSequence: existing.originSequence,
        lamportClock: existing.lamportClock,
      });
      const existingBytes = canonicalJsonBytes(existing);
      const candidateBytes = canonicalJsonBytes(candidate);
      if (
        existingBytes.byteLength !== candidateBytes.byteLength ||
        existingBytes.some((byte, index) => byte !== candidateBytes[index])
      ) throw new Error(`local eventId ${draft.eventId} already exists with a different payload`);
      return existing;
    }
    const sameOrigin = state.events.filter(event => event.conversationId === draft.conversationId && event.originNodeId === draft.originNodeId);
    const sameConversation = state.events.filter(event => event.conversationId === draft.conversationId);
    const event = {
      ...draft,
      originSequence: Math.max(0, ...sameOrigin.map(item => item.originSequence)) + 1,
      lamportClock: Math.max(0, ...sameConversation.map(item => item.lamportClock)) + 1,
    } as ConversationEvent;
    state.events.push(event);
    projectEvent(event);
    return event;
  });

  const appendLocalEventsAtomic = vi.fn(async (
    drafts: readonly ConversationEventDraft[],
  ): Promise<ConversationEvent[]> => {
    const eventSnapshot = [...state.events];
    const messageSnapshot = [...state.messages];
    const conversationSnapshot = new Map(state.conversations);
    try {
      const result: ConversationEvent[] = [];
      for (const draft of drafts) result.push(await appendLocalEvent(draft));
      return result;
    } catch (error) {
      state.events.splice(0, state.events.length, ...eventSnapshot);
      state.messages.splice(0, state.messages.length, ...messageSnapshot);
      state.conversations.clear();
      for (const [id, meta] of conversationSnapshot) state.conversations.set(id, meta);
      throw error;
    }
  });

  const storage: FullAgentStorage = {
    listConversationsPage: vi.fn(async (options: GetConversationListPageOptions) => {
      const revision = `test-conversations:${state.conversations.size}`;
      if (options.expectedRevision !== undefined && options.expectedRevision !== revision) {
        return { reset: true as const, revision };
      }
      const query = options.query;
      const all = [...state.conversations.values()]
        .filter(meta => query?.definitionId === undefined || meta.definitionId === query.definitionId)
        .filter(meta =>
          query?.sourceChannelId === undefined ||
          meta.sourceChannel?.channelId === query.sourceChannelId
        )
        .filter(meta => query?.isUserInitiated === undefined || meta.isUserInitiated === query.isUserInitiated)
        .sort((left, right) =>
          right.lastMessageTimestamp - left.lastMessageTimestamp ||
          left.conversationId.localeCompare(right.conversationId)
        );
      const cursor = (meta: ConversationMeta) => `test-conversation:${encodeURIComponent(meta.conversationId)}:${meta.lastMessageTimestamp}`;
      let start = 0;
      if (options.beforeCursor !== undefined) {
        const index = all.findIndex(meta => cursor(meta) === options.beforeCursor);
        if (index < 0) return { reset: true as const, revision };
        start = index + 1;
      } else if (options.afterCursor !== undefined) {
        const index = all.findIndex(meta => cursor(meta) === options.afterCursor);
        if (index < 0) return { reset: true as const, revision };
        start = Math.max(0, index - options.limit);
      }
      const items = all.slice(start, start + options.limit);
      return {
        reset: false as const,
        items,
        revision,
        total: all.length,
        hasMoreBefore: start > 0,
        hasMoreAfter: start + items.length < all.length,
        ...(items[0] ? { startCursor: cursor(items[0]) } : {}),
        ...(items.at(-1) ? { endCursor: cursor(items.at(-1)!) } : {}),
      };
    }),
    getMessagePage: vi.fn(async (conversationId: string, options: GetMessagePageOptions) => {
      const revision = `test-messages:${state.events.filter(event => event.conversationId === conversationId).length}:${
        state.messages.filter(message => message.conversationId === conversationId).length
      }`;
      if (options.expectedRevision !== undefined && options.expectedRevision !== revision) {
        return { reset: true as const, conversationId, revision };
      }
      let all = state.messages
        .filter(message => message.conversationId === conversationId)
        .sort((left, right) => compareMessageCursor(messageCursor(left), messageCursor(right)));
      if (options.after) {
        all = all.filter(message => compareMessageCursor(messageCursor(message), options.after!) > 0);
      }
      if (options.before) {
        all = all.filter(message => compareMessageCursor(messageCursor(message), options.before!) < 0);
      }
      const direction = options.direction ?? 'backward';
      let items = direction === 'forward' ? all.slice(0, options.limit) : all.slice(-options.limit);
      while (items.length > 0 && new TextEncoder().encode(JSON.stringify(items)).byteLength > options.maxBytes) {
        items = direction === 'forward' ? items.slice(0, -1) : items.slice(1);
      }
      const first = items[0];
      const last = items.at(-1);
      const full = state.messages
        .filter(message => message.conversationId === conversationId)
        .sort((left, right) => compareMessageCursor(messageCursor(left), messageCursor(right)));
      return {
        reset: false as const,
        conversationId,
        revision,
        items,
        hasMoreBefore: first !== undefined && full.some(message => compareMessageCursor(messageCursor(message), messageCursor(first)) < 0),
        hasMoreAfter: last !== undefined && full.some(message => compareMessageCursor(messageCursor(message), messageCursor(last)) > 0),
        ...(first ? { startCursor: messageCursor(first) } : {}),
        ...(last ? { endCursor: messageCursor(last) } : {}),
      };
    }),
    getMessageWindowAround: vi.fn(async (
      conversationId: string,
      options: GetConversationMessageWindowAroundOptions,
    ): Promise<ConversationMessageWindowResult> => {
      const revision = `test-messages:${state.events.filter(event => event.conversationId === conversationId).length}`;
      const all = state.messages
        .filter(message => message.conversationId === conversationId)
        .sort((left, right) => compareMessageCursor(messageCursor(left), messageCursor(right)));
      let turnId: string | undefined;
      if (options.focus.kind === 'turn') {
        turnId = options.focus.turnId;
      } else {
        const entryId = options.focus.entryId;
        const focusedEvent = state.events.find(event => event.eventId === entryId);
        if (focusedEvent?.kind === 'message') turnId = focusedEvent.message.turnId;
      }
      if (!turnId) return { reset: true, conversationId, revision };
      const focusIndex = all.findIndex(message => message.turnId === turnId);
      if (focusIndex < 0) return { reset: true, conversationId, revision };
      const limit = Math.max(1, options.maxMessages);
      const start = Math.max(0, Math.min(focusIndex - Math.floor(limit / 2), all.length - limit));
      let items = all.slice(start, start + limit);
      while (items.length > 0 && new TextEncoder().encode(JSON.stringify(items)).byteLength > options.maxBytes) {
        if (items.length === 1) return { reset: true, conversationId, revision };
        const focusOffset = items.findIndex(message => message.turnId === turnId);
        items = focusOffset > items.length / 2 ? items.slice(1) : items.slice(0, -1);
      }
      const first = items[0];
      const last = items.at(-1);
      return {
        reset: false,
        conversationId,
        revision,
        focus: {
          kind: 'turn',
          turnId,
          ...(options.focus.kind === 'timeline-entry'
            ? { entryId: options.focus.entryId, cursor: options.focus.cursor }
            : options.focus.cursor === undefined
            ? {}
            : { cursor: options.focus.cursor }),
        },
        items,
        hasMoreBefore: start > 0,
        hasMoreAfter: start + items.length < all.length,
        ...(first ? { startCursor: messageCursor(first) } : {}),
        ...(last ? { endCursor: messageCursor(last) } : {}),
      };
    }),
    getConversationTimelinePage: vi.fn(async (
      conversationId: string,
      options: GetConversationTimelinePageOptions,
    ) =>
      buildConversationTimelinePage(
        state.events,
        conversationId,
        options,
        `test-timeline:${state.events.filter(event => event.conversationId === conversationId).length}`,
      )
    ),
    getMessageById: vi.fn(async (conversationId, messageId) =>
      state.messages.find(message => message.conversationId === conversationId && message.messageId === messageId) ?? null
    ),
    getConversationEventPage: vi.fn(async (
      conversationId: string,
      options: GetConversationEventPageOptions,
    ) => {
      const items = state.events
        .filter(event => event.conversationId === conversationId)
        .filter(event =>
          options.ranges === undefined || options.ranges.some((range: {
            originNodeId: string;
            fromExclusive: number;
            toInclusive: number;
          }) =>
            event.originNodeId === range.originNodeId &&
            event.originSequence > range.fromExclusive && event.originSequence <= range.toInclusive
          )
        )
        .slice(0, options.limit);
      const final = items.at(-1);
      return {
        items,
        hasMoreBefore: false,
        hasMoreAfter: false,
        startCursor: items[0] === undefined ? undefined : {
          originNodeId: items[0].originNodeId,
          originSequence: items[0].originSequence,
          eventId: items[0].eventId,
        },
        endCursor: final === undefined ? undefined : {
          originNodeId: final.originNodeId,
          originSequence: final.originSequence,
          eventId: final.eventId,
        },
      };
    }),
    appendLocalEvent,
    appendLocalEventsAtomic,
    insertEventsIfAbsent: vi.fn(async (events: readonly ConversationEvent[]) => {
      for (const event of events) {
        const existing = state.events.find(item => item.eventId === event.eventId);
        if (existing !== undefined) continue;
        state.events.push(event);
        projectEvent(event);
      }
    }),
    getEventVersionFrontierPage: vi.fn(async (
      options: Parameters<FullAgentStorage['getEventVersionFrontierPage']>[0],
    ) => {
      const selected = options.conversationIds === undefined
        ? state.events
        : state.events.filter(event => options.conversationIds?.includes(event.conversationId));
      const frontiers = new Map<string, number>();
      for (const event of selected) {
        const key = `${event.conversationId}\u0000${event.originNodeId}`;
        frontiers.set(key, Math.max(frontiers.get(key) ?? 0, event.originSequence));
      }
      const rows = [...frontiers].map(([key, maxContiguousOriginSequence]) => {
        const [conversationId, originNodeId] = key.split('\u0000');
        return { conversationId, originNodeId, maxContiguousOriginSequence };
      }).filter(item =>
        options.after === undefined ||
        item.conversationId > options.after.conversationId ||
        item.conversationId === options.after.conversationId &&
          item.originNodeId > options.after.originNodeId
      );
      const items = rows.slice(0, options.limit);
      const final = items.at(-1);
      return {
        items,
        nextCursor: rows.length > items.length && final !== undefined
          ? {
            conversationId: final.conversationId,
            originNodeId: final.originNodeId,
          }
          : undefined,
      };
    }),
    getEventVersionFrontiersForKeys: vi.fn(async (keys: readonly MessageVersionFrontierCursor[]) => {
      const page = await storage.getEventVersionFrontierPage({ limit: 256 });
      return page.items.filter(item => keys.some((key: MessageVersionFrontierCursor) => key.conversationId === item.conversationId && key.originNodeId === item.originNodeId));
    }),
    getCompactionCandidatePage: vi.fn(async (
      _conversationId: string,
      options: { afterCoveredVersion: Readonly<Record<string, number>> },
      callOptions?: { signal?: AbortSignal },
    ) => {
      callOptions?.signal?.throwIfAborted();
      const page = {
        messages: [],
        nextCoveredVersion: { ...options.afterCoveredVersion },
        newlyCoveredMessageCountByOrigin: {},
        newlyCoveredUserTurnCountByOrigin: {},
        hasMore: false,
      };
      callOptions?.signal?.throwIfAborted();
      return page;
    }),
    getRetainedCompactionControls: vi.fn(async (
      _conversationId: string,
      _options: unknown,
      callOptions?: { signal?: AbortSignal },
    ) => {
      callOptions?.signal?.throwIfAborted();
      const page = { items: [], hasMore: false, invalidated: false };
      callOptions?.signal?.throwIfAborted();
      return page;
    }),
    upsertConversationMetadata: vi.fn(async (meta: ConversationMeta) => {
      state.conversations.set(meta.conversationId, meta);
    }),
    getConversationMeta: vi.fn(async (conversationId: string) => state.conversations.get(conversationId) ?? null),
    getAttachment: vi.fn(async () => null),
    saveAttachment: vi.fn(async () => undefined),
    conversationReferencesAttachment: vi.fn(async () => false),
    getAgentDefinition: vi.fn(async () => null),
    saveAgentInstance: vi.fn(async () => undefined),
  };

  return Object.assign(storage, overrides, { state });
}
