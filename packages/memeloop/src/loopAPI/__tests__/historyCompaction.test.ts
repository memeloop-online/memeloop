import { describe, expect, it, vi } from 'vitest';

import type { ChatMessage, ConversationCompactionEvent, ConversationEvent, ConversationEventDraft } from '../../conversation/index.js';
import { createContextCompactionBoundaryFromCoverage } from '../../conversation/index.js';
import type { ConversationEventStore, ConversationFullContentMessagePage, GetCompactionCandidatePageOptions, GetFullContentMessagePageOptions } from '../../storage/ports.js';
import { BoundedModelContextError, loadBoundedModelContext } from '../agent-tool-loop/boundedModelContext.js';

function message(sequence: number, role: ChatMessage['role'] = sequence % 2 ? 'user' : 'assistant'): ChatMessage {
  const turnSequence = role === 'user' ? sequence : sequence - 1;
  return {
    messageId: `message-${sequence}`,
    turnId: `message-${turnSequence}`,
    conversationId: 'long',
    originNodeId: 'node-a',
    originSequence: sequence,
    timestamp: sequence,
    lamportClock: sequence,
    role,
    content: `content-${sequence}`,
    parts: [{ type: 'text', text: `content-${sequence}` }],
  };
}

function cursor(value: ChatMessage) {
  return {
    timestamp: value.timestamp,
    lamportClock: value.lamportClock,
    originNodeId: value.originNodeId,
    messageId: value.messageId,
  };
}

function boundedStore(source: readonly ChatMessage[]) {
  const appended: ConversationCompactionEvent[] = [];
  let localSequence = source.length + 1;
  const getFullContentMessagePage = vi.fn(async (
    _conversationId: string,
    options: GetFullContentMessagePageOptions,
  ): Promise<ConversationFullContentMessagePage> => {
    let end = source.length;
    if (options.before) {
      end = source.findIndex(item => item.messageId === options.before!.messageId);
      if (end < 0) throw new Error('unknown test cursor');
    }
    const start = Math.max(0, end - options.limit);
    const items = source.slice(start, end);
    return {
      reset: false as const,
      conversationId: 'long',
      revision: 'revision-1',
      items: [...items],
      hasMoreBefore: start > 0,
      hasMoreAfter: end < source.length,
      ...(items[0] ? { startCursor: cursor(items[0]) } : {}),
      ...(items.at(-1) ? { endCursor: cursor(items.at(-1)!) } : {}),
    };
  });
  const getCompactionCandidatePage = vi.fn(async (
    _conversationId: string,
    options: GetCompactionCandidatePageOptions,
  ) => {
    const after = options.afterCoveredVersion['node-a'] ?? 0;
    const beforeTimestamp = options.beforeDisplayCursor?.timestamp ?? Number.POSITIVE_INFINITY;
    const eligible = source.filter(item => item.originSequence > after && item.timestamp < beforeTimestamp);
    const messages = eligible.slice(0, options.maxMessages);
    const last = messages.at(-1);
    return {
      messages: [...messages],
      nextCoveredVersion: last ? { 'node-a': last.originSequence } : { ...options.afterCoveredVersion },
      newlyCoveredMessageCountByOrigin: last ? { 'node-a': messages.length } : {},
      newlyCoveredUserTurnCountByOrigin: last
        ? { 'node-a': messages.filter(item => item.role === 'user').length }
        : {},
      hasMore: eligible.length > messages.length,
    };
  });
  const appendLocalEvent = vi.fn(async (draft: ConversationEventDraft): Promise<ConversationEvent> => {
    const event = {
      ...draft,
      originSequence: localSequence++,
      lamportClock: localSequence,
    } as ConversationEvent;
    if (event.kind === 'compaction') appended.push(event);
    return event;
  });
  const storage = {
    getFullContentMessagePage,
    getCompactionCandidatePage,
    getRetainedCompactionControls: vi.fn(async () => ({
      items: appended.at(-1) === undefined
        ? [] as ConversationCompactionEvent[]
        : [appended.at(-1)!],
      hasMore: false,
      invalidated: false,
    })),
    appendLocalEvent,
  } as unknown as ConversationEventStore;
  return { storage, appended, getFullContentMessagePage, getCompactionCandidatePage, appendLocalEvent };
}

