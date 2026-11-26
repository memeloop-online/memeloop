import { projectConversationMessageForList } from 'memeloop';
import type { ChatMessage, ConversationMessageCursor } from 'memeloop';
import { describe, expect, it, vi } from 'vitest';

import type { NodeRuntimeResult } from '../runtime/nodeRuntime.js';
import { deleteSession, listSessions, resumeSession } from '../sessions.js';

function makeRuntime(overrides: Record<string, unknown> = {}): NodeRuntimeResult {
  return {
    storage: {
      listConversationsPage: vi.fn().mockResolvedValue({
        reset: false,
        items: [],
        revision: 'directory-1',
        total: 0,
        hasMoreBefore: false,
        hasMoreAfter: false,
      }),
      getMessagePage: vi.fn().mockResolvedValue({
        reset: false,
        conversationId: 'conv-1',
        revision: 'messages-1',
        items: [],
        hasMoreBefore: false,
        hasMoreAfter: false,
      }),
      cancelAgent: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    },
  } as unknown as NodeRuntimeResult;
}

function message(messageId: string, role: ChatMessage['role']): ChatMessage {
  return {
    messageId,
    turnId: role === 'user' ? messageId : 'm1',
    conversationId: 'conv-1',
    originNodeId: 'node-a',
    originSequence: messageId === 'm1' ? 1 : 2,
    timestamp: messageId === 'm1' ? 1 : 2,
    lamportClock: messageId === 'm1' ? 1 : 2,
    role,
    parts: [{ type: 'text', text: role === 'user' ? 'hi' : 'hello' }],
    content: role === 'user' ? 'hi' : 'hello',
  };
}

function cursor(value: ChatMessage): ConversationMessageCursor {
  return {
    timestamp: value.timestamp,
    lamportClock: value.lamportClock,
    originNodeId: value.originNodeId,
    messageId: value.messageId,
  };
}

