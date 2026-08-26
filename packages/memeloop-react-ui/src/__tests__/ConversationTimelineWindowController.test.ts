import { describe, expect, it, vi } from 'vitest';

import { ConversationTimelineWindowController, validateConversationTimelineResult } from '../chat/ConversationTimelineWindowController.js';
import type { MemeLoopConversationTimelinePage, MemeLoopTimelineEntry } from '../chat/coreTypes.js';
import { MEMELOOP_TIMELINE_PAGE_LIMIT, MEMELOOP_TIMELINE_PAGE_MAX_BYTES } from '../chat/timelineSampling.js';

function entry(index: number): MemeLoopTimelineEntry {
  return {
    kind: 'turn',
    entryId: `m-${index}`,
    messageId: `m-${index}`,
    turnId: `m-${index}`,
    conversationId: 'conversation',
    cursor: `c-${index}`,
    timestamp: index,
    lamportClock: index,
    originNodeId: 'node',
    entryIndex: index,
    turnIndex: index,
    userPreview: `prompt ${index}`,
    participantPreviews: [{ actorId: 'assistant', actorLabel: 'Assistant', role: 'assistant', preview: `reply ${index}` }],
    responseCount: 1,
  };
}

function page(start = 0, count = 50, revision = 'r1'): MemeLoopConversationTimelinePage {
  return {
    reset: false,
    items: Array.from({ length: count }, (_, index) => entry(start + index)),
    revision,
    totalMessages: 200_000,
    totalTurns: 100_000,
    totalEntries: 100_000,
    hasMoreBefore: start > 0,
    hasMoreAfter: start + count < 100_000,
    startEntryIndex: start,
    endEntryIndex: start + count - 1,
    startCursor: `c-${start}`,
    endCursor: `c-${start + count - 1}`,
  };
}

async function eventually(assertion: () => void): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    try {
      assertion();
      return;
    } catch {
      await Promise.resolve();
    }
  }
  assertion();
}

