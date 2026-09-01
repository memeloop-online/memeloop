import { describe, expect, it, vi } from 'vitest';

import type {
  ConversationCompactionCoverageEvent,
  ConversationCompactionSummaryEvent,
  ConversationEvent,
  ConversationMessageEvent,
  ConversationTombstoneEvent,
} from '../../conversation/events.js';
import type { ChatMessage } from '../../conversation/index.js';
import { canonicalJsonBytes } from '../../encoding/canonicalJson.js';
import {
  assertConversationMessageProjection,
  assertConversationMessageWindowResult,
  boundConversationTimelineMessageEntry,
  buildConversationFullContentMessagePage,
  buildConversationMessagePage,
  buildConversationMessageWindowAround,
  buildConversationTimelinePage,
  compareMessageCursor,
  MAX_CONVERSATION_MESSAGE_WINDOW_BYTES,
  MAX_CONVERSATION_MESSAGE_WINDOW_SIZE,
  MAX_CONVERSATION_TIMELINE_PAGE_BYTES,
  MAX_CONVERSATION_TIMELINE_PAGE_SIZE,
  MAX_MESSAGE_PAGE_SIZE,
  messageCursor,
  projectConversationMessageForList,
  projectTransientConversationMessageForList,
  readConversationMessagePage,
  readConversationTimelinePage,
} from '../conversationPaging.js';
import type {
  ConversationEventStore,
  ConversationMessageWindowResult,
  ConversationTimelinePage,
  GetConversationMessageWindowAroundOptions,
  GetConversationTimelinePageOptions,
} from '../ports.js';

const PAGE_BYTES = 64 * 1_024;
const REVISION = 'timeline-revision-7';

function message(
  index: number,
  role: ChatMessage['role'] = index % 2 === 0 ? 'user' : 'assistant',
): ChatMessage {
  const messageId = `m-${index.toString().padStart(3, '0')}`;
  const rootIndex = role === 'user' ? index : Math.max(0, index - 1);
  return {
    messageId,
    turnId: role === 'user'
      ? messageId
      : `m-${rootIndex.toString().padStart(3, '0')}`,
    conversationId: 'long',
    originNodeId: index % 3 === 0 ? 'a' : 'b',
    originSequence: index + 1,
    timestamp: 1_000 + Math.floor(index / 2),
    lamportClock: index + 1,
    role,
    content: `${role} message ${index}\nmore detail`,
  };
}

