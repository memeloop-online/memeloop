import { describe, expect, it, vi } from 'vitest';

import {
  TUI_WINDOW_HARD_MAX_BYTES,
  TUI_WINDOW_HARD_MAX_MESSAGES,
  type TUIMessagePage,
  type TUIMessagePageRequest,
  TUIMessageWindowController,
  type TUIMessageWindowSource,
} from '../messageWindow.js';
import type { TUIMessage } from '../types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  return { promise, resolve, reject };
}

function message(index: number, conversationId = 'long'): TUIMessage {
  return {
    kind: 'message',
    messageId: `${conversationId}-message-${index}`,
    role: index % 2 === 0 ? 'assistant' : 'user',
    content: `message ${index}`,
    timestamp: new Date(index),
  };
}

function page(
  conversationId: string,
  items: TUIMessage[],
  options: {
    revision?: string;
    hasMoreBefore?: boolean;
    hasMoreAfter?: boolean;
    previousCursor?: string;
    nextCursor?: string;
  } = {},
): TUIMessagePage {
  return {
    reset: false,
    conversationId,
    revision: options.revision ?? `revision-${conversationId}`,
    items,
    hasMoreBefore: options.hasMoreBefore ?? false,
    hasMoreAfter: options.hasMoreAfter ?? false,
    ...(options.previousCursor === undefined ? {} : { previousCursor: options.previousCursor }),
    ...(options.nextCursor === undefined ? {} : { nextCursor: options.nextCursor }),
  };
}

