import { describe, expect, it, vi } from 'vitest';

import type { MemeLoopRuntime } from '../../runtime.js';
import type { IAgentStorage } from '../../storage/interface.js';
import { IMChannelManager } from '../channelManager.js';
import { tryHandleImSlashCommand } from '../slashCommands.js';

describe('tryHandleImSlashCommand', () => {
  it('handles /list', async () => {
    const storage = {
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
    } as unknown as IAgentStorage;
    const manager = new IMChannelManager();
    const driver = {
      createAgent: vi.fn(),
      sendMessage: vi.fn(),
    };
    const runtime = { cancelAgent: vi.fn() } as unknown as MemeLoopRuntime;
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
      storage: { listConversationsPage: vi.fn() } as unknown as IAgentStorage,
      driver: { createAgent: vi.fn(), sendMessage: vi.fn() },
      runtime: { cancelAgent: vi.fn() } as unknown as MemeLoopRuntime,
      defaultDefinitionId: 'memeloop:general-assistant',
    });
    expect(r.handled).toBe(false);
  });
});
