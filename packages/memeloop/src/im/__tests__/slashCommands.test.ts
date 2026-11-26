import { describe, expect, it, vi } from 'vitest';

import { createTestStorage } from '../../__tests__/testStorage.js';
import type { MemeLoopRuntime } from '../../runtime.js';
import { IMChannelManager } from '../channelManager.js';
import { tryHandleImSlashCommand } from '../slashCommands.js';

describe('tryHandleImSlashCommand', () => {
  it('handles /list', async () => {
    const storage = createTestStorage(undefined, {
      listConversationsPage: vi.fn().mockResolvedValue({
        reset: false,
        items: [{
          conversationId: 'a:1',
          title: 'T1',
          lastMessagePreview: '',
          lastMessageTimestamp: 1,
          messageCount: 1,
          originNodeId: 'local',
          definitionId: 'd',
          isUserInitiated: true,
        }],
        revision: 'test-list-1',
        total: 1,
        hasMoreBefore: false,
        hasMoreAfter: false,
      }),
    });
    const manager = new IMChannelManager();
    const driver = {
      createAgent: vi.fn(),
      sendMessage: vi.fn(),
    };
    const runtime: MemeLoopRuntime = {
      createAgent: vi.fn(),
      sendMessage: vi.fn(),
      retryTurn: vi.fn(),
      getRunStatus: vi.fn(),
      cancelRun: vi.fn(),
      cancelAgent: vi.fn(),
      waitForCheckpoint: vi.fn(),
      ackCheckpoint: vi.fn(),
      runChildAgent: vi.fn(),
      dispose: vi.fn(),
      subscribeToUpdates: vi.fn(),
    };
    const r = await tryHandleImSlashCommand({
      rawText: '/list',
      channelId: 'c',
      imUserId: 'u',
      manager,
      storage,
      driver,
      runtime,
      defaultDefinitionId: 'memeloop:general-assistant',
    });
    expect(r.handled).toBe(true);
    expect(r.messages.join('\n')).toContain('可切换会话');
  });

  it('ignores non-slash', async () => {
    const r = await tryHandleImSlashCommand({
      rawText: 'hello',
      channelId: 'c',
      imUserId: 'u',
      manager: new IMChannelManager(),
      storage: createTestStorage(undefined, { listConversationsPage: vi.fn() }),
      driver: { createAgent: vi.fn(), sendMessage: vi.fn() },
      runtime: {
        createAgent: vi.fn(),
        sendMessage: vi.fn(),
        retryTurn: vi.fn(),
        getRunStatus: vi.fn(),
        cancelRun: vi.fn(),
        cancelAgent: vi.fn(),
        waitForCheckpoint: vi.fn(),
        ackCheckpoint: vi.fn(),
        runChildAgent: vi.fn(),
        dispose: vi.fn(),
        subscribeToUpdates: vi.fn(),
      },
      defaultDefinitionId: 'memeloop:general-assistant',
    });
    expect(r.handled).toBe(false);
  });
});