describe('TUIMessageWindowController', () => {
  it('opens a logical 100k conversation with one hard-bounded page request', async () => {
    const getMessagePage = vi.fn(async (
      conversationId: string,
      request: TUIMessagePageRequest,
    ) =>
      page(
        conversationId,
        Array.from({ length: request.limit }, (_, index) => message(99_951 + index)),
        { hasMoreBefore: true, previousCursor: 'opaque-before-99951' },
      )
    );
    const source: TUIMessageWindowSource = { getMessagePage };
    const controller = new TUIMessageWindowController();

    await controller.open(source, 'long');

    expect(getMessagePage).toHaveBeenCalledTimes(1);
    expect(getMessagePage.mock.calls[0]?.[1]).toEqual({
      limit: TUI_WINDOW_HARD_MAX_MESSAGES,
      maxBytes: TUI_WINDOW_HARD_MAX_BYTES,
      direction: 'backward',
    });
    expect(controller.getSnapshot().messages).toHaveLength(50);
    expect(controller.getSnapshot().messages[0]?.messageId).toBe('long-message-99951');
    expect(controller.exportVisibleWindow().length).toBeLessThan(TUI_WINDOW_HARD_MAX_BYTES);
  });

  it('rejects host pages above the UI message limit instead of silently slicing', async () => {
    const controller = new TUIMessageWindowController();
    await controller.open({
      getMessagePage: async conversationId =>
        page(
          conversationId,
          Array.from({ length: 51 }, (_, index) => message(index)),
        ),
    }, 'long');

    expect(controller.getSnapshot().messages).toEqual([]);
    expect(controller.getSnapshot().error?.message).toBe('invalid_tui_message_page');
    expect(() => {
      controller.setInitialMessages(
        Array.from({ length: 51 }, (_, index) => message(index)),
      );
    }).toThrow('tui_message_window_exceeds_message_limit');
  });

  it('pages older/newer within 50 rows and records a pending tail while browsing history', async () => {
    const requests: TUIMessagePageRequest[] = [];
    const source: TUIMessageWindowSource = {
      getMessagePage: async (conversationId, request) => {
        requests.push(request);
        if (request.cursor === undefined) {
          return page(
            conversationId,
            Array.from({ length: 50 }, (_, index) => message(951 + index)),
            { hasMoreBefore: true, previousCursor: 'before-951' },
          );
        }
        if (request.direction === 'backward') {
          return page(
            conversationId,
            Array.from({ length: 50 }, (_, index) => message(901 + index)),
            {
              hasMoreBefore: true,
              hasMoreAfter: true,
              previousCursor: 'before-901',
              nextCursor: 'after-950',
            },
          );
        }
        return page(
          conversationId,
          Array.from({ length: 50 }, (_, index) => message(951 + index)),
          { hasMoreBefore: true, previousCursor: 'before-951' },
        );
      },
    };
    const controller = new TUIMessageWindowController();
    await controller.open(source, 'long');
    await controller.loadOlder();
    expect(controller.getSnapshot().messages).toHaveLength(50);
    expect(controller.getSnapshot().messages[0]?.messageId).toBe('long-message-901');
    expect(controller.getSnapshot().hasMoreAfter).toBe(true);

    controller.appendTail(message(1001));
    expect(controller.getSnapshot().messages.at(-1)?.messageId).toBe('long-message-950');
    expect(controller.getSnapshot().pendingTailCount).toBe(1);
    await controller.loadNewer();

    expect(controller.getSnapshot().messages).toHaveLength(50);
    expect(controller.getSnapshot().messages.at(-1)?.messageId).toBe('long-message-1000');
    expect(controller.getSnapshot().pendingTailCount).toBe(0);
    expect(requests.slice(1)).toEqual([
      {
        limit: 50,
        maxBytes: TUI_WINDOW_HARD_MAX_BYTES,
        direction: 'backward',
        cursor: 'before-951',
        expectedRevision: 'revision-long',
      },
      {
        limit: 50,
        maxBytes: TUI_WINDOW_HARD_MAX_BYTES,
        direction: 'forward',
        cursor: 'after-950',
        expectedRevision: 'revision-long',
      },
    ]);
  });

  it('preserves semantic compaction markers across repeated bounded pages', async () => {
    const marker = (index: number): TUIMessage => ({
      kind: 'compaction',
      messageId: `compaction-${index}`,
      role: 'system',
      content: '',
      timestamp: new Date(index),
      compaction: {
        entryId: `compaction-${index}`,
        summaryPreview: `Summary ${index}`,
        compactedMessageCount: index * 100,
        compactedTurnCount: index * 50,
      },
    });
    const controller = new TUIMessageWindowController();
    await controller.open({
      getMessagePage: async conversationId =>
        page(
          conversationId,
          [marker(1), message(2), marker(3), message(4)],
        ),
    }, 'compacted');

    const markers = controller.getSnapshot().messages.filter(item => item.kind === 'compaction');
    expect(markers).toHaveLength(2);
    expect(markers[0]?.compaction).toMatchObject({
      entryId: 'compaction-1',
      compactedMessageCount: 100,
    });
    expect(markers[0]).not.toHaveProperty('turnId');
    expect(markers[0]).toHaveProperty('messageId', 'compaction-1');
  });

  it('atomically refetches the latest page after a cursor reset', async () => {
    const getMessagePage = vi.fn()
      .mockResolvedValueOnce(page('reset', [message(50, 'reset')], {
        hasMoreBefore: true,
        previousCursor: 'before-50',
      }))
      .mockResolvedValueOnce({
        reset: true,
        conversationId: 'reset',
        revision: 'revision-reset',
      })
      .mockResolvedValueOnce(page('reset', [message(100, 'reset')]));
    const controller = new TUIMessageWindowController();
    await controller.open({ getMessagePage }, 'reset');
    const observed: string[][] = [];
    const unsubscribe = controller.subscribe(snapshot => {
      observed.push(snapshot.messages.map(item => item.messageId));
    });
    observed.length = 0;

    await controller.loadOlder();

    expect(controller.getSnapshot().messages.map(item => item.messageId)).toEqual(['reset-message-100']);
    expect(observed.some(ids => ids.length === 0)).toBe(false);
    unsubscribe();
  });

  it('fences A→B races and propagates external abort without stale overwrite', async () => {
    const pendingA = deferred<TUIMessagePage>();
    const pendingB = deferred<TUIMessagePage>();
    const pendingOlder = deferred<TUIMessagePage>();
    const signals = new Map<string, AbortSignal>();
    const source: TUIMessageWindowSource = {
      getMessagePage: async (conversationId, request, options) => {
        signals.set(`${conversationId}:${request.cursor ?? 'latest'}`, options.signal);
        if (conversationId === 'A') return pendingA.promise;
        if (request.cursor) return pendingOlder.promise;
        return pendingB.promise;
      },
    };
    const controller = new TUIMessageWindowController();
    const openingA = controller.open(source, 'A');
    const openingB = controller.open(source, 'B');
    expect(signals.get('A:latest')?.aborted).toBe(true);
    pendingB.resolve(page('B', [message(100, 'B')], {
      hasMoreBefore: true,
      previousCursor: 'before-B-100',
    }));
    await openingB;
    pendingA.resolve(page('A', [message(1, 'A')]));
    await openingA;
    expect(controller.getSnapshot().conversationId).toBe('B');
    expect(controller.getSnapshot().messages[0]?.messageId).toBe('B-message-100');

    const before = controller.getSnapshot().messages;
    const abort = new AbortController();
    const loading = controller.loadOlder({ signal: abort.signal });
    abort.abort();
    expect(signals.get('B:before-B-100')?.aborted).toBe(true);
    pendingOlder.resolve(page('B', [message(50, 'B')], {
      hasMoreAfter: true,
      nextCursor: 'after-B-50',
    }));
    await loading;
    expect(controller.getSnapshot().messages).toEqual(before);
    expect(controller.getSnapshot().loading).toBe(false);
    expect(controller.getSnapshot().error).toBeUndefined();
  });

  it('rejects oversized detail reads and accepts bounded export-only detail', async () => {
    const source: TUIMessageWindowSource = {
      getMessagePage: async conversationId => page(conversationId, [message(1, conversationId)]),
      getMessageDetail: async (_conversationId, _messageId, options) => 'x'.repeat(options.maxBytes + 1),
    };
    const controller = new TUIMessageWindowController();
    await controller.open(source, 'detail');
    await expect(controller.loadDetail('detail-message-1', { maxBytes: 1024 }))
      .rejects.toThrow('tui_message_detail_exceeds_byte_budget');
    await expect(controller.loadDetail('detail-message-1', { maxBytes: 256 * 1024 + 1 }))
      .rejects.toThrow('invalid_tui_detail_maxBytes');
  });
});