describe('ConversationTimelineWindowController', () => {
  it('always requests a single fixed bounded page', async () => {
    const getPage = vi.fn().mockResolvedValue(page(99_950));
    const controller = new ConversationTimelineWindowController({ getPage });
    controller.start('conversation');
    await eventually(() => {
      expect(controller.getSnapshot().loading).toBe(false);
    });
    expect(getPage).toHaveBeenCalledWith({ conversationId: 'conversation', limit: MEMELOOP_TIMELINE_PAGE_LIMIT, maxBytes: MEMELOOP_TIMELINE_PAGE_MAX_BYTES }, {
      signal: expect.any(AbortSignal),
    });
    expect(controller.getSnapshot().page?.items).toHaveLength(50);
  });

  it('keeps the historical page visible and recovers a stale after cursor by absolute index', async () => {
    const getPage = vi.fn()
      .mockResolvedValueOnce(page(50, 50, 'r1'))
      .mockResolvedValueOnce({ reset: true, revision: 'r2' })
      .mockResolvedValueOnce(page(100, 50, 'r2'));
    const controller = new ConversationTimelineWindowController({ getPage });
    const snapshots: Array<string | undefined> = [];
    controller.subscribe(() => snapshots.push(controller.getSnapshot().page?.revision));
    controller.start('conversation');
    await eventually(() => {
      expect(controller.getSnapshot().page?.revision).toBe('r1');
    });
    snapshots.length = 0;
    await controller.loadAfter('c-99', 'r1');
    expect(snapshots).not.toContain(undefined);
    expect(controller.getSnapshot().page?.revision).toBe('r2');
    expect(getPage.mock.calls[1][0]).toMatchObject({ afterCursor: 'c-99', expectedRevision: 'r1' });
    expect(getPage.mock.calls[2][0]).toMatchObject({ aroundEntryIndex: 124, expectedRevision: 'r2' });
  });

  it('preserves a 50,000 absolute around target across a revision reset', async () => {
    const getPage = vi.fn()
      .mockResolvedValueOnce(page(49_975, 50, 'r1'))
      .mockResolvedValueOnce({ reset: true, revision: 'r2' })
      .mockResolvedValueOnce(page(49_975, 50, 'r2'));
    const controller = new ConversationTimelineWindowController({ getPage });
    controller.start('conversation');
    await eventually(() => {
      expect(controller.getSnapshot().page?.revision).toBe('r1');
    });

    await controller.loadAround(50_000, 'r1');
    expect(getPage.mock.calls[2]?.[0]).toMatchObject({ aroundEntryIndex: 50_000, expectedRevision: 'r2' });
    expect(controller.getSnapshot().page?.startEntryIndex).toBe(49_975);
  });

  it('recovers a stale before cursor without jumping to the live tail', async () => {
    const getPage = vi.fn()
      .mockResolvedValueOnce(page(50_000, 50, 'r1'))
      .mockResolvedValueOnce({ reset: true, revision: 'r2' })
      .mockResolvedValueOnce(page(49_950, 50, 'r2'));
    const controller = new ConversationTimelineWindowController({ getPage });
    controller.start('conversation');
    await eventually(() => {
      expect(controller.getSnapshot().page?.revision).toBe('r1');
    });

    await controller.loadBefore('c-50000', 'r1');
    expect(getPage.mock.calls[2]?.[0]).toMatchObject({ aroundEntryIndex: 49_975, expectedRevision: 'r2' });
    expect(controller.getSnapshot().page?.startEntryIndex).toBe(49_950);
  });

  it('bounds repeated reset recovery and leaves the rollback page visible with an error', async () => {
    const getPage = vi.fn()
      .mockResolvedValueOnce(page(50_000, 50, 'r1'))
      .mockResolvedValueOnce({ reset: true, revision: 'r2' })
      .mockResolvedValueOnce({ reset: true, revision: 'r3' });
    const controller = new ConversationTimelineWindowController({ getPage });
    controller.start('conversation');
    await eventually(() => {
      expect(controller.getSnapshot().page?.revision).toBe('r1');
    });

    await controller.loadAround(50_000, 'r1');
    expect(getPage).toHaveBeenCalledTimes(3);
    expect(controller.getSnapshot().page?.revision).toBe('r1');
    expect(controller.getSnapshot().loading).toBe(false);
    expect(controller.getSnapshot().error).toBeInstanceOf(Error);
  });

  it('aborts a delayed A generation and rejects an oversized 64-entry transport page', async () => {
    let resolveA: ((value: MemeLoopConversationTimelinePage) => void) | undefined;
    let signalA: AbortSignal | undefined;
    const getPage = vi.fn().mockImplementation((request, options) => {
      if (request.conversationId === 'A') {
        signalA = options.signal;
        return new Promise(resolve => {
          resolveA = resolve;
        });
      }
      return Promise.resolve({ ...page(0, 50), items: Array.from({ length: 64 }, (_, index) => ({ ...entry(index), conversationId: 'B' })) });
    });
    const controller = new ConversationTimelineWindowController({ getPage });
    controller.start('A');
    controller.start('B');
    expect(signalA?.aborted).toBe(true);
    resolveA?.(page(0));
    await eventually(() => {
      expect(controller.getSnapshot().loading).toBe(false);
    });
    expect(controller.getSnapshot().conversationId).toBe('B');
    expect(controller.getSnapshot().page).toBeUndefined();
    expect(controller.getSnapshot().error).toBeInstanceOf(RangeError);
  });

  it('threads external cancellation to transport and restores the previous page without a stale commit', async () => {
    let resolveNavigation!: (value: MemeLoopConversationTimelinePage) => void;
    let navigationSignal: AbortSignal | undefined;
    const getPage = vi.fn()
      .mockResolvedValueOnce(page(0))
      .mockImplementationOnce((_request, options) => {
        navigationSignal = options.signal;
        return new Promise<MemeLoopConversationTimelinePage>(resolve => {
          resolveNavigation = resolve;
        });
      });
    const controller = new ConversationTimelineWindowController({ getPage });
    controller.start('conversation');
    await eventually(() => {
      expect(controller.getSnapshot().page?.revision).toBe('r1');
    });
    const previous = controller.getSnapshot();
    const external = new AbortController();
    const operation = controller.loadAfter('c-49', 'r1', external.signal);
    external.abort();

    expect(navigationSignal?.aborted).toBe(true);
    expect(controller.getSnapshot()).toBe(previous);
    resolveNavigation(page(50, 50, 'r1'));
    await operation;
    expect(controller.getSnapshot()).toBe(previous);
  });

  it('isolates throwing subscribers from state transitions and other listeners', async () => {
    const onListenerError = vi.fn();
    const healthy = vi.fn();
    const controller = new ConversationTimelineWindowController(
      { getPage: vi.fn().mockResolvedValue(page()) },
      { onListenerError },
    );
    controller.subscribe(() => {
      throw new Error('listener failed');
    });
    controller.subscribe(healthy);
    controller.start('conversation');
    await eventually(() => {
      expect(controller.getSnapshot().loading).toBe(false);
    });

    expect(controller.getSnapshot().page?.items).toHaveLength(50);
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(onListenerError).toHaveBeenCalledTimes(2);
  });

  it('accepts an exact turn-entry byte budget and rejects max+1 without invoking accessors', () => {
    const participants = (characters: number) =>
      Array.from({ length: 4 }, (_, index) => ({
        actorId: `agent-${index}`,
        actorLabel: `Agent ${index}`,
        role: 'agent' as const,
        preview: 'x'.repeat(characters),
      }));
    const base = { ...page(0, 1), items: [{ ...entry(0), userPreview: '', participantPreviews: participants(0), responseCount: 4 }] };
    let low = 0;
    let high = 160;
    while (low + 1 < high) {
      const middle = Math.ceil((low + high) / 2);
      try {
        validateConversationTimelineResult({ ...base, items: [{ ...base.items[0], participantPreviews: participants(middle) }] }, 'conversation');
        low = middle;
      } catch {
        high = middle;
      }
    }
    const exact = { ...base, items: [{ ...base.items[0], participantPreviews: participants(low) }] };
    expect(() => validateConversationTimelineResult(exact, 'conversation')).not.toThrow();
    expect(() =>
      validateConversationTimelineResult({
        ...base,
        items: [{ ...base.items[0], participantPreviews: participants(low + 1) }],
      }, 'conversation')
    ).toThrow(RangeError);

    let getterCalls = 0;
    const hostile = { ...base } as Record<string, unknown>;
    Object.defineProperty(hostile, 'items', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return [];
      },
    });
    expect(() => validateConversationTimelineResult(hostile, 'conversation')).toThrow(TypeError);
    expect(getterCalls).toBe(0);

    const hostileItems: unknown[] = [];
    Object.defineProperty(hostileItems, 0, {
      enumerable: true,
      get() {
        getterCalls += 1;
        return entry(0);
      },
    });
    hostileItems.length = 1;
    expect(() => validateConversationTimelineResult({ ...page(0, 1), items: hostileItems }, 'conversation')).toThrow(TypeError);
    expect(getterCalls).toBe(0);

    const sparseItems: unknown[] = [];
    sparseItems.length = 1;
    expect(() => validateConversationTimelineResult({ ...page(0, 1), items: sparseItems }, 'conversation')).toThrow(TypeError);
  });

  it('strictly bounds multi-agent participant samples without invoking accessors', () => {
    const participant = { actorId: 'agent', actorLabel: 'Agent', role: 'agent' as const, preview: 'result' };
    expect(() =>
      validateConversationTimelineResult({
        ...page(0, 1),
        items: [{ ...entry(0), participantPreviews: Array.from({ length: 5 }, () => participant), responseCount: 5 }],
      }, 'conversation')
    ).toThrow(RangeError);
    expect(() =>
      validateConversationTimelineResult({
        ...page(0, 1),
        items: [{ ...entry(0), participantPreviews: [{ ...participant, preview: 'x'.repeat(161) }], responseCount: 1 }],
      }, 'conversation')
    ).toThrow(RangeError);
    expect(() =>
      validateConversationTimelineResult({
        ...page(0, 1),
        items: [{ ...entry(0), participantPreviews: [participant, participant], responseCount: 1 }],
      }, 'conversation')
    ).toThrow(TypeError);

    let getterCalls = 0;
    const hostile = { ...participant };
    Object.defineProperty(hostile, 'preview', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'forged';
      },
    });
    expect(() =>
      validateConversationTimelineResult({
        ...page(0, 1),
        items: [{ ...entry(0), participantPreviews: [hostile], responseCount: 1 }],
      }, 'conversation')
    ).toThrow(TypeError);
    expect(getterCalls).toBe(0);
  });

  it('rejects forged cursor identity and non-monotonic indexes before commit', () => {
    const duplicateCursor = {
      ...page(0, 2),
      items: [{ ...entry(0), cursor: 'same' }, { ...entry(1), cursor: 'same' }],
      startCursor: 'same',
      endCursor: 'same',
    };
    expect(() => validateConversationTimelineResult(duplicateCursor, 'conversation')).toThrow(TypeError);
    const nonMonotonic = {
      ...page(0, 2),
      items: [{ ...entry(1), entryIndex: 2 }, { ...entry(0), entryIndex: 1 }],
      startEntryIndex: 2,
      endEntryIndex: 1,
    };
    expect(() => validateConversationTimelineResult(nonMonotonic, 'conversation')).toThrow(TypeError);
  });

  it('rejects unexpected keys, unsafe indexes, missing bounds and invalid Unicode', () => {
    expect(() => validateConversationTimelineResult({ reset: true, revision: 'r1', extra: 'forged' }, 'conversation')).toThrow(TypeError);
    expect(() => validateConversationTimelineResult({ ...page(0, 1), extra: 'forged' }, 'conversation')).toThrow(TypeError);
    expect(() =>
      validateConversationTimelineResult({
        ...page(0, 1),
        items: [{ ...entry(0), extra: 'forged' }],
      }, 'conversation')
    ).toThrow(TypeError);
    expect(() =>
      validateConversationTimelineResult({
        ...page(0, 1),
        items: [{ ...entry(0), timestamp: Number.MAX_SAFE_INTEGER + 1 }],
      }, 'conversation')
    ).toThrow(TypeError);
    expect(() =>
      validateConversationTimelineResult({
        ...page(0, 1),
        items: [{ ...entry(0), userPreview: '\uD800' }],
      }, 'conversation')
    ).toThrow(TypeError);
    const missingContinuation = { ...page(0, 1) } as Record<string, unknown>;
    delete missingContinuation.hasMoreBefore;
    expect(() => validateConversationTimelineResult(missingContinuation, 'conversation')).toThrow(TypeError);
    expect(() =>
      validateConversationTimelineResult({
        reset: false,
        revision: 'r1',
        items: [],
        totalMessages: 1,
        totalTurns: 1,
        totalEntries: 1,
        hasMoreBefore: false,
        hasMoreAfter: true,
      }, 'conversation')
    ).toThrow(TypeError);
  });

  it('freezes snapshots and refuses pre-aborted or invalid navigation before transport', async () => {
    const getPage = vi.fn().mockResolvedValue(page());
    const controller = new ConversationTimelineWindowController({ getPage });
    expect(() => {
      controller.start(' conversation ');
    }).toThrow(TypeError);
    controller.start('conversation');
    await eventually(() => {
      expect(controller.getSnapshot().loading).toBe(false);
    });
    const snapshot = controller.getSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.page)).toBe(true);
    expect(Object.isFrozen(snapshot.page?.items)).toBe(true);
    const aborted = new AbortController();
    aborted.abort();
    await controller.loadAfter('c-49', 'r1', aborted.signal);
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(() => controller.loadAround(-1, 'r1')).toThrow(RangeError);
    expect(() => controller.loadBefore(' cursor ', 'r1')).toThrow(TypeError);
  });

  it('coalesces revision refresh and preserves an absolute historical anchor', async () => {
    let resolveRefresh!: (value: MemeLoopConversationTimelinePage) => void;
    const getPage = vi.fn()
      .mockResolvedValueOnce(page(0, 50, 'r1'))
      .mockImplementationOnce(() =>
        new Promise<MemeLoopConversationTimelinePage>(resolve => {
          resolveRefresh = resolve;
        })
      );
    const controller = new ConversationTimelineWindowController({ getPage });
    controller.start('conversation');
    await eventually(() => {
      expect(controller.getSnapshot().page?.revision).toBe('r1');
    });
    const first = controller.refreshForRevision('r2', 25);
    const duplicate = controller.refreshForRevision('r2', 25);
    expect(getPage).toHaveBeenCalledTimes(2);
    expect(getPage.mock.calls[1]?.[0]).toMatchObject({ conversationId: 'conversation', aroundEntryIndex: 25, limit: 50, maxBytes: 256 * 1024 });
    await duplicate;
    resolveRefresh(page(20, 50, 'r2'));
    await first;
    expect(controller.getSnapshot().page?.revision).toBe('r2');
  });
});
