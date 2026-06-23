import { describe, expect, it, vi } from 'vitest';

import { createImTaggedDriver } from '../imTaggedDriver.js';

describe('createImTaggedDriver', () => {
  it('tags conversation meta only when missing or sourceChannel absent', async () => {
    const runtime: any = {
      createAgent: vi.fn().mockResolvedValue({ conversationId: 'c1' }),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };

    const storage: any = {
      // Code path: tagIfNeeded() only runs when meta exists but sourceChannel is absent.
      getConversationMeta: vi.fn().mockResolvedValue({}),
      upsertConversationMetadata: vi.fn().mockResolvedValue(undefined),
    };

    const driver = createImTaggedDriver(runtime, storage, { channelId: 'ch', platform: 'telegram', imUserId: 'u1' });

    await driver.createAgent({ definitionId: 'd', initialMessage: 'hi' });
    expect(storage.upsertConversationMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChannel: { channelId: 'ch', platform: 'telegram', imUserId: 'u1' },
      }),
    );

    storage.getConversationMeta.mockResolvedValueOnce({ sourceChannel: { channelId: 'ch', platform: 'telegram', imUserId: 'u1' } });
    await driver.sendMessage({ conversationId: 'c2', message: 'x' });
    // No extra upsert for c2 because meta already had sourceChannel
    expect(storage.upsertConversationMetadata).toHaveBeenCalledTimes(1);
  });
});
