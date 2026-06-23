import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ChatMessage } from 'memeloop';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileCheckpointStore } from '../fileCheckpointStore.js';

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

describe('FileCheckpointStore', () => {
  let testDir: string;
  let store: FileCheckpointStore;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memeloop-checkpoint-test-'));
    store = new FileCheckpointStore({ directory: testDir });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('saves and loads checkpoints', async () => {
    const messages = [
      createMessage('conv-1', { id: 1, role: 'user', content: 'Hello' }),
      createMessage('conv-1', { id: 2, role: 'assistant', content: 'Hi there!' }),
    ];

    const record = await store.saveCheckpoint('conv-1', messages);
    const loaded = await store.loadCheckpoint('conv-1');

    expect(record.conversationId).toBe('conv-1');
    expect(record.messageCount).toBe(2);
    expect(loaded?.messages[1]?.content).toBe('Hi there!');
  });

  it('lists checkpoints and skips malformed files', async () => {
    await store.saveCheckpoint('conv-a', [createMessage('conv-a', { id: 1 })]);
    await store.saveCheckpoint('conv-b', [createMessage('conv-b', { id: 1 })]);
    await fs.writeFile(path.join(testDir, 'bad.checkpoint.json'), '{broken', 'utf-8');

    const list = await store.listCheckpoints();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    expect(list.map((entry) => entry.conversationId).sort()).toEqual(['conv-a', 'conv-b']);
  });

  it('sanitizes conversation ids and deletes checkpoints', async () => {
    const dangerousId = 'conv:with/special<>chars?*';
    await store.saveCheckpoint(dangerousId, [createMessage(dangerousId, { id: 1 })]);

    expect(await store.loadCheckpoint(dangerousId)).not.toBeNull();
    expect(await store.deleteCheckpoint(dangerousId)).toBe(true);
    expect(await store.loadCheckpoint(dangerousId)).toBeNull();
    expect(await store.deleteCheckpoint(dangerousId)).toBe(false);
  });
});