let generatedId = 0;
const baseOptions = {
  conversationId: 'long',
  localNodeId: 'node-local',
  createId: () => `12345678-test-${generatedId++}`,
  now: () => 200_000,
};

describe('bounded model context loading', () => {
  it('compacts a 100k first-install conversation through bounded causal pages', async () => {
    const source = Array.from({ length: 100_000 }, (_, index) => message(index + 1));
    const fixture = boundedStore(source);
    const summarize = vi.fn(async () => 'durable bounded continuation summary');
    const continuation = vi.fn();
    await expect(loadBoundedModelContext({
      ...baseOptions,
      storage: fixture.storage,
      signal: new AbortController().signal,
      summarize,
      onCompactionContinuationNeeded: continuation,
    })).rejects.toMatchObject({
      code: 'CONTEXT_COMPACTION_PENDING',
      progress: {
        processedMessages: 200,
        providerCalls: 4,
        workPages: 6,
      },
    });

    expect(summarize).toHaveBeenCalledTimes(4);
    expect(fixture.appended).toHaveLength(4);
    expect(fixture.appended.at(-1)?.boundary.droppedMessageCount).toBe(200);
    expect(fixture.getCompactionCandidatePage).toHaveBeenCalledTimes(5);
    expect(fixture.getCompactionCandidatePage.mock.calls.every(([, options]) => options.maxMessages === 50 && options.maxBytes === 256 * 1024)).toBe(true);
    expect(fixture.getFullContentMessagePage).toHaveBeenCalledTimes(2);
    expect(continuation).toHaveBeenCalledOnce();
    expect(continuation).toHaveBeenCalledWith(expect.objectContaining({
      checkpointRevision: fixture.appended.at(-1)?.eventId,
      processedMessages: 200,
      providerCalls: 4,
      workPages: 6,
    }));
  }, 30_000);

  it('resumes from each durable slice checkpoint after a failed background attempt', async () => {
    const source = Array.from({ length: 400 }, (_, index) => message(index + 1));
    const fixture = boundedStore(source);
    const summarize = vi.fn(async () => 'durable incremental continuation summary');
    const options = {
      ...baseOptions,
      storage: fixture.storage,
      signal: new AbortController().signal,
      summarize,
      workMode: 'background' as const,
      workBudget: { maxProviderCalls: 4, maxWorkPages: 8 },
    };

    await expect(loadBoundedModelContext(options)).rejects.toMatchObject({
      code: 'CONTEXT_COMPACTION_PENDING',
      progress: { processedMessages: 200 },
    });
    const durableCheckpoint = fixture.appended.at(-1);
    expect(durableCheckpoint?.boundary.droppedMessageCount).toBe(200);

    const failedSummarizer = vi.fn(async () => {
      throw new Error('simulated background worker crash');
    });
    await expect(loadBoundedModelContext({
      ...options,
      summarize: failedSummarizer,
    })).rejects.toEqual(new BoundedModelContextError('CONTEXT_COMPACTION_FAILED'));
    expect(fixture.appended.at(-1)?.eventId).toBe(durableCheckpoint?.eventId);

    const resumed = await loadBoundedModelContext(options);
    expect(resumed.messages.at(-1)?.messageId).toBe('message-400');
    expect(resumed.coverage.coveredVersion['node-a']).toBe(336);
    expect(fixture.appended.at(-1)?.boundary.droppedMessageCount).toBe(336);
    const resumedReads = fixture.getCompactionCandidatePage.mock.calls
      .filter(([, pageOptions]) => pageOptions.afterCoveredVersion['node-a'] === 200);
    // One page was fetched but not summarized when the first slice hit its
    // provider budget; the crash and successful retry re-read only that same
    // uncommitted page, never any of the 200 covered messages.
    expect(resumedReads).toHaveLength(3);
    expect(summarize).toHaveBeenCalledTimes(7);
  });

  it('loads older pages until a >50-message tool-heavy recent turn is complete', async () => {
    const root = message(1, 'user');
    const source = [
      root,
      ...Array.from({ length: 120 }, (_, index) => ({
        ...message(index + 2, 'tool'),
        turnId: root.turnId,
      })),
    ];
    const fixture = boundedStore(source);
    const result = await loadBoundedModelContext({
      ...baseOptions,
      storage: fixture.storage,
      signal: new AbortController().signal,
      recentTurnsToKeep: 1,
      summarize: async () => 'tool heavy turn summary',
    });
    expect(fixture.getFullContentMessagePage).toHaveBeenCalledTimes(3);
    expect(fixture.getFullContentMessagePage.mock.calls.every(([, options]) => options.limit <= 50 && options.maxBytes <= 256 * 1024)).toBe(true);
    expect(result.messages).toHaveLength(121);
    expect(result.messages[0].messageId).toBe(root.messageId);
  });

  it('keeps fewer complete newest turns when the configured recent window is too fat', async () => {
    const source = Array.from({ length: 300 }, (_, index) => {
      const sequence = index + 1;
      const rootSequence = Math.floor(index / 100) * 100 + 1;
      return {
        ...message(sequence, sequence === rootSequence ? 'user' : 'tool'),
        turnId: `message-${rootSequence}`,
      };
    });
    const fixture = boundedStore(source);
    const summarize = vi.fn(async () => 'adaptive recent window summary');
    const result = await loadBoundedModelContext({
      ...baseOptions,
      storage: fixture.storage,
      signal: new AbortController().signal,
      recentTurnsToKeep: 3,
      maxContextMessages: 130,
      summarize,
    });

    expect(result.recentMessageCount).toBe(100);
    expect(result.messages.slice(1).map(item => item.messageId)).toEqual(
      source.slice(200).map(item => item.messageId),
    );
    expect(result.coverage.coveredVersion['node-a']).toBe(200);
    expect(summarize).toHaveBeenCalledTimes(4);
  });

  it('compacts a single turn larger than the resident message ceiling instead of failing forever', async () => {
    const root = message(1, 'user');
    const source = [
      root,
      ...Array.from({ length: 299 }, (_, index) => ({
        ...message(index + 2, 'tool'),
        turnId: root.turnId,
      })),
    ];
    const fixture = boundedStore(source);
    const summarize = vi.fn(async () => 'oversized single turn continuity summary');
    const result = await loadBoundedModelContext({
      ...baseOptions,
      storage: fixture.storage,
      signal: new AbortController().signal,
      recentTurnsToKeep: 1,
      maxContextMessages: 128,
      workMode: 'background',
      workBudget: { maxProviderCalls: 8, maxWorkPages: 10 },
      summarize,
    });

    expect(result.recentMessageCount).toBe(0);
    expect(result.messages).toHaveLength(1);
    expect(result.coverage.coveredVersion['node-a']).toBe(300);
    expect(summarize).toHaveBeenCalledTimes(6);
  });

  it('restarts the bounded recent window when its snapshot revision is invalidated', async () => {
    const source = Array.from({ length: 120 }, (_, index) => message(index + 1));
    const fixture = boundedStore(source);
    const readPage = fixture.getFullContentMessagePage.getMockImplementation();
    if (!readPage) throw new Error('missing bounded page fixture');
    let readCount = 0;
    fixture.getFullContentMessagePage.mockImplementation(async (conversationId, options) => {
      readCount += 1;
      if (readCount === 2) {
        return {
          reset: true,
          conversationId: 'long',
          revision: 'revision-2',
        };
      }
      const result = await readPage(conversationId, options);
      return result.reset ? result : { ...result, revision: readCount > 2 ? 'revision-2' : 'revision-1' };
    });

    const result = await loadBoundedModelContext({
      ...baseOptions,
      storage: fixture.storage,
      signal: new AbortController().signal,
      summarize: async () => 'bounded snapshot summary',
    });

    expect(result.messages.at(-1)?.messageId).toBe('message-120');
    expect(fixture.getFullContentMessagePage).toHaveBeenCalledTimes(4);
    expect(fixture.getFullContentMessagePage.mock.calls[3]?.[1]).toMatchObject({
      expectedRevision: 'revision-2',
    });
  });

  it('fails boundedly when a hostile store continuously invalidates the recent snapshot', async () => {
    const fixture = boundedStore(Array.from({ length: 120 }, (_, index) => message(index + 1)));
    const readPage = fixture.getFullContentMessagePage.getMockImplementation();
    if (!readPage) throw new Error('missing bounded page fixture');
    fixture.getFullContentMessagePage.mockImplementation(async (conversationId, options) =>
      options.before
        ? {
          reset: true,
          conversationId: 'long',
          revision: 'revision-1',
        }
        : readPage(conversationId, options)
    );

    await expect(loadBoundedModelContext({
      ...baseOptions,
      storage: fixture.storage,
      signal: new AbortController().signal,
      summarize: async () => 'must not summarize a mixed snapshot',
    })).rejects.toEqual(new BoundedModelContextError('CONTEXT_COMPACTION_STALLED'));

    expect(fixture.getFullContentMessagePage).toHaveBeenCalledTimes(18);
    expect(fixture.appendLocalEvent).not.toHaveBeenCalled();
  });

  it('projects retained semantic summaries with the bounded uncovered tail only', async () => {
    const source = Array.from({ length: 110 }, (_, index) => message(index + 1));
    const fixture = boundedStore(source);
    const boundary = createContextCompactionBoundaryFromCoverage({
      coveredVersion: { 'node-a': 100 },
      coveredMessageCountByOrigin: { 'node-a': 100 },
      coveredUserTurnCountByOrigin: { 'node-a': 50 },
    });
    const summary: ConversationCompactionEvent = {
      eventId: 'summary-retained',
      conversationId: 'long',
      originNodeId: 'node-summary',
      originSequence: 1,
      lamportClock: 120,
      timestamp: 120,
      kind: 'compaction',
      mode: 'summary',
      boundary,
      summary: { turnId: 'summary-retained', content: 'retained semantic context' },
    };
    fixture.storage.getRetainedCompactionControls = vi.fn(async () => ({
      items: [summary],
      hasMore: false,
      invalidated: false,
    }));
    const result = await loadBoundedModelContext({
      ...baseOptions,
      storage: fixture.storage,
      signal: new AbortController().signal,
      recentTurnsToKeep: 5,
      summarize: async () => 'unused retained summary',
    });
    expect(result.messages.map(item => item.messageId)).toEqual([
      'summary-retained',
      ...source.slice(100).map(item => item.messageId),
    ]);
    expect(fixture.appendLocalEvent).not.toHaveBeenCalled();
  });

  it('reuses the final retained summary after multiple append-only compactions without overlapping coverage', async () => {
    const source = Array.from({ length: 200 }, (_, index) => message(index + 1));
    const first = boundedStore(source);
    const summarize = vi.fn(async (messages: readonly ChatMessage[]) => `summary through ${messages.at(-1)?.messageId ?? 'none'}`);
    const firstResult = await loadBoundedModelContext({
      ...baseOptions,
      storage: first.storage,
      signal: new AbortController().signal,
      summarize,
    });

    expect(first.appended).toHaveLength(3);
    expect(first.appended.map(event => event.boundary.droppedMessageCount)).toEqual([50, 100, 136]);
    expect(first.appended[2].boundary.previousSummaryMessageIds).toEqual([
      first.appended[1].eventId,
    ]);
    expect(firstResult.messages.map(item => item.messageId)).toEqual([
      first.appended[2].eventId,
      ...source.slice(136).map(item => item.messageId),
    ]);

    const reopened = boundedStore(source);
    reopened.storage.getRetainedCompactionControls = vi.fn(async () => ({
      items: [first.appended[2]],
      hasMore: false,
      invalidated: false,
    }));
    const reopenedSummarize = vi.fn(async () => 'must not run');
    const reopenedResult = await loadBoundedModelContext({
      ...baseOptions,
      storage: reopened.storage,
      signal: new AbortController().signal,
      summarize: reopenedSummarize,
    });

    expect(reopenedSummarize).not.toHaveBeenCalled();
    expect(reopened.appendLocalEvent).not.toHaveBeenCalled();
    expect(reopenedResult.coverage).toEqual({
      coveredVersion: { 'node-a': 136 },
      coveredMessageCountByOrigin: { 'node-a': 136 },
      coveredUserTurnCountByOrigin: { 'node-a': 68 },
    });
    expect(reopenedResult.messages.map(item => item.messageId)).toEqual(
      firstResult.messages.map(item => item.messageId),
    );
  });

  it('keeps incomparable summaries from different devices until storage retains a dominating merge', async () => {
    const fixture = boundedStore([]);
    const summaryA: ConversationCompactionEvent = {
      eventId: 'summary-device-a',
      conversationId: 'long',
      originNodeId: 'summary-device-a',
      originSequence: 1,
      lamportClock: 101,
      timestamp: 101,
      kind: 'compaction',
      mode: 'summary',
      boundary: createContextCompactionBoundaryFromCoverage({
        coveredVersion: { 'device-a': 20 },
        coveredMessageCountByOrigin: { 'device-a': 20 },
        coveredUserTurnCountByOrigin: { 'device-a': 10 },
      }),
      summary: { turnId: 'summary-device-a', content: 'semantic context from device A' },
    };
    const summaryB: ConversationCompactionEvent = {
      eventId: 'summary-device-b',
      conversationId: 'long',
      originNodeId: 'summary-device-b',
      originSequence: 1,
      lamportClock: 102,
      timestamp: 102,
      kind: 'compaction',
      mode: 'summary',
      boundary: createContextCompactionBoundaryFromCoverage({
        coveredVersion: { 'device-b': 12 },
        coveredMessageCountByOrigin: { 'device-b': 12 },
        coveredUserTurnCountByOrigin: { 'device-b': 6 },
      }),
      summary: { turnId: 'summary-device-b', content: 'semantic context from device B' },
    };
    fixture.storage.getRetainedCompactionControls = vi.fn(async () => ({
      items: [summaryB, summaryA],
      hasMore: false,
      invalidated: false,
    }));

    const result = await loadBoundedModelContext({
      ...baseOptions,
      storage: fixture.storage,
      signal: new AbortController().signal,
      summarize: async () => 'must not merge an already bounded retained set',
    });

    expect(result.messages.map(item => item.messageId)).toEqual([
      summaryA.eventId,
      summaryB.eventId,
    ]);
    expect(result.coverage).toEqual({
      coveredVersion: { 'device-b': 12, 'device-a': 20 },
      coveredMessageCountByOrigin: { 'device-b': 12, 'device-a': 20 },
      coveredUserTurnCountByOrigin: { 'device-b': 6, 'device-a': 10 },
    });
    expect(result.retainedSummaryCount).toBe(2);
    expect(fixture.appendLocalEvent).not.toHaveBeenCalled();
  });

  it('uses coverage-only controls causally without exposing them as model messages', async () => {
    const source = Array.from({ length: 10 }, (_, index) => message(index + 101));
    const fixture = boundedStore(source);
    const boundary = createContextCompactionBoundaryFromCoverage({
      coveredVersion: { 'hidden-origin': 100 },
      coveredMessageCountByOrigin: { 'hidden-origin': 0 },
      coveredUserTurnCountByOrigin: { 'hidden-origin': 0 },
    });
    const coverageOnly: ConversationCompactionEvent = {
      eventId: 'coverage-only-retained',
      conversationId: 'long',
      originNodeId: 'node-summary',
      originSequence: 1,
      lamportClock: 120,
      timestamp: 120,
      kind: 'compaction',
      mode: 'coverage-only',
      boundary,
      summary: null,
    };
    fixture.storage.getRetainedCompactionControls = vi.fn(async () => ({
      items: [coverageOnly],
      hasMore: false,
      invalidated: false,
    }));

    const result = await loadBoundedModelContext({
      ...baseOptions,
      storage: fixture.storage,
      signal: new AbortController().signal,
      recentTurnsToKeep: 5,
      summarize: async () => 'must not be used',
    });

    expect(result.coverage).toEqual({
      coveredVersion: { 'hidden-origin': 100 },
      coveredMessageCountByOrigin: { 'hidden-origin': 0 },
      coveredUserTurnCountByOrigin: { 'hidden-origin': 0 },
    });
    expect(result.retainedSummaryCount).toBe(0);
    expect(result.messages.map(item => item.messageId)).toEqual(source.map(item => item.messageId));
    expect(result.messages.some(item => item.messageId === coverageOnly.eventId)).toBe(false);
    expect(fixture.appendLocalEvent).not.toHaveBeenCalled();
  });

  it('fails closed without appending when summarization fails or is cancelled', async () => {
    const source = Array.from({ length: 200 }, (_, index) => message(index + 1));
    const failed = boundedStore(source);
    await expect(loadBoundedModelContext({
      ...baseOptions,
      storage: failed.storage,
      signal: new AbortController().signal,
      summarize: async () => {
        throw new Error('provider body must not escape');
      },
    })).rejects.toEqual(new BoundedModelContextError('CONTEXT_COMPACTION_FAILED'));
    expect(failed.appendLocalEvent).not.toHaveBeenCalled();

    const cancelled = boundedStore(source);
    const controller = new AbortController();
    await expect(loadBoundedModelContext({
      ...baseOptions,
      storage: cancelled.storage,
      signal: controller.signal,
      summarize: async () => {
        controller.abort();
        return 'summary completed after cancellation';
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled.appendLocalEvent).not.toHaveBeenCalled();
  });

  it('never advances durable coverage past the last successfully summarized page', async () => {
    const source = Array.from({ length: 200 }, (_, index) => message(index + 1));
    const fixture = boundedStore(source);
    const summarize = vi.fn()
      .mockResolvedValueOnce('first page was semantically summarized')
      .mockRejectedValueOnce(new Error('second page failed'));

    await expect(loadBoundedModelContext({
      ...baseOptions,
      storage: fixture.storage,
      signal: new AbortController().signal,
      summarize,
    })).rejects.toEqual(new BoundedModelContextError('CONTEXT_COMPACTION_FAILED'));

    expect(fixture.appended).toHaveLength(1);
    expect(fixture.appended[0].boundary).toMatchObject({
      coveredVersion: { 'node-a': 50 },
      coveredMessageCountByOrigin: { 'node-a': 50 },
      coveredUserTurnCountByOrigin: { 'node-a': 25 },
      droppedMessageCount: 50,
      droppedTurnCount: 25,
    });
    expect(fixture.appended[0].boundary.coveredVersion['node-a']).toBeLessThan(136);
  });

  it('rejects a page that claims more work without causal advancement', async () => {
    const fixture = boundedStore(Array.from({ length: 200 }, (_, index) => message(index + 1)));
    fixture.getCompactionCandidatePage.mockResolvedValue({
      messages: [],
      nextCoveredVersion: {},
      newlyCoveredMessageCountByOrigin: {},
      newlyCoveredUserTurnCountByOrigin: {},
      hasMore: true,
    });
    await expect(loadBoundedModelContext({
      ...baseOptions,
      storage: fixture.storage,
      signal: new AbortController().signal,
      summarize: async () => 'unused summary text',
    })).rejects.toEqual(new BoundedModelContextError('CONTEXT_COMPACTION_STALLED'));
  });

  it('rejects a storage host that returns more than 50 compaction candidates', async () => {
    const source = Array.from({ length: 200 }, (_, index) => message(index + 1));
    const fixture = boundedStore(source);
    const oversized = source.slice(0, 51);
    fixture.getCompactionCandidatePage.mockResolvedValue({
      messages: oversized,
      nextCoveredVersion: { 'node-a': 51 },
      newlyCoveredMessageCountByOrigin: { 'node-a': 51 },
      newlyCoveredUserTurnCountByOrigin: { 'node-a': 26 },
      hasMore: true,
    });

    await expect(loadBoundedModelContext({
      ...baseOptions,
      storage: fixture.storage,
      signal: new AbortController().signal,
      summarize: async () => 'must not receive an oversized page',
    })).rejects.toEqual(new BoundedModelContextError('CONTEXT_COMPACTION_FAILED'));
    expect(fixture.appendLocalEvent).not.toHaveBeenCalled();
  });

  it('rejects a storage host that returns more than 32 retained controls', async () => {
    const fixture = boundedStore([]);
    const controls = Array.from({ length: 33 }, (_, index): ConversationCompactionEvent => ({
      eventId: `retained-control-${index}`,
      conversationId: 'long',
      originNodeId: `summary-node-${index}`,
      originSequence: 1,
      lamportClock: index + 1,
      timestamp: index + 1,
      kind: 'compaction',
      mode: 'coverage-only',
      boundary: createContextCompactionBoundaryFromCoverage({
        coveredVersion: { [`source-node-${index}`]: 1 },
        coveredMessageCountByOrigin: { [`source-node-${index}`]: 0 },
        coveredUserTurnCountByOrigin: { [`source-node-${index}`]: 0 },
      }),
      summary: null,
    }));
    fixture.storage.getRetainedCompactionControls = vi.fn(async () => ({
      items: controls,
      hasMore: true,
      invalidated: false,
    }));

    await expect(loadBoundedModelContext({
      ...baseOptions,
      storage: fixture.storage,
      signal: new AbortController().signal,
      summarize: async () => 'must not receive oversized retained controls',
    })).rejects.toEqual(new BoundedModelContextError('CONTEXT_COMPACTION_FAILED'));
    expect(fixture.appendLocalEvent).not.toHaveBeenCalled();
  });

  it.each([
    {
      nextCoveredVersion: { 'node-a': 81 },
      newlyCoveredMessageCountByOrigin: { 'node-a': -1 },
      newlyCoveredUserTurnCountByOrigin: {},
    },
    {
      nextCoveredVersion: { 'node-a': 81 },
      newlyCoveredMessageCountByOrigin: { 'node-unknown': 1 },
      newlyCoveredUserTurnCountByOrigin: {},
    },
    {
      nextCoveredVersion: { 'node-a': 81 },
      newlyCoveredMessageCountByOrigin: { 'node-a': 1 },
      newlyCoveredUserTurnCountByOrigin: { 'node-a': 2 },
    },
    {
      nextCoveredVersion: { 'node-a': 81 },
      newlyCoveredMessageCountByOrigin: { 'node-a': 2 },
      newlyCoveredUserTurnCountByOrigin: {},
    },
  ])('fails closed on hostile compaction coverage counts %#', async page => {
    const fixture = boundedStore(Array.from({ length: 200 }, (_, index) => message(index + 1)));
    fixture.getCompactionCandidatePage.mockResolvedValue({
      messages: [message(1)],
      ...page,
      hasMore: false,
    });
    await expect(loadBoundedModelContext({
      ...baseOptions,
      storage: fixture.storage,
      signal: new AbortController().signal,
      summarize: async () => 'unused summary text',
    })).rejects.toEqual(new BoundedModelContextError('CONTEXT_COMPACTION_FAILED'));
    expect(fixture.appendLocalEvent).not.toHaveBeenCalled();
  });

  it('rejects malformed retained coverage before projecting summary text', async () => {
    const fixture = boundedStore(Array.from({ length: 20 }, (_, index) => message(index + 1)));
    const boundary = createContextCompactionBoundaryFromCoverage({
      coveredVersion: { 'node-a': 10 },
      coveredMessageCountByOrigin: { 'node-a': 10 },
      coveredUserTurnCountByOrigin: { 'node-a': 5 },
    });
    const malformed = {
      eventId: 'summary-malformed',
      conversationId: 'long',
      originNodeId: 'node-summary',
      originSequence: 1,
      lamportClock: 21,
      timestamp: 21,
      kind: 'compaction',
      mode: 'summary',
      boundary: {
        ...boundary,
        coveredMessageCountByOrigin: { 'node-a': 11 },
      },
      summary: { turnId: 'summary-malformed', content: 'must never be projected' },
    } as unknown as ConversationCompactionEvent;
    fixture.storage.getRetainedCompactionControls = vi.fn(async () => ({
      items: [malformed],
      hasMore: false,
      invalidated: false,
    }));

    await expect(loadBoundedModelContext({
      ...baseOptions,
      storage: fixture.storage,
      signal: new AbortController().signal,
      summarize: async () => 'unused summary text',
    })).rejects.toEqual(new BoundedModelContextError('CONTEXT_COMPACTION_FAILED'));
    expect(fixture.appendLocalEvent).not.toHaveBeenCalled();
  });
});