function messageEvent(input: ChatMessage): ConversationMessageEvent {
  return {
    eventId: input.messageId,
    conversationId: input.conversationId,
    originNodeId: input.originNodeId,
    originSequence: input.originSequence,
    timestamp: input.timestamp,
    lamportClock: input.lamportClock,
    kind: 'message',
    message: {
      messageId: input.messageId,
      turnId: input.turnId,
      role: input.role,
      content: input.content,
      ...(input.hidden === undefined ? {} : { hidden: input.hidden }),
      ...(input.toolCalls === undefined ? {} : { toolCalls: input.toolCalls }),
      ...(input.reasoning_content === undefined ? {} : { reasoning_content: input.reasoning_content }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    },
  };
}

function turnEvents(turnCount: number): ConversationEvent[] {
  return Array.from({ length: turnCount * 2 }, (_, index) => messageEvent(message(index)));
}

function options(overrides: Partial<GetConversationTimelinePageOptions> = {}): GetConversationTimelinePageOptions {
  return { limit: 10, maxBytes: PAGE_BYTES, ...overrides };
}

function timelineStore(events: readonly ConversationEvent[], revision = REVISION): {
  storage: ConversationEventStore;
  getConversationTimelinePage: ReturnType<typeof vi.fn>;
  getMessages: ReturnType<typeof vi.fn>;
} {
  const getConversationTimelinePage = vi.fn(
    async (
      conversationId: string,
      pageOptions: GetConversationTimelinePageOptions,
    ) => buildConversationTimelinePage(events, conversationId, pageOptions, revision),
  );
  const getMessages = vi.fn();
  return {
    storage: { getConversationTimelinePage, getMessages } as unknown as ConversationEventStore,
    getConversationTimelinePage,
    getMessages,
  };
}

function success(page: ConversationTimelinePage) {
  if (page.reset) throw new Error('expected timeline page success');
  return page;
}

describe('conversation message paging', () => {
  it('delegates to the required optimized store and enforces the page ceiling', async () => {
    const getMessagePage = vi.fn().mockResolvedValue({
      reset: false,
      conversationId: 'long',
      revision: REVISION,
      items: [],
      hasMoreBefore: false,
      hasMoreAfter: false,
    });
    const getMessages = vi.fn();
    const store = { getMessagePage, getMessages } as unknown as ConversationEventStore;
    await readConversationMessagePage(store, 'long', { limit: 99_999, maxBytes: PAGE_BYTES });
    expect(getMessagePage).toHaveBeenCalledWith('long', { limit: 50, maxBytes: PAGE_BYTES }, {});
    expect(getMessages).not.toHaveBeenCalled();

    expect(() =>
      buildConversationMessagePage([], 'long', {
        limit: 51,
        maxBytes: PAGE_BYTES,
      }, REVISION)
    ).toThrow('invalid_conversation_message_page_options');
    await expect(readConversationMessagePage(store, 'long', {
      limit: 1,
      maxBytes: 256 * 1024 + 1,
    })).rejects.toThrow('invalid_conversation_message_page_options');
  });

  it('uses SQLite BINARY-compatible deterministic text ordering', () => {
    const upper = { ...message(0), originNodeId: 'Z', messageId: 'same-Z', turnId: 'same-Z' };
    const lower = { ...message(0), originNodeId: 'a', messageId: 'same-a', turnId: 'same-a' };
    expect(compareMessageCursor(messageCursor(upper), messageCursor(lower))).toBeLessThan(0);
  });

  it('uses exact keyset identity and returns a same-revision reset for hostile cursors', () => {
    const rows = Array.from({ length: 6 }, (_, index) => message(index));
    const cursor = messageCursor(rows[4]);
    const before = buildConversationMessagePage(rows, 'long', {
      limit: 2,
      maxBytes: PAGE_BYTES,
      before: cursor,
      expectedRevision: REVISION,
    }, REVISION);
    if (before.reset) throw new Error('expected exact cursor success');
    expect(before.items.map(item => item.messageId)).toEqual(['m-002', 'm-003']);

    expect(buildConversationMessagePage(rows, 'long', {
      limit: 2,
      maxBytes: PAGE_BYTES,
      before: { ...cursor, messageId: 'forged-message-id' },
      expectedRevision: REVISION,
    }, REVISION)).toEqual({ reset: true, conversationId: 'long', revision: REVISION });
    expect(buildConversationMessagePage(rows, 'long', {
      limit: 2,
      maxBytes: PAGE_BYTES,
      after: { ...cursor, originNodeId: 'unknown-node' },
      expectedRevision: REVISION,
    }, REVISION)).toEqual({ reset: true, conversationId: 'long', revision: REVISION });
  });

  it.each([
    ['negative causal sequence', { ...message(0), originSequence: -1 }],
    ['zero Lamport clock', { ...message(0), lamportClock: 0 }],
    ['forged user root', { ...message(0), turnId: 'different-turn' }],
    ['invalid role', { ...message(0), role: 'system' }],
    ['unpaired surrogate content', { ...message(0), content: 'bad\ud800text' }],
    ['unpaired surrogate metadata key', { ...message(0), metadata: { ['bad\ud800key']: true } }],
  ])('rejects a hostile storage-host projection: %s', async (_label, hostile) => {
    const store = {
      getMessagePage: vi.fn().mockResolvedValue({
        reset: false,
        conversationId: 'long',
        revision: REVISION,
        items: [hostile],
        hasMoreBefore: false,
        hasMoreAfter: false,
        startCursor: messageCursor(hostile as ChatMessage),
        endCursor: messageCursor(hostile as ChatMessage),
      }),
    } as unknown as ConversationEventStore;

    await expect(readConversationMessagePage(store, 'long', {
      limit: 10,
      maxBytes: PAGE_BYTES,
    })).rejects.toThrow();
  });

  it('rejects invalid Unicode before deriving a memory timeline cursor', () => {
    const event = {
      ...messageEvent(message(0)),
      originNodeId: 'bad\ud800origin',
    };
    expect(() =>
      buildConversationTimelinePage(
        [event],
        'long',
        options(),
        REVISION,
      )
    ).toThrow('invalid canonical conversation event');
  });
});

describe('independent reasoning projections', () => {
  it('keeps persisted reasoning page-addressable without shortening a fully represented answer', () => {
    const source: ChatMessage = {
      ...message(1, 'assistant'),
      content: 'final answer',
      reasoning_content: 'private reasoning',
      parts: [
        { type: 'reasoning', text: 'private reasoning' },
        { type: 'text', text: 'final answer' },
      ],
    };
    const projection = projectConversationMessageForList(source, 16 * 1024);

    expect(projection).toMatchObject({
      content: 'final answer',
      reasoning: { text: '', totalBytes: 17, hasMore: true },
    });
    expect(projection).not.toHaveProperty('reasoning_content');
    expect(projection.metadata?.displayTruncation).toBeUndefined();
    expect(() => {
      assertConversationMessageProjection(projection, source.conversationId);
    }).not.toThrow();
  });

  it('fits answer text before a transient reasoning prefix', () => {
    const source: ChatMessage = {
      ...message(1, 'assistant'),
      content: 'A'.repeat(8_000),
      reasoning_content: '推'.repeat(8_000),
    };
    const maximumBytes = 12 * 1024;
    const durable = projectConversationMessageForList(source, maximumBytes);
    const transient = projectTransientConversationMessageForList(source, maximumBytes);

    expect(durable.content).toBe(source.content);
    expect(transient.content).toBe(source.content);
    expect(transient.reasoning?.text.length).toBeGreaterThan(0);
    expect(transient.reasoning?.hasMore).toBe(true);
    expect(canonicalJsonBytes(transient, { maxBytes: maximumBytes }).byteLength).toBeLessThanOrEqual(maximumBytes);
    expect(() => {
      assertConversationMessageProjection(transient, source.conversationId);
    }).not.toThrow();
  });

  it('rejects inconsistent reasoning byte metadata', () => {
    const projection = projectConversationMessageForList({
      ...message(1, 'assistant'),
      reasoning_content: 'reasoning',
    }, 16 * 1024);
    expect(() => {
      assertConversationMessageProjection({
        ...projection,
        reasoning: { text: 'reasoning', totalBytes: 1, hasMore: false },
      });
    }).toThrow('invalid_conversation_message_projection');
  });
});

describe('atomic conversation message windows', () => {
  const windowOptions = (
    overrides: Partial<GetConversationMessageWindowAroundOptions> = {},
  ): GetConversationMessageWindowAroundOptions => ({
    focus: { kind: 'message', messageId: 'm-002', turnId: 'm-002' },
    expectedRevision: REVISION,
    maxMessages: 4,
    maxBytes: 128 * 1024,
    ...overrides,
  });

  it('builds one revision-consistent window and accepts the exact 256 KiB ceiling', () => {
    const result = buildConversationMessageWindowAround(
      turnEvents(4),
      'long',
      windowOptions({ maxBytes: 256 * 1024 }),
      REVISION,
    );
    expect(result).toMatchObject({
      reset: false,
      conversationId: 'long',
      revision: REVISION,
      focus: { kind: 'message', messageId: 'm-002', turnId: 'm-002' },
      recenterAnchor: { messageId: 'm-002', turnId: 'm-002' },
    });
    if (result.reset) throw new Error('expected window success');
    expect(result.items.some(item => item.messageId === 'm-002')).toBe(true);
    expect(() =>
      buildConversationMessageWindowAround(
        turnEvents(1),
        'long',
        windowOptions({ maxBytes: 256 * 1024 + 1 }),
        REVISION,
      )
    ).toThrow('invalid_conversation_message_window_byte_budget');
  });

  it('centres an exact assistant marker and never trims away odd/even anchors', () => {
    const events = turnEvents(5).map(event =>
      event.kind === 'message'
        ? { ...event, message: { ...event.message, content: `${event.message.content}${'x'.repeat(8_000)}` } }
        : event
    );
    for (const messageId of ['m-003', 'm-004']) {
      const turnId = messageId === 'm-003' ? 'm-002' : 'm-004';
      const result = buildConversationMessageWindowAround(
        events,
        'long',
        windowOptions({
          focus: { kind: 'message', messageId, turnId },
          maxMessages: messageId === 'm-003' ? 5 : 4,
          maxBytes: 8 * 1_024,
        }),
        REVISION,
      );
      if (result.reset) throw new Error('expected exact message window');
      expect(result.recenterAnchor).toEqual({ messageId, turnId });
      expect(result.items.some(item => item.messageId === messageId)).toBe(true);
    }
  });

  it('rejects forged direct focus provenance, revision drift, and malformed compactions', () => {
    const valid = buildConversationMessageWindowAround(
      turnEvents(4),
      'long',
      windowOptions(),
      REVISION,
    );
    if (valid.reset) throw new Error('expected window success');
    const forgedDirect = {
      ...valid,
      focus: { kind: 'message' as const, messageId: 'm-002', turnId: 'm-002', entryId: 'forged' },
    };
    expect(() => {
      assertConversationMessageWindowResult(
        forgedDirect,
        'long',
        windowOptions(),
      );
    }).toThrow('invalid_conversation_message_window_focus');
    expect(() => {
      assertConversationMessageWindowResult(
        { ...valid, revision: 'other-revision' },
        'long',
        windowOptions(),
      );
    }).toThrow('invalid_conversation_message_window');

    const compactionRequest = windowOptions({
      focus: { kind: 'timeline-entry', entryId: 'summary-event', cursor: 'summary-cursor' },
    });
    const malformedCompaction = {
      ...valid,
      focus: {
        kind: 'compaction' as const,
        entry: {
          kind: 'compaction' as const,
          entryId: 'summary-event',
          conversationId: 'long',
          timestamp: 1,
          lamportClock: 1,
          originNodeId: 'node-a',
          cursor: 'summary-cursor',
          entryIndex: 0,
          turnIndex: 0,
          summaryPreview: 'summary',
          compactedMessageCount: -1,
          compactedTurnCount: 0,
        },
        nearestPosition: 'before' as const,
        nearestMessageId: valid.items[0].messageId,
        nearestTurnId: valid.items[0].turnId,
      },
    } satisfies ConversationMessageWindowResult;
    expect(() => {
      assertConversationMessageWindowResult(
        malformedCompaction,
        'long',
        compactionRequest,
      );
    }).toThrow('invalid_conversation_timeline_compaction');
  });
});

describe('revisioned conversation timeline pages', () => {
  it('keeps an assistant-only message navigable without fabricating a user-root index', () => {
    const assistant = messageEvent({
      ...message(1, 'assistant'),
      messageId: 'orphan-assistant',
      turnId: 'missing-user-root',
    });
    const page = success(buildConversationTimelinePage([assistant], 'long', options(), REVISION));
    expect(page).toMatchObject({ totalMessages: 1, totalTurns: 0, totalEntries: 1 });
    expect(page.items).toEqual([
      expect.objectContaining({
        kind: 'message',
        messageId: 'orphan-assistant',
        turnId: 'missing-user-root',
        role: 'assistant',
      }),
    ]);
    expect(page.items[0]).not.toHaveProperty('turnIndex');
  });

  it('separates projection-only interactive pages from explicit full-content pages', () => {
    const source = {
      ...message(1, 'assistant'),
      parts: [{ type: 'text' as const, text: 'answer' }],
      reasoning_content: 'private reasoning',
    };
    const interactive = buildConversationMessagePage([source], 'long', {
      limit: 1,
      maxBytes: PAGE_BYTES,
    }, REVISION);
    const full = buildConversationFullContentMessagePage([source], 'long', {
      limit: 1,
      maxBytes: PAGE_BYTES,
    }, REVISION);
    if (interactive.reset || full.reset) throw new Error('expected message pages');
    expect(interactive.items[0]).not.toHaveProperty('parts');
    expect(interactive.items[0]).not.toHaveProperty('reasoning_content');
    expect(full.items[0]).toMatchObject({
      parts: [{ type: 'text', text: 'answer' }],
      reasoning_content: 'private reasoning',
    });
  });
  it('exports one shared 50-entry/256 KiB interactive ceiling and reads the latest page without full history', async () => {
    expect(MAX_MESSAGE_PAGE_SIZE).toBe(50);
    expect(MAX_CONVERSATION_TIMELINE_PAGE_SIZE).toBe(50);
    expect(MAX_CONVERSATION_MESSAGE_WINDOW_SIZE).toBe(50);
    expect(MAX_CONVERSATION_TIMELINE_PAGE_BYTES).toBe(256 * 1024);
    expect(MAX_CONVERSATION_MESSAGE_WINDOW_BYTES).toBe(256 * 1024);
    const { storage, getConversationTimelinePage, getMessages } = timelineStore(turnEvents(12));
    const request = options({ limit: 5 });

    const page = success(await readConversationTimelinePage(storage, 'long', request));

    expect(page.reset).toBe(false);
    expect(page.items.map(item => item.entryIndex)).toEqual([19, 20, 21, 22, 23]);
    expect(page).toMatchObject({
      revision: REVISION,
      totalMessages: 24,
      totalTurns: 12,
      totalEntries: 24,
      hasMoreBefore: true,
      hasMoreAfter: false,
      startEntryIndex: 19,
      endEntryIndex: 23,
    });
    expect(page.startCursor).toBe(page.items[0].cursor);
    expect(page.endCursor).toBe(page.items.at(-1)?.cursor);
    expect(getConversationTimelinePage).toHaveBeenCalledWith('long', request, {});
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('uses exclusive stable before/after cursors and centered entry indexes', () => {
    const messages = turnEvents(12);
    const all = success(buildConversationTimelinePage(messages, 'long', options({ limit: 24 }), REVISION));
    const cursor7 = all.items[7].cursor;

    const before = success(buildConversationTimelinePage(
      messages,
      'long',
      options({ limit: 3, beforeCursor: cursor7, expectedRevision: REVISION }),
      REVISION,
    ));
    expect(before.items.map(item => item.entryIndex)).toEqual([4, 5, 6]);
    expect(before).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true });

    const after = success(buildConversationTimelinePage(
      messages,
      'long',
      options({ limit: 3, afterCursor: cursor7, expectedRevision: REVISION }),
      REVISION,
    ));
    expect(after.items.map(item => item.entryIndex)).toEqual([8, 9, 10]);
    expect(after).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true });

    expect(success(buildConversationTimelinePage(
      messages,
      'long',
      options({ beforeCursor: all.items[0].cursor, expectedRevision: REVISION }),
      REVISION,
    ))).toMatchObject({ items: [], hasMoreBefore: false, hasMoreAfter: true });
    expect(success(buildConversationTimelinePage(
      messages,
      'long',
      options({ afterCursor: all.items.at(-1)!.cursor, expectedRevision: REVISION }),
      REVISION,
    ))).toMatchObject({ items: [], hasMoreBefore: true, hasMoreAfter: false });

    expect(
      success(buildConversationTimelinePage(
        messages,
        'long',
        options({ limit: 5, aroundEntryIndex: 6 }),
        REVISION,
      )).items.map(item => item.entryIndex),
    ).toEqual([4, 5, 6, 7, 8]);
    expect(
      success(buildConversationTimelinePage(
        messages,
        'long',
        options({ limit: 5, aroundEntryIndex: 0 }),
        REVISION,
      )).items.map(item => item.entryIndex),
    ).toEqual([0, 1, 2, 3, 4]);
    expect(
      success(buildConversationTimelinePage(
        messages,
        'long',
        options({ limit: 5, aroundEntryIndex: 23 }),
        REVISION,
      )).items.map(item => item.entryIndex),
    ).toEqual([19, 20, 21, 22, 23]);
  });

  it('truncates previews at UTF-16 bounds without splitting emoji surrogate pairs', () => {
    const splitBoundary = messageEvent({
      ...message(0, 'user'),
      messageId: 'emoji-split',
      turnId: 'emoji-split',
      content: 'ab😀c',
    });
    const exactBoundary = messageEvent({
      ...message(2, 'user'),
      messageId: 'emoji-exact',
      turnId: 'emoji-exact',
      content: 'a😀bc',
    });
    const page = success(buildConversationTimelinePage(
      [splitBoundary, exactBoundary],
      'long',
      options({ limit: 2, previewLength: 4 }),
      REVISION,
    ));
    expect(page.items.map(item => item.kind === 'message' ? item.preview : '')).toEqual([
      'ab…',
      'a😀…',
    ]);
    for (const entry of page.items) {
      if (entry.kind !== 'message') continue;
      expect(entry.preview.length).toBeLessThanOrEqual(4);
      expect(entry.preview).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    }
  });

  it('returns a strict reset union for revision drift or an unknown display cursor', () => {
    const messages = turnEvents(3);
    expect(buildConversationTimelinePage(
      messages,
      'long',
      options({ expectedRevision: 'stale-revision' }),
      REVISION,
    )).toEqual({ reset: true, revision: REVISION });
    expect(buildConversationTimelinePage(
      messages,
      'long',
      options({ beforeCursor: 'unknown-cursor', expectedRevision: REVISION }),
      REVISION,
    )).toEqual({ reset: true, revision: REVISION });

    const first = success(buildConversationTimelinePage(messages, 'long', options(), REVISION));
    const second = success(buildConversationTimelinePage(messages, 'long', options(), 'timeline-revision-8'));
    expect(second.items.map(item => item.cursor)).toEqual(first.items.map(item => item.cursor));
  });

  it('resets stale cursors after an older insertion, tombstone, or compaction changes revision', () => {
    const initialEvents = turnEvents(3);
    const initial = success(buildConversationTimelinePage(initialEvents, 'long', options(), 'revision-1'));
    const cursor = initial.items[1].cursor;
    const olderInsertion = messageEvent({
      ...message(20, 'user'),
      messageId: 'older-inserted',
      turnId: 'older-inserted',
      timestamp: 1,
      lamportClock: 1,
    });
    expect(buildConversationTimelinePage(
      [olderInsertion, ...initialEvents],
      'long',
      options({ beforeCursor: cursor, expectedRevision: 'revision-1' }),
      'revision-2',
    )).toEqual({ reset: true, revision: 'revision-2' });

    const tombstone: ConversationTombstoneEvent = {
      eventId: 'tombstone-m-000',
      conversationId: 'long',
      originNodeId: 'node',
      originSequence: 100,
      timestamp: 3_000,
      lamportClock: 100,
      kind: 'tombstone',
      targetTurnId: 'm-000',
    };
    expect(buildConversationTimelinePage(
      [...initialEvents, tombstone],
      'long',
      options({ beforeCursor: cursor, expectedRevision: 'revision-2' }),
      'revision-3',
    )).toEqual({ reset: true, revision: 'revision-3' });

    const compaction: ConversationCompactionCoverageEvent = {
      eventId: 'coverage-revision',
      conversationId: 'long',
      originNodeId: 'node',
      originSequence: 101,
      timestamp: 3_001,
      lamportClock: 101,
      kind: 'compaction',
      mode: 'coverage-only',
      boundary: {
        version: 2,
        coveredVersion: { node: 6 },
        coveredMessageCountByOrigin: { node: 6 },
        coveredUserTurnCountByOrigin: { node: 3 },
        droppedMessageCount: 6,
        droppedTurnCount: 3,
      },
      summary: null,
    };
    expect(buildConversationTimelinePage(
      [...initialEvents, compaction],
      'long',
      options({ beforeCursor: cursor, expectedRevision: 'revision-3' }),
      'revision-4',
    )).toEqual({ reset: true, revision: 'revision-4' });
  });

  it('includes every visible user/assistant/agent marker and semantic compaction but not hidden/coverage-only rows', () => {
    const hiddenRoot = { ...message(2, 'user'), hidden: true };
    const hiddenTurnAssistant = { ...message(3, 'assistant'), hidden: false };
    const nonRootAgent = { ...message(6, 'agent'), messageId: 'child-agent', turnId: 'm-004' };
    const summary: ConversationCompactionSummaryEvent = {
      eventId: 'summary-event-1',
      conversationId: 'long',
      originNodeId: 'summary-node',
      originSequence: 1,
      timestamp: 1_004,
      lamportClock: 20,
      kind: 'compaction',
      mode: 'summary',
      boundary: {
        version: 2,
        coveredVersion: { a: 8 },
        coveredMessageCountByOrigin: { a: 8 },
        coveredUserTurnCountByOrigin: { a: 3 },
        droppedMessageCount: 8,
        droppedTurnCount: 3,
      },
      summary: { turnId: 'summary-turn-1', content: 'Earlier work summary' },
    };
    const coverageOnly: ConversationCompactionCoverageEvent = {
      eventId: 'coverage-only',
      conversationId: 'long',
      originNodeId: 'summary-node',
      originSequence: 2,
      timestamp: 1_005,
      lamportClock: 21,
      kind: 'compaction',
      mode: 'coverage-only',
      boundary: {
        version: 2,
        coveredVersion: { a: 9 },
        coveredMessageCountByOrigin: { a: 9 },
        coveredUserTurnCountByOrigin: { a: 4 },
        droppedMessageCount: 9,
        droppedTurnCount: 4,
      },
      summary: null,
    };
    const tombstone: ConversationTombstoneEvent = {
      eventId: 'tombstone-m-008',
      conversationId: 'long',
      originNodeId: 'a',
      originSequence: 99,
      timestamp: 2_000,
      lamportClock: 99,
      kind: 'tombstone',
      targetTurnId: 'm-008',
    };
    const page = success(buildConversationTimelinePage(
      [
        messageEvent(message(0, 'user')),
        messageEvent(message(1, 'assistant')),
        messageEvent(hiddenRoot),
        messageEvent(hiddenTurnAssistant),
        messageEvent(message(4, 'user')),
        messageEvent(message(5, 'assistant')),
        messageEvent(nonRootAgent),
        messageEvent(message(8, 'user')),
        messageEvent(message(9, 'assistant')),
        summary,
        coverageOnly,
        tombstone,
      ],
      'long',
      options(),
      REVISION,
    ));

    expect(page.totalMessages).toBe(6);
    expect(page.totalTurns).toBe(2);
    expect(page.totalEntries).toBe(7);
    expect(page.items.map(item => ({
      kind: item.kind,
      entryId: item.entryId,
      entryIndex: item.entryIndex,
      turnIndex: item.turnIndex,
    }))).toEqual([
      { kind: 'message', entryId: 'm-000', entryIndex: 0, turnIndex: 0 },
      { kind: 'message', entryId: 'm-001', entryIndex: 1, turnIndex: 0 },
      { kind: 'message', entryId: 'm-003', entryIndex: 2, turnIndex: undefined },
      { kind: 'message', entryId: 'm-004', entryIndex: 3, turnIndex: 1 },
      { kind: 'message', entryId: 'm-005', entryIndex: 4, turnIndex: 1 },
      { kind: 'message', entryId: 'child-agent', entryIndex: 5, turnIndex: 1 },
      { kind: 'compaction', entryId: 'summary-event-1', entryIndex: 6, turnIndex: 2 },
    ]);
    const compaction = page.items[6];
    expect(compaction).toMatchObject({
      kind: 'compaction',
      summaryPreview: 'Earlier work summary',
      compactedMessageCount: 8,
      compactedTurnCount: 3,
    });
    expect(compaction).not.toHaveProperty('messageId');
    expect(compaction).not.toHaveProperty('turnId');
  });

  it('keeps persisted previews bounded and omits full payload fields', () => {
    const page = success(buildConversationTimelinePage(
      [
        messageEvent({ ...message(0, 'user'), content: 'abcdefgh\nsecond line', toolCalls: [{ id: 'tool', toolName: 'x', arguments: { huge: true } }] }),
        messageEvent({ ...message(1, 'assistant'), content: '12345678\nsecond line', reasoning_content: 'private' }),
      ],
      'long',
      options({ limit: 2, previewLength: 5 }),
      REVISION,
    ));

    expect(page.items).toMatchObject([{
      kind: 'message',
      messageId: 'm-000',
      role: 'user',
      preview: 'abcd…',
    }, {
      kind: 'message',
      messageId: 'm-001',
      role: 'assistant',
      preview: '1234…',
      actorId: 'b',
      actorLabel: 'b',
    }]);
    expect(page.items[0]).not.toHaveProperty('toolCalls');
    expect(page.items[0]).not.toHaveProperty('reasoning_content');
  });

  it('keeps exact markers for every response under the per-entry budget', () => {
    const user = message(0, 'user');
    const responses = Array.from({ length: 6 }, (_, index) =>
      messageEvent({
        ...message(index + 1, 'assistant'),
        turnId: user.messageId,
        content: `${'😀'.repeat(160)} response ${index}`,
        metadata: { actorId: `actor-${index}`, actorLabel: `Actor ${index}` },
      }));
    const page = success(buildConversationTimelinePage(
      [messageEvent(user), ...responses],
      'long',
      options({ limit: 7, previewLength: 160 }),
      REVISION,
    ));
    const entries = page.items.filter(entry => entry.kind === 'message');
    expect(entries.map(item => item.actorId)).toEqual([
      'a',
      'actor-0',
      'actor-1',
      'actor-2',
      'actor-3',
      'actor-4',
      'actor-5',
    ]);
    expect(entries.every(entry => canonicalJsonBytes(entry).byteLength <= 1_024)).toBe(true);
  });

  it('bounds a frozen message marker without mutating its source', () => {
    const source = Object.freeze({
      kind: 'message' as const,
      entryId: 'frozen-message',
      messageId: 'frozen-message',
      turnId: 'frozen-message',
      conversationId: 'long',
      timestamp: 1,
      lamportClock: 1,
      originNodeId: 'node',
      cursor: 'cursor',
      entryIndex: 0,
      turnIndex: 0,
      role: 'user' as const,
      actorId: 'actor'.repeat(100),
      actorLabel: 'Actor'.repeat(100),
      preview: 'u'.repeat(240),
    });
    const bounded = boundConversationTimelineMessageEntry(source);
    expect(bounded).not.toBe(source);
    expect(source.preview).toHaveLength(240);
    expect(canonicalJsonBytes(bounded).byteLength).toBeLessThanOrEqual(1_024);
  });

  it('projects an 8 MiB first line without splitting or retaining the payload', () => {
    const leadingWhitespace = ' \r\n'.repeat(1_024);
    const huge = `${leadingWhitespace}${'x'.repeat(8 * 1_024 * 1_024 - leadingWhitespace.length)}`;
    const page = success(buildConversationTimelinePage(
      [
        messageEvent({ ...message(0, 'user'), content: huge }),
      ],
      'long',
      options({ limit: 1, previewLength: 10 }),
      REVISION,
    ));
    expect(page.items[0]).toMatchObject({ preview: 'xxxxxxxxx…' });
    expect(page.items[0]).not.toHaveProperty('content');
  });

  it('builds only one bounded page from a logical 100k-entry memory event log', () => {
    const events = Array.from({ length: 100_000 }, (_, index): ConversationMessageEvent => {
      const id = `turn-${index}`;
      return {
        eventId: id,
        conversationId: 'long',
        originNodeId: 'node',
        originSequence: index + 1,
        timestamp: index,
        lamportClock: index + 1,
        kind: 'message',
        message: { messageId: id, turnId: id, role: 'user', content: id },
      };
    });
    const page = success(buildConversationTimelinePage(
      events,
      'long',
      options({ limit: 50 }),
      'revision-100k',
    ));
    expect(page.totalEntries).toBe(100_000);
    expect(page.items).toHaveLength(50);
    expect(page.startEntryIndex).toBe(99_950);
  });

  it('measures the final strict canonical response against maxBytes', () => {
    const messages = turnEvents(20).map(event =>
      event.kind === 'message'
        ? { ...event, message: { ...event.message, content: `${event.message.content} ${'x'.repeat(200)}` } }
        : event
    );
    const page = success(buildConversationTimelinePage(
      messages,
      'long',
      options({ limit: 20, maxBytes: 2_000, previewLength: 120 }),
      REVISION,
    ));
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.length).toBeLessThan(20);
    expect(canonicalJsonBytes(page, { maxBytes: 2_000 }).byteLength).toBeLessThanOrEqual(2_000);
    expect(() =>
      buildConversationTimelinePage(
        messages,
        'long',
        options({ limit: 1, maxBytes: 20 }),
        REVISION,
      )
    ).toThrow(/conversation_timeline_(?:entry|page)_exceeds_byte_budget/u);
  });

  it('rejects maxBytes above the fixed 256 KiB protocol ceiling', async () => {
    const storage = { getConversationTimelinePage: vi.fn() } as unknown as ConversationEventStore;
    await expect(readConversationTimelinePage(
      storage,
      'long',
      options({
        maxBytes: 256 * 1024 + 1,
      }),
    )).rejects.toThrow('invalid_conversation_timeline_page_byte_budget');
  });

  it('validates query bounds and forwards AbortSignal with pre/post abort checks', async () => {
    const getConversationTimelinePage = vi.fn();
    const storage = { getConversationTimelinePage } as unknown as ConversationEventStore;
    for (const limit of [0, 51, 1.5, Number.NaN]) {
      await expect(readConversationTimelinePage(storage, 'long', options({ limit })))
        .rejects.toThrow('invalid_conversation_timeline_page_limit');
    }
    await expect(readConversationTimelinePage(
      storage,
      'long',
      options({
        beforeCursor: 'before',
        afterCursor: 'after',
      }),
    )).rejects.toThrow('conversation_timeline_page_cursor_conflict');
    expect(getConversationTimelinePage).not.toHaveBeenCalled();

    const preAbort = new AbortController();
    preAbort.abort();
    await expect(readConversationTimelinePage(storage, 'long', options(), {
      signal: preAbort.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(getConversationTimelinePage).not.toHaveBeenCalled();

    let resolve!: (page: ConversationTimelinePage) => void;
    const pending = new Promise<ConversationTimelinePage>(resolve_ => {
      resolve = resolve_;
    });
    const postAbort = new AbortController();
    const getPendingPage = vi.fn(async () => pending);
    const pendingStorage = { getConversationTimelinePage: getPendingPage } as unknown as ConversationEventStore;
    const reading = readConversationTimelinePage(pendingStorage, 'long', options(), {
      signal: postAbort.signal,
    });
    expect(getPendingPage).toHaveBeenCalledWith('long', options(), { signal: postAbort.signal });
    postAbort.abort();
    resolve(buildConversationTimelinePage(turnEvents(2), 'long', options(), REVISION));
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('has no full fallback and rejects success with a stale expected revision', async () => {
    const getMessages = vi.fn();
    const missing = { getMessages } as unknown as ConversationEventStore;
    await expect(readConversationTimelinePage(missing, 'long', options()))
      .rejects.toThrow('conversation timeline page reader unavailable');
    expect(getMessages).not.toHaveBeenCalled();

    const staleSuccess = buildConversationTimelinePage(turnEvents(2), 'long', options(), REVISION);
    const malformed = {
      getConversationTimelinePage: vi.fn().mockResolvedValue(staleSuccess),
    } as unknown as ConversationEventStore;
    await expect(readConversationTimelinePage(
      malformed,
      'long',
      options({
        expectedRevision: 'expected-newer',
      }),
    )).rejects.toThrow('conversation_timeline_revision_mismatch');
  });
});
