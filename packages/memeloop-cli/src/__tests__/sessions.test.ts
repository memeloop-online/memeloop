import { describe, expect, it, vi } from 'vitest';
import type { NodeRuntimeResult } from '../runtime/nodeRuntime.js';
import { deleteSession, listSessions, resumeSession } from '../sessions.js';

function makeRuntime(overrides: Record<string, unknown> = {}): NodeRuntimeResult {
  return {
    storage: {
      listConversations: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue([]),
      cancelAgent: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    },
  } as unknown as NodeRuntimeResult;
}

describe('sessions', () => {
  describe('listSessions', () => {
    it('returns empty array when storage is missing', async () => {
      const runtime = { storage: null } as unknown as NodeRuntimeResult;
      const result = await listSessions(runtime);
      expect(result).toEqual([]);
    });

    it('returns empty when listConversations is not available', async () => {
      const runtime = makeRuntime({ listConversations: undefined });
      const result = await listSessions(runtime);
      expect(result).toEqual([]);
    });

    it('maps conversation metadata to session info', async () => {
      const conversations = [
        {
          conversationId: 'conv-1',
          title: 'Test Session',
          messageCount: 5,
          lastMessageTimestamp: 1700000000000,
          lastMessagePreview: 'Hello world',
        },
      ];
      const runtime = makeRuntime({
        listConversations: vi.fn().mockResolvedValue(conversations),
      });

      const result = await listSessions(runtime);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: 'conv-1',
        title: 'Test Session',
        messageCount: 5,
        lastMessageTimestamp: 1700000000000,
        lastMessagePreview: 'Hello world',
      });
    });

    it('uses conversationId as title when title is missing', async () => {
      const conversations = [
        {
          conversationId: 'abc123-very-long-id',
          messageCount: 0,
          lastMessageTimestamp: 0,
          lastMessagePreview: '',
        },
      ];
      const runtime = makeRuntime({
        listConversations: vi.fn().mockResolvedValue(conversations),
      });

      const result = await listSessions(runtime);

      expect(result[0].title).toBe('abc123-very-');
    });

    it('handles listConversations throwing', async () => {
      const runtime = makeRuntime({
        listConversations: vi.fn().mockRejectedValue(new Error('DB error')),
      });

      const result = await listSessions(runtime);
      expect(result).toEqual([]);
    });
  });

  describe('resumeSession', () => {
    it('returns null when storage is missing', async () => {
      const runtime = { storage: null } as unknown as NodeRuntimeResult;
      const result = await resumeSession(runtime, 'conv-1');
      expect(result).toBeNull();
    });

    it('returns null when no messages found', async () => {
      const runtime = makeRuntime({
        getMessages: vi.fn().mockResolvedValue([]),
      });
      const result = await resumeSession(runtime, 'conv-1');
      expect(result).toBeNull();
    });

    it('returns messages when found', async () => {
      const messages = [
        { messageId: 'm1', role: 'user', content: 'hi' },
        { messageId: 'm2', role: 'assistant', content: 'hello' },
      ];
      const runtime = makeRuntime({
        getMessages: vi.fn().mockResolvedValue(messages),
      });

      const result = await resumeSession(runtime, 'conv-1');

      expect(result).not.toBeNull();
      expect(result!.messages).toHaveLength(2);
      expect(result!.messages[0].content).toBe('hi');
    });

    it('handles getMessages throwing', async () => {
      const runtime = makeRuntime({
        getMessages: vi.fn().mockRejectedValue(new Error('DB error')),
      });

      const result = await resumeSession(runtime, 'conv-1');
      expect(result).toBeNull();
    });
  });

  describe('deleteSession', () => {
    it('returns false when storage is missing', async () => {
      const runtime = { storage: null } as unknown as NodeRuntimeResult;
      const result = await deleteSession(runtime, 'conv-1');
      expect(result).toBe(false);
    });

    it('returns false when cancelAgent is not available', async () => {
      const runtime = makeRuntime({ cancelAgent: undefined });
      const result = await deleteSession(runtime, 'conv-1');
      expect(result).toBe(false);
    });

    it('returns true on successful cancel', async () => {
      const runtime = makeRuntime({
        cancelAgent: vi.fn().mockResolvedValue(undefined),
      });

      const result = await deleteSession(runtime, 'conv-1');
      expect(result).toBe(true);
    });

    it('handles cancelAgent throwing', async () => {
      const runtime = makeRuntime({
        cancelAgent: vi.fn().mockRejectedValue(new Error('DB error')),
      });

      const result = await deleteSession(runtime, 'conv-1');
      expect(result).toBe(false);
    });
  });
});
