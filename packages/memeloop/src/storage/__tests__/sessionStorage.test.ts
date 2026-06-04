import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../../protocol/index.js';
import {
  createCheckpointRecord,
  InMemoryCheckpointStore,
  parseCheckpointRecord,
  serializeCheckpointRecord,
  SessionStorage,
} from '../sessionStorage.js';

function createMessage(
  conversationId: string,
  overrides: Partial<ChatMessage> & { id: number | string },
): ChatMessage {
  const id = String(overrides.id);
  return {
    messageId: `${conversationId}:${id}`,
    conversationId,
    originNodeId: 'local',
    timestamp: 1000 + Number(id) * 100,
    lamportClock: Number(id),
    role: 'user',
    content: `Message ${id}`,
    ...overrides,
  } as ChatMessage;
}

describe('checkpoint records', () => {
  it('creates checkpoint metadata from messages', () => {
    const messages = [
      createMessage('conv-1', { id: 1, role: 'user', content: 'Hello' }),
      createMessage('conv-1', { id: 2, role: 'assistant', content: 'Hi there!' }),
    ];

    const record = createCheckpointRecord('conv-1', messages, '2026-01-01T00:00:00.000Z');

    expect(record.conversationId).toBe('conv-1');
    expect(record.messageCount).toBe(2);
    expect(record.messages).toEqual(messages);
    expect(record.savedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(record.lastMessagePreview).toBe('Hi there!');
  });

  it('serializes, parses, and rejects malformed records', () => {
    const record = createCheckpointRecord('conv-1', [createMessage('conv-1', { id: 1 })]);
    expect(parseCheckpointRecord(serializeCheckpointRecord(record))).toEqual(record);
    expect(parseCheckpointRecord('{broken')).toBeNull();
    expect(parseCheckpointRecord(JSON.stringify({ conversationId: 'conv-1' }))).toBeNull();
  });
});

describe('InMemoryCheckpointStore', () => {
  it('saves and loads checkpoints', async () => {
    const store = new InMemoryCheckpointStore();
    const messages = [
      createMessage('conv-2', { id: 1, role: 'user', content: 'Question' }),
      createMessage('conv-2', { id: 2, role: 'assistant', content: 'Answer' }),
    ];

    await store.saveCheckpoint('conv-2', messages);
    const loaded = await store.loadCheckpoint('conv-2');

    expect(loaded).not.toBeNull();
    expect(loaded?.conversationId).toBe('conv-2');
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.messages[0]?.content).toBe('Question');
    expect(loaded?.messages[1]?.content).toBe('Answer');
  });

  it('lists checkpoint summaries newest first', async () => {
    const older = createCheckpointRecord('conv-a', [createMessage('conv-a', { id: 1 })], '2026-01-01T00:00:00.000Z');
    const newer = createCheckpointRecord('conv-b', [createMessage('conv-b', { id: 1 })], '2026-01-02T00:00:00.000Z');
    const store = new InMemoryCheckpointStore({ records: [older, newer] });

    expect(await store.listCheckpoints()).toEqual([
      {
        conversationId: 'conv-b',
        savedAt: '2026-01-02T00:00:00.000Z',
        messageCount: 1,
        lastMessagePreview: 'Message 1',
      },
      {
        conversationId: 'conv-a',
        savedAt: '2026-01-01T00:00:00.000Z',
        messageCount: 1,
        lastMessagePreview: 'Message 1',
      },
    ]);
  });

  it('deletes checkpoints and returns false for missing entries', async () => {
    const store = new SessionStorage();
    await store.saveCheckpoint('conv-del', [createMessage('conv-del', { id: 1 })]);

    expect(await store.deleteCheckpoint('conv-del')).toBe(true);
    expect(await store.loadCheckpoint('conv-del')).toBeNull();
    expect(await store.deleteCheckpoint('conv-del')).toBe(false);
  });
});