import { describe, expect, it, vi } from 'vitest';

import type { IAgentStorage } from '../../types.js';
import { SolidPodSyncAdapter } from '../solidPodAdapter.js';

function createMockStorage(): IAgentStorage {
  return {
    listConversations: vi.fn().mockResolvedValue([]),
    getMessages: vi.fn().mockResolvedValue([]),
    appendMessage: vi.fn().mockResolvedValue(undefined),
    upsertConversationMetadata: vi.fn().mockResolvedValue(undefined),
    insertMessagesIfAbsent: vi.fn().mockResolvedValue(undefined),
    getAttachment: vi.fn().mockResolvedValue(null),
    saveAttachment: vi.fn().mockResolvedValue(undefined),
    getAgentDefinition: vi.fn().mockResolvedValue(null),
    saveAgentInstance: vi.fn().mockResolvedValue(undefined),
    getConversationMeta: vi.fn().mockResolvedValue(null),
  };
}

describe('SolidPodSyncAdapter', () => {
  it('start and stop do nothing when fetch is not provided', async () => {
    const adapter = new SolidPodSyncAdapter({
      podRootUrl: 'https://pod.example.com/user/',
      storage: createMockStorage(),
    });
    await adapter.start();
    await adapter.stop();
  });

  it('pushToPod does not throw when fetch is not provided', async () => {
    const adapter = new SolidPodSyncAdapter({
      podRootUrl: 'https://pod.example.com/user/',
      storage: createMockStorage(),
    });
    await expect(adapter.pushToPod()).resolves.toBeUndefined();
  });

  it('pullFromPod returns null when fetch is not provided', async () => {
    const adapter = new SolidPodSyncAdapter({
      podRootUrl: 'https://pod.example.com/user/',
      storage: createMockStorage(),
    });
    const result = await adapter.pullFromPod();
    expect(result).toBeNull();
  });
});
