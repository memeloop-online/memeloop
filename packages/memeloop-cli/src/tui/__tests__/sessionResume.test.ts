import type { ChatMessage, ConversationMessagePage, GetMessagePageOptions } from 'memeloop';
import { messageCursor, projectConversationMessageForList } from 'memeloop';
import { describe, expect, it, vi } from 'vitest';

import { resumeSession } from '../../chat/handlers/sessionResume.js';
import type { ChatHookContext } from '../../chat/types.js';
import type { NodeRuntimeResult } from '../../runtime/nodeRuntime.js';
import { createTUIDispatcher } from '../TUIApp.js';
import type { TUIAction } from '../types.js';

function message(index: number): ChatMessage {
  const messageId = `message-${index.toString().padStart(3, '0')}`;
  const content = `message ${index}`;
  return {
    messageId,
    turnId: index % 2 === 0
      ? messageId
      : `message-${(index - 1).toString().padStart(3, '0')}`,
    conversationId: 'session-100k',
    originNodeId: 'test-node',
    originSequence: index + 1,
    timestamp: index,
    lamportClock: index + 1,
    role: index % 2 === 0 ? 'user' : 'assistant',
    parts: [{ type: 'text', text: content }],
    content,
  };
}

describe('session resume TUI integration', () => {
  it('keeps a full 50-row resume page without adding a 51st banner message', async () => {
    const items = Array.from({ length: 50 }, (_, index) => message(index + 50));
    const projectedItems = items.map(item => projectConversationMessageForList(item, 256 * 1024));
    const getMessagePage = vi.fn(async (
      _conversationId: string,
      _options: GetMessagePageOptions,
    ): Promise<ConversationMessagePage> => ({
      reset: false,
      conversationId: 'session-100k',
      revision: 'revision-1',
      items: projectedItems,
      hasMoreBefore: true,
      hasMoreAfter: false,
      startCursor: messageCursor(items[0]),
      endCursor: messageCursor(items.at(-1)!),
    }));
    const listConversationsPage = vi.fn(async () => ({
      reset: false as const,
      revision: 'directory-1',
      total: 1,
      hasMoreBefore: false,
      hasMoreAfter: false,
      items: [{
        conversationId: 'session-100k',
        title: 'Long conversation',
        lastMessagePreview: 'message 99',
        lastMessageTimestamp: 99,
        messageCount: 100_000,
        originNodeId: 'test-node',
        originClock: 100_000,
        definitionId: 'test',
        isUserInitiated: true,
      }],
    }));
    const tui = createTUIDispatcher();
    const actions: TUIAction[] = [];
    tui.setDispatch(action => {
      actions.push(action);
    });
    const context: ChatHookContext = {
      options: { continueLast: true },
      dataDir: '/tmp/memeloop-test',
      tui,
      runtime: {
        storage: { getMessagePage, listConversationsPage },
      } as unknown as NodeRuntimeResult,
      initialMessages: [],
      providerMissingHandled: false,
      providerMissingAction: 'continue',
      messageHandled: false,
    };

    await expect(resumeSession(context)).resolves.toBeUndefined();

    expect(context.initialMessages).toEqual([]);
    expect(tui.getMessages()).toHaveLength(50);
    expect(tui.getMessages()[0]?.messageId).toBe('message-050');
    expect(actions).toContainEqual({
      type: 'SET_STATUS',
      text: 'Resumed: Long conversation (100000 messages)',
    });
    expect(listConversationsPage).toHaveBeenCalledWith({
      limit: 50,
      maxBytes: 256 * 1024,
    }, { signal: undefined });
    expect(getMessagePage).toHaveBeenCalledWith('session-100k', {
      limit: 50,
      maxBytes: 256 * 1024,
    }, { signal: expect.any(AbortSignal) });
  });
});
