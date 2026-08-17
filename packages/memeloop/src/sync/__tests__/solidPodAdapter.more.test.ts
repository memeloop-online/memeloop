import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createContainerAt: vi.fn().mockResolvedValue(undefined),
  overwriteFile: vi.fn().mockResolvedValue(undefined),
  getFile: vi.fn(),
}));

vi.mock('@inrupt/solid-client', () => ({
  createContainerAt: async (...parameters: unknown[]) => {
    await (mocks.createContainerAt(...parameters) as Promise<void>);
  },
  overwriteFile: async (...parameters: unknown[]) => {
    await (mocks.overwriteFile(...parameters) as Promise<void>);
  },
  getFile: async (...parameters: unknown[]) => {
    const file = await (mocks.getFile(...parameters) as Promise<Blob>);
    return file;
  },
}));

import type { IAgentStorage } from '../../types.js';
import { SolidPodSyncAdapter } from '../solidPodAdapter.js';

function createStorage(): IAgentStorage {
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

afterEach(() => {
  vi.clearAllMocks();
});

describe('SolidPodSyncAdapter (more)', () => {
  it('pullFromPod parses payload and mergePayloadIntoStorage normalizes role', async () => {
    mocks.getFile.mockResolvedValueOnce(
      new Blob([
        JSON.stringify({
          versionVector: { n1: 3 },
          conversations: [{ conversationId: 'c1' }],
          messagesByConversation: {
            c1: [
              {
                messageId: 'm1',
                originNodeId: 'n1',
                timestamp: 1,
                lamportClock: 1,
                role: 'weird',
                content: 'x',
              },
            ],
          },
          exportedAt: 1,
        }),
      ]),
    );
    const storage = createStorage();
    const adapter = new SolidPodSyncAdapter({
      podRootUrl: 'https://pod.example.com/u/',
      storage,
      fetch: globalThis.fetch,
    });
    const payload = await adapter.pullFromPod();
    expect(payload?.versionVector).toEqual({ n1: 3 });
    await adapter.mergePayloadIntoStorage(payload! as any);
    expect(storage.upsertConversationMetadata).toHaveBeenCalled();
    expect(storage.insertMessagesIfAbsent).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ role: 'user' })]),
    );
  });

  it('pushToPod writes backup and creates container when first overwrite fails', async () => {
    const storage = createStorage();
    (storage.listConversations as any).mockResolvedValueOnce([
      { conversationId: 'c1', originNodeId: 'n1', lastMessageTimestamp: 1 },
    ]);
    (storage.getMessages as any).mockResolvedValueOnce([
      {
        messageId: 'm1',
        conversationId: 'c1',
        originNodeId: 'n1',
        timestamp: 1,
        lamportClock: 1,
        role: 'user',
        content: 'x',
      },
    ]);
    mocks.overwriteFile
      .mockRejectedValueOnce(new Error('no container'))
      .mockResolvedValueOnce(undefined);

    const adapter = new SolidPodSyncAdapter({
      podRootUrl: 'https://pod.example.com/u/',
      storage,
      fetch: globalThis.fetch,
    });
    await adapter.pushToPod();
    expect(mocks.createContainerAt).toHaveBeenCalled();
    expect(mocks.overwriteFile).toHaveBeenCalledTimes(2);
  });

  it('start pulls+merges then schedules periodic push; stop clears timer', async () => {
    vi.useFakeTimers();
    try {
      const storage = createStorage();
      mocks.getFile.mockResolvedValueOnce(
        new Blob([
          JSON.stringify({
            versionVector: {},
            conversations: [],
            messagesByConversation: {},
            exportedAt: 1,
          }),
        ]),
      );
      const adapter = new SolidPodSyncAdapter({
        podRootUrl: 'https://pod.example.com/u/',
        storage,
        fetch: globalThis.fetch,
        pushIntervalMs: 10,
      });
      const pushSpy = vi.spyOn(adapter, 'pushToPod').mockResolvedValue(undefined);
      await adapter.start();
      expect(pushSpy).toHaveBeenCalledTimes(1); // immediate push
      await vi.advanceTimersByTimeAsync(11);
      expect(pushSpy).toHaveBeenCalledTimes(2);
      await adapter.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports pull failures while preserving the best-effort null result', async () => {
    const failure = new Error('pod unavailable');
    const onError = vi.fn();
    mocks.getFile.mockRejectedValueOnce(failure);
    const adapter = new SolidPodSyncAdapter({
      podRootUrl: 'https://pod.example.com/u/',
      storage: createStorage(),
      fetch: globalThis.fetch,
      onError,
    });

    await expect(adapter.pullFromPod()).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith({ operation: 'pull', error: failure });
  });

  it('reports a final push failure after container creation recovery also fails', async () => {
    const failure = new Error('write denied');
    const onError = vi.fn();
    mocks.overwriteFile.mockRejectedValueOnce(new Error('container missing'));
    mocks.createContainerAt.mockRejectedValueOnce(failure);
    const adapter = new SolidPodSyncAdapter({
      podRootUrl: 'https://pod.example.com/u/',
      storage: createStorage(),
      fetch: globalThis.fetch,
      onError,
    });

    await expect(adapter.pushToPod()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith({ operation: 'push', error: failure });
  });
});
