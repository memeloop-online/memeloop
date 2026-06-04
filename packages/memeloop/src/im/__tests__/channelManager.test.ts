import { describe, expect, it, vi } from 'vitest';

import { IMChannelManager } from '../channelManager.js';

describe('IMChannelManager', () => {
  it('creates binding for new user via createAgent', async () => {
    const storage = {
      getImBinding: vi.fn().mockResolvedValue(null),
      setImBinding: vi.fn().mockResolvedValue(undefined),
    };
    const manager = new IMChannelManager(storage);
    const driver = {
      createAgent: vi.fn().mockResolvedValue({ conversationId: 'conv-1' }),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    const msg = {
      channelId: 'c1',
      imUserId: 'u1',
      text: 'hi',
      platform: 'telegram' as const,
      raw: {},
    };
    const r = await manager.dispatchInbound(msg, driver, {
      defaultDefinitionId: 'memeloop:general-assistant',
    });
    expect(r.conversationId).toBe('conv-1');
    expect(driver.createAgent).toHaveBeenCalledWith({
      definitionId: 'memeloop:general-assistant',
      initialMessage: 'hi',
    });
    expect(storage.setImBinding).toHaveBeenCalled();
  });
});
