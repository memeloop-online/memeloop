import type { ChatMessage, ConversationMessagePage, GetMessagePageOptions } from 'memeloop';
import { canonicalJsonString, messageCursor, projectConversationMessageForList } from 'memeloop';
import { describe, expect, it, vi } from 'vitest';

import { TUI_WINDOW_HARD_MAX_BYTES, TUIMessageWindowController } from '../messageWindow.js';
import { createStorageTUIMessageWindowSource } from '../storageMessageWindowSource.js';

function message(index: number): ChatMessage {
  const messageId = `message-${index.toString().padStart(6, '0')}`;
  const content = `message ${index}`;
  return {
    messageId,
    turnId: index % 2 === 0
      ? messageId
      : `message-${(index - 1).toString().padStart(6, '0')}`,
    conversationId: 'long',
    originNodeId: 'test-node',
    originSequence: index + 1,
    timestamp: index,
    lamportClock: index + 1,
    role: index % 2 === 0 ? 'user' : 'assistant',
    parts: [{ type: 'text', text: content }],
    content,
  };
}

function page(
  items: ChatMessage[],
  revision: string,
  hasMoreBefore: boolean,
  hasMoreAfter: boolean,
): ConversationMessagePage {
  return {
    reset: false,
    conversationId: 'long',
    revision,
    items: items.map(item => projectConversationMessageForList(item, TUI_WINDOW_HARD_MAX_BYTES)),
    hasMoreBefore,
    hasMoreAfter,
    ...(items[0] === undefined ? {} : { startCursor: messageCursor(items[0]) }),
    ...(items.at(-1) === undefined ? {} : { endCursor: messageCursor(items.at(-1)!) }),
  };
}

describe('createStorageTUIMessageWindowSource', () => {
  it('uses host keyset pages and atomically resets to the latest revision', async () => {
    const getMessagePage = vi.fn(async (
      _conversationId: string,
      options: GetMessagePageOptions,
    ): Promise<ConversationMessagePage> => {
      if (options.expectedRevision === 'revision-1' && options.after !== undefined) {
        return { reset: true, conversationId: 'long', revision: 'revision-2' };
      }
      if (options.before !== undefined) {
        return page(Array.from({ length: 50 }, (_, index) => message(index + 1)), 'revision-1', false, true);
      }
      if (getMessagePage.mock.calls.length >= 3) {
        return page(Array.from({ length: 50 }, (_, index) => message(index + 151)), 'revision-2', true, false);
      }
      return page(Array.from({ length: 50 }, (_, index) => message(index + 51)), 'revision-1', true, false);
    });
    const source = createStorageTUIMessageWindowSource({ getMessagePage });
    const controller = new TUIMessageWindowController();

    await controller.open(source, 'long');
    await controller.loadOlder();
    expect(controller.getSnapshot().messages).toHaveLength(50);
    expect(controller.getSnapshot().messages[0]?.messageId).toBe('message-000001');
    await controller.loadNewer();

    expect(controller.getSnapshot().revision).toBe('revision-2');
    expect(controller.getSnapshot().messages[0]?.messageId).toBe('message-000151');
    expect(getMessagePage).toHaveBeenCalledTimes(4);
    expect(getMessagePage.mock.calls[0]?.[1]).toMatchObject({
      limit: 50,
      maxBytes: TUI_WINDOW_HARD_MAX_BYTES,
    });
    expect(getMessagePage.mock.calls[1]?.[1]).toMatchObject({
      before: messageCursor(message(51)),
      expectedRevision: 'revision-1',
    });
    expect(getMessagePage.mock.calls[2]?.[1]).toMatchObject({
      after: messageCursor(message(50)),
      expectedRevision: 'revision-1',
    });
    expect(getMessagePage.mock.calls[3]?.[1]).not.toHaveProperty('expectedRevision');
  });

  it('jumps atomically to a real compaction anchor and bounds point detail', async () => {
    const initial = [message(100)];
    const getMessagePage = vi.fn(async (): Promise<ConversationMessagePage> => page(initial, 'revision-1', true, false));
    const getMessageWindowAround = vi.fn(async () => ({
      reset: false as const,
      conversationId: 'long',
      revision: 'revision-1',
      focus: {
        kind: 'compaction' as const,
        entry: {
          kind: 'compaction' as const,
          entryId: 'compaction-7',
          conversationId: 'long',
          timestamp: 75,
          lamportClock: 75,
          originNodeId: 'test-node',
          cursor: 'timeline-compaction-7',
          entryIndex: 7,
          turnIndex: 6,
          summaryPreview: 'Six earlier turns summarized',
          compactedMessageCount: 12,
          compactedTurnCount: 6,
        },
        nearestPosition: 'after' as const,
        nearestMessageId: 'message-000076',
        nearestTurnId: 'message-000076',
      },
      recenterAnchor: {
        messageId: 'message-000076',
        turnId: 'message-000076',
      },
      items: [message(76), message(77)].map(item => projectConversationMessageForList(item, TUI_WINDOW_HARD_MAX_BYTES)),
      hasMoreBefore: true,
      hasMoreAfter: true,
      startCursor: messageCursor(message(76)),
      endCursor: messageCursor(message(77)),
    }));
    const fullContent = {
      ...message(77),
      content: 'detail '.repeat(100_000),
    };
    const canonical = new TextEncoder().encode(canonicalJsonString(fullContent));
    const readMessageDetailRange = vi.fn(async (
      _conversationId: string,
      _messageId: string,
      _offset: number,
      maxBytes: number,
    ) => ({
      found: true as const,
      offset: 0,
      totalBytes: canonical.byteLength,
      bytes: canonical.slice(0, maxBytes),
    }));
    const controller = new TUIMessageWindowController();
    await controller.open(
      createStorageTUIMessageWindowSource({
        getMessagePage,
        getMessageWindowAround,
        readMessageDetailRange,
      }),
      'long',
    );

    await controller.jumpTo({
      kind: 'timeline-entry',
      entryId: 'compaction-7',
      cursor: 'timeline-compaction-7',
    });

    expect(controller.getSnapshot().messages).toHaveLength(2);
    expect(controller.getSnapshot().semanticAnchor?.compaction).toMatchObject({
      entryId: 'compaction-7',
      compactedTurnCount: 6,
    });
    expect(getMessageWindowAround).toHaveBeenCalledWith(
      'long',
      expect.objectContaining({
        maxMessages: 50,
        maxBytes: TUI_WINDOW_HARD_MAX_BYTES,
        expectedRevision: 'revision-1',
      }),
      { signal: expect.any(AbortSignal) },
    );
    controller.appendTail({
      messageId: 'live-tail',
      role: 'assistant',
      content: 'new tail',
      timestamp: new Date(101),
    });
    expect(controller.getSnapshot().pendingTailCount).toBe(1);

    const detail = await controller.loadDetail('message-000077', { maxBytes: 1024 });
    expect(new TextEncoder().encode(detail).byteLength).toBeLessThanOrEqual(1024);
    expect(detail).toContain('[detail omitted]');
    expect(controller.exportVisibleWindow()).toContain('compaction-7');
    expect(readMessageDetailRange).toHaveBeenCalledWith(
      'long',
      'message-000077',
      0,
      1024,
      { signal: expect.any(AbortSignal) },
    );
  });
});