describe('sessions', () => {
  it('reads a bounded revisioned session directory page', async () => {
    const listConversationsPage = vi.fn().mockResolvedValue({
      reset: false,
      items: [{
        conversationId: 'conv-1',
        title: 'Test Session',
        messageCount: 5,
        lastMessageTimestamp: 1_700_000_000_000,
        lastMessagePreview: 'Hello world',
        originNodeId: 'node-a',
        originClock: 5,
        definitionId: 'assistant',
        isUserInitiated: true,
      }],
      revision: 'directory-1',
      total: 1,
      hasMoreBefore: false,
      hasMoreAfter: true,
      startCursor: 'start-1',
      endCursor: 'end-1',
    });
    const controller = new AbortController();
    const runtime = makeRuntime({ listConversationsPage });

    const page = await listSessions(runtime, {
      expectedRevision: 'directory-1',
      signal: controller.signal,
    });

    expect(page).toEqual({
      reset: false,
      sessions: [{
        conversationId: 'conv-1',
        title: 'Test Session',
        messageCount: 5,
        lastMessageTimestamp: 1_700_000_000_000,
        lastMessagePreview: 'Hello world',
      }],
      revision: 'directory-1',
      total: 1,
      hasMoreBefore: false,
      hasMoreAfter: true,
      startCursor: 'start-1',
      endCursor: 'end-1',
    });
    expect(listConversationsPage).toHaveBeenCalledWith({
      limit: 50,
      maxBytes: 256 * 1024,
      expectedRevision: 'directory-1',
    }, { signal: controller.signal });
  });

  it('preserves directory reset and fails closed for missing or hostile hosts', async () => {
    await expect(listSessions({ storage: null } as unknown as NodeRuntimeResult)).resolves.toBeNull();
    await expect(listSessions(makeRuntime({ listConversationsPage: undefined }))).resolves.toBeNull();
    await expect(listSessions(
      makeRuntime({
        listConversationsPage: vi.fn().mockResolvedValue({ reset: true, revision: 'directory-2' }),
      }),
      { expectedRevision: 'directory-1' },
    )).resolves.toEqual({
      reset: true,
      revision: 'directory-2',
    });
    await expect(listSessions(makeRuntime({
      listConversationsPage: vi.fn().mockResolvedValue({
        reset: false,
        items: Array.from({ length: 51 }, (_, index) => ({
          conversationId: `c-${index}`,
          title: '',
          messageCount: 0,
          lastMessageTimestamp: index,
          lastMessagePreview: '',
        })),
        revision: 'hostile',
        total: 51,
        hasMoreBefore: false,
        hasMoreAfter: false,
      }),
    }))).resolves.toBeNull();
  });

  it('propagates directory cancellation instead of disguising it as empty data', async () => {
    const controller = new AbortController();
    const listConversationsPage = vi.fn((_: unknown, options: { signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const reason = options.signal?.reason;
          reject(reason instanceof Error ? reason : new Error(String(reason ?? 'aborted')));
        }, { once: true });
      })
    );
    const pending = listSessions(makeRuntime({ listConversationsPage }), { signal: controller.signal });
    controller.abort(new Error('directory-cancelled'));
    await expect(pending).rejects.toThrow('directory-cancelled');
  });

  it('resumes one bounded revisioned message page', async () => {
    const messages = [message('m1', 'user'), message('m2', 'assistant')];
    const projectedMessages = messages.map(item => projectConversationMessageForList(item, 256 * 1024));
    const getMessagePage = vi.fn().mockResolvedValue({
      reset: false,
      conversationId: 'conv-1',
      revision: 'messages-1',
      items: projectedMessages,
      hasMoreBefore: true,
      hasMoreAfter: false,
      startCursor: cursor(messages[0]),
      endCursor: cursor(messages[1]),
    });
    const controller = new AbortController();
    const page = await resumeSession(makeRuntime({ getMessagePage }), 'conv-1', {
      expectedRevision: 'messages-1',
      signal: controller.signal,
    });

    expect(page).toMatchObject({
      reset: false,
      messages: projectedMessages,
      conversationId: 'conv-1',
      revision: 'messages-1',
      hasMoreBefore: true,
      hasMoreAfter: false,
    });
    expect(getMessagePage).toHaveBeenCalledWith('conv-1', {
      limit: 50,
      maxBytes: 256 * 1024,
      expectedRevision: 'messages-1',
    }, { signal: controller.signal });
  });

  it('preserves message reset and rejects empty, missing, or invalid pages', async () => {
    await expect(resumeSession({ storage: null } as unknown as NodeRuntimeResult, 'conv-1'))
      .resolves.toBeNull();
    await expect(resumeSession(makeRuntime({ getMessagePage: undefined }), 'conv-1'))
      .resolves.toBeNull();
    await expect(resumeSession(makeRuntime(), '')).resolves.toBeNull();
    await expect(resumeSession(makeRuntime(), 'conv-1')).resolves.toBeNull();
    await expect(resumeSession(
      makeRuntime({
        getMessagePage: vi.fn().mockResolvedValue({
          reset: true,
          conversationId: 'conv-1',
          revision: 'messages-2',
        }),
      }),
      'conv-1',
      { expectedRevision: 'messages-1' },
    )).resolves.toEqual({
      reset: true,
      conversationId: 'conv-1',
      revision: 'messages-2',
    });
  });

  it('deletes sessions only through an explicit host operation', async () => {
    await expect(deleteSession({ storage: null } as unknown as NodeRuntimeResult, 'conv-1'))
      .resolves.toBe(false);
    await expect(deleteSession(makeRuntime({ cancelAgent: undefined }), 'conv-1'))
      .resolves.toBe(false);
    await expect(deleteSession(makeRuntime(), 'conv-1')).resolves.toBe(true);
    await expect(deleteSession(
      makeRuntime({
        cancelAgent: vi.fn().mockRejectedValue(new Error('DB error')),
      }),
      'conv-1',
    )).resolves.toBe(false);
  });
});
