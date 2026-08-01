import { describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '../../conversation/index.js';
import type { ConversationMeta } from '../../sync/protocol.js';

import { MemoryDeviceSyncStateStore } from '../../device-network/deviceSyncStateStore.js';
import type { IAgentStorage } from '../../types.js';
import { ChatSyncEngine, type ChatSyncPeer } from '../chatSyncEngine.js';

function createConversation(id: string, originNodeId: string): ConversationMeta {
  return {
    conversationId: id,
    title: id,
    lastMessagePreview: '',
    lastMessageTimestamp: Date.now(),
    messageCount: 1,
    originNodeId,
    originClock: 1,
    definitionId: 'memeloop:test',
    isUserInitiated: true,
  };
}

describe('ChatSyncEngine', () => {
  it('restores and serializes the persisted Lamport counter', async () => {
    const stateStore = new MemoryDeviceSyncStateStore({ A: 4, B: 2 });
    const storage = {} as unknown as IAgentStorage;
    const first = new ChatSyncEngine({ nodeId: 'A', storage, peers: () => [], stateStore });

    expect(
      await Promise.all([
        first.bumpLocalVersion(),
        first.bumpLocalVersion(),
        first.bumpLocalVersion(),
      ]),
    ).toEqual([5, 6, 7]);

    const restarted = new ChatSyncEngine({ nodeId: 'A', storage, peers: () => [], stateStore });
    expect(await restarted.getVersionVector()).toEqual({ A: 7, B: 2 });
  });

  it('maintains and bumps local version vector', async () => {
    const storage = {} as unknown as IAgentStorage;
    const peers: ChatSyncPeer[] = [];
    const engine = new ChatSyncEngine({
      nodeId: 'A',
      storage,
      peers: () => peers,
    });

    expect(await engine.getVersionVector()).toEqual({ A: 0 });
    await engine.bumpLocalVersion();
    expect(await engine.getVersionVector()).toEqual({ A: 1 });
  });

  it('exchanges version vectors with peers', async () => {
    const upsertConversationMetadata = vi.fn(async (_meta: ConversationMeta): Promise<void> => {});
    const storage = {
      upsertConversationMetadata,
      getMessages: vi.fn().mockResolvedValue([]),
      insertMessagesIfAbsent: vi.fn().mockResolvedValue(undefined),
      listConversations: vi.fn().mockResolvedValue([]),
      appendMessage: vi.fn().mockResolvedValue(undefined),
      getAttachment: vi.fn().mockResolvedValue(null),
      saveAttachment: vi.fn().mockResolvedValue(undefined),
      getAgentDefinition: vi.fn().mockResolvedValue(null),
      saveAgentInstance: vi.fn().mockResolvedValue(undefined),
      getConversationMeta: vi.fn().mockResolvedValue(null),
    } as unknown as IAgentStorage;

    const peerExchange = vi.fn().mockResolvedValue({
      remoteVersion: { B: 2 },
      missingForRemote: [{ originNodeId: 'A', fromExclusive: 0, toInclusive: 1 }],
      missingForLocal: [{ originNodeId: 'B', fromExclusive: 0, toInclusive: 2 }],
    });
    const peerPull = vi.fn().mockResolvedValue({ items: [createConversation('c2', 'B')] });

    const peer: ChatSyncPeer = {
      nodeId: 'B',
      exchangeVersionVector: peerExchange,
      pullMissingMetadata: peerPull,
    };

    const engine = new ChatSyncEngine({
      nodeId: 'A',
      storage,
      peers: () => [peer],
    });

    await engine.syncOnce();

    expect(peerExchange).toHaveBeenCalledTimes(1);
    expect(peerPull).toHaveBeenCalledTimes(1);
    expect(upsertConversationMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'c2' }),
    );

    const vv = await engine.getVersionVector();
    expect(vv.A).toBeGreaterThanOrEqual(0);
    expect(vv.B).toBe(2);
  });

  it('syncOnce returns when no peers', async () => {
    const storage = {
      upsertConversationMetadata: vi.fn(),
      getMessages: vi.fn(),
      insertMessagesIfAbsent: vi.fn(),
      listConversations: vi.fn().mockResolvedValue([]),
      appendMessage: vi.fn(),
      getAttachment: vi.fn(),
      saveAttachment: vi.fn(),
      getAgentDefinition: vi.fn(),
      saveAgentInstance: vi.fn(),
      getConversationMeta: vi.fn(),
    } as unknown as IAgentStorage;
    const engine = new ChatSyncEngine({ nodeId: 'A', storage, peers: () => [] });
    await engine.syncOnce();
    expect((storage.upsertConversationMetadata as any).mock.calls.length).toBe(0);
  });

  it('multi-node: gossip and version vector merge (A and B sync)', async () => {
    const metaA = createConversation('conv-a', 'A');
    const metaB = createConversation('conv-b', 'B');

    const storeA: ConversationMeta[] = [metaA];
    const storeB: ConversationMeta[] = [metaB];

    const storageA = {
      listConversations: async () => [...storeA],
      getMessages: async () => [],
      appendMessage: async () => {},
      upsertConversationMetadata: async (m: ConversationMeta) => {
        if (!storeA.some((x) => x.conversationId === m.conversationId)) {
          storeA.push(m);
        }
      },
      insertMessagesIfAbsent: async () => {},
      getAttachment: async () => null,
      saveAttachment: async () => {},
      getAgentDefinition: async () => null,
      saveAgentInstance: async () => {},
    } as unknown as IAgentStorage;

    const storageB = {
      listConversations: async () => [...storeB],
      getMessages: async () => [],
      appendMessage: async () => {},
      upsertConversationMetadata: async (m: ConversationMeta) => {
        if (!storeB.some((x) => x.conversationId === m.conversationId)) {
          storeB.push(m);
        }
      },
      insertMessagesIfAbsent: async () => {},
      getAttachment: async () => null,
      saveAttachment: async () => {},
      getAgentDefinition: async () => null,
      saveAgentInstance: async () => {},
    } as unknown as IAgentStorage;

    const peerB: ChatSyncPeer = {
      nodeId: 'B',
      exchangeVersionVector: async (localVersion) => {
        const remoteVersion = { B: storeB.length };
        const missingForRemote = (localVersion.A ?? 0) < 1
          ? [{ originNodeId: 'A', fromExclusive: localVersion.A ?? 0, toInclusive: 1 }]
          : [];
        return { remoteVersion, missingForRemote, missingForLocal: [] };
      },
      pullMissingMetadata: async (sinceVersion) => {
        return { items: storeB.filter((c) => (sinceVersion[c.originNodeId] ?? 0) < 1) };
      },
    };

    const peerA: ChatSyncPeer = {
      nodeId: 'A',
      exchangeVersionVector: async (localVersion) => {
        const remoteVersion = { A: storeA.length };
        const missingForRemote = (localVersion.B ?? 0) < 1
          ? [{ originNodeId: 'B', fromExclusive: localVersion.B ?? 0, toInclusive: 1 }]
          : [];
        return { remoteVersion, missingForRemote, missingForLocal: [] };
      },
      pullMissingMetadata: async (sinceVersion) => {
        return { items: storeA.filter((c) => (sinceVersion[c.originNodeId] ?? 0) < 1) };
      },
    };

    const engineA = new ChatSyncEngine({
      nodeId: 'A',
      storage: storageA,
      peers: () => [peerB],
    });
    const engineB = new ChatSyncEngine({
      nodeId: 'B',
      storage: storageB,
      peers: () => [peerA],
    });

    await engineA.syncOnce();
    await engineB.syncOnce();

    expect(storeA.some((c) => c.conversationId === 'conv-b')).toBe(true);
    expect(storeB.some((c) => c.conversationId === 'conv-a')).toBe(true);

    const vvA = await engineA.getVersionVector();
    const vvB = await engineB.getVersionVector();
    expect(vvA.A).toBeGreaterThanOrEqual(0);
    expect(vvA.B).toBe(1);
    // peer mock 用 storeA.length 作为 A 的时钟，同步后 A 侧有两条会话故为 2
    expect(vvB.A).toBe(2);
    expect(vvB.B).toBeGreaterThanOrEqual(0);
  });

  it('syncOnce pulls missing messages when peer implements pullMissingMessages', async () => {
    const insertMessagesIfAbsent = vi.fn().mockResolvedValue(undefined);
    const upsertConversationMetadata = vi.fn(async (_meta: ConversationMeta): Promise<void> => {});
    const storage = {
      listConversations: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockImplementation(async (conversationId: string) => {
        if (conversationId === 'c-remote') {
          return [];
        }
        return [];
      }),
      appendMessage: vi.fn().mockResolvedValue(undefined),
      upsertConversationMetadata,
      insertMessagesIfAbsent,
      getAttachment: vi.fn().mockResolvedValue(null),
      saveAttachment: vi.fn().mockResolvedValue(undefined),
      getAgentDefinition: vi.fn().mockResolvedValue(null),
      saveAgentInstance: vi.fn().mockResolvedValue(undefined),
      getConversationMeta: vi.fn().mockResolvedValue(null),
    } as unknown as IAgentStorage;

    const inbound: ChatMessage = {
      messageId: 'm-remote',
      conversationId: 'c-remote',
      originNodeId: 'B',
      timestamp: Date.now(),
      lamportClock: 1,
      role: 'assistant',
      content: 'from B',
    };

    const peer: ChatSyncPeer = {
      nodeId: 'B',
      exchangeVersionVector: vi.fn().mockResolvedValue({
        remoteVersion: { B: 1 },
        missingForRemote: [],
        missingForLocal: [],
      }),
      pullMissingMetadata: vi.fn().mockResolvedValue({
        items: [createConversation('c-remote', 'B')],
      }),
      pullMissingMessages: vi.fn().mockResolvedValue([inbound]),
    };

    const engine = new ChatSyncEngine({
      nodeId: 'A',
      storage,
      peers: () => [peer],
    });

    await engine.syncOnce();

    expect(insertMessagesIfAbsent).toHaveBeenCalledWith([
      expect.objectContaining({ messageId: 'm-remote' }),
    ]);
  });

  it('pullMissingMessages ignores peer errors and handles empty incoming', async () => {
    const insertMessagesIfAbsent = vi.fn().mockResolvedValue(undefined);
    const storage = {
      listConversations: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue([]),
      appendMessage: vi.fn().mockResolvedValue(undefined),
      upsertConversationMetadata: vi.fn().mockResolvedValue(undefined),
      insertMessagesIfAbsent,
      getAttachment: vi.fn().mockResolvedValue(null),
      saveAttachment: vi.fn().mockResolvedValue(undefined),
      getAgentDefinition: vi.fn().mockResolvedValue(null),
      saveAgentInstance: vi.fn().mockResolvedValue(undefined),
      getConversationMeta: vi.fn().mockResolvedValue(null),
    } as unknown as IAgentStorage;

    const peer: ChatSyncPeer = {
      nodeId: 'B',
      exchangeVersionVector: vi
        .fn()
        .mockResolvedValue({ remoteVersion: { B: 1 }, missingForRemote: [], missingForLocal: [] }),
      pullMissingMetadata: vi.fn().mockResolvedValue({ items: [createConversation('c1', 'B')] }),
      pullMissingMessages: vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce([]),
    };
    const engine = new ChatSyncEngine({ nodeId: 'A', storage, peers: () => [peer] });
    await engine.syncOnce();
    expect(insertMessagesIfAbsent).not.toHaveBeenCalled();
  });

  it('pullMissingMessages triggers saveAttachment when peer returns attachment blobs', async () => {
    const saveAttachment = vi.fn().mockResolvedValue(undefined);
    const readAttachmentData = vi.fn().mockResolvedValue(null);
    const getAttachment = vi.fn().mockResolvedValue(null);
    const insertMessagesIfAbsent = vi.fn().mockResolvedValue(undefined);
    const upsertConversationMetadata = vi.fn().mockResolvedValue(undefined);
    const storage = {
      listConversations: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue([]),
      appendMessage: vi.fn().mockResolvedValue(undefined),
      upsertConversationMetadata,
      insertMessagesIfAbsent,
      getAttachment,
      saveAttachment,
      readAttachmentData,
      getAgentDefinition: vi.fn().mockResolvedValue(null),
      saveAgentInstance: vi.fn().mockResolvedValue(null),
      getConversationMeta: vi.fn().mockResolvedValue(null),
    } as unknown as IAgentStorage;

    const msg: ChatMessage = {
      messageId: 'm1',
      conversationId: 'c-att',
      originNodeId: 'B',
      timestamp: Date.now(),
      lamportClock: 1,
      role: 'user',
      content: 'pic',
      attachments: [
        {
          contentHash: 'sha256:deadbeef',
          filename: 'a.png',
          mimeType: 'image/png',
          size: 4,
        },
      ],
    };

    const peer: ChatSyncPeer = {
      nodeId: 'B',
      exchangeVersionVector: vi.fn().mockResolvedValue({
        remoteVersion: { B: 1 },
        missingForRemote: [],
        missingForLocal: [],
      }),
      pullMissingMetadata: vi.fn().mockResolvedValue({
        items: [
          {
            conversationId: 'c-att',
            title: 'c-att',
            lastMessagePreview: '',
            lastMessageTimestamp: Date.now(),
            messageCount: 1,
            originNodeId: 'B',
            originClock: 1,
            definitionId: 'd',
            isUserInitiated: true,
          },
        ],
      }),
      pullMissingMessages: vi.fn().mockResolvedValue([msg]),
      pullAttachmentBlob: vi.fn().mockResolvedValue({
        data: new Uint8Array([1, 2, 3, 4]),
        filename: 'a.png',
        mimeType: 'image/png',
        size: 4,
      }),
    };

    const engine = new ChatSyncEngine({ nodeId: 'A', storage, peers: () => [peer] });
    await engine.syncOnce();

    expect(saveAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ contentHash: 'sha256:deadbeef' }),
      expect.any(Uint8Array),
    );
  });

  it('ensureAttachmentsFromMessages skips pull when local already has bytes, or reader missing; tries next peer on failure', async () => {
    const saveAttachment = vi.fn().mockResolvedValue(undefined);
    const getAttachment = vi
      .fn()
      .mockResolvedValueOnce({ contentHash: 'sha256:have', filename: 'x', mimeType: 'x', size: 1 }) // have bytes
      .mockResolvedValueOnce({
        contentHash: 'sha256:noreader',
        filename: 'x',
        mimeType: 'x',
        size: 1,
      }) // no reader
      .mockResolvedValueOnce(null); // need pull
    const readAttachmentData = vi
      .fn()
      .mockResolvedValueOnce(new Uint8Array([1])) // have bytes
      .mockResolvedValueOnce(null); // would be used if reader exists

    const storage = {
      listConversations: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue([]),
      appendMessage: vi.fn().mockResolvedValue(undefined),
      upsertConversationMetadata: vi.fn().mockResolvedValue(undefined),
      insertMessagesIfAbsent: vi.fn().mockResolvedValue(undefined),
      getAttachment,
      saveAttachment,
      readAttachmentData,
      getAgentDefinition: vi.fn().mockResolvedValue(null),
      saveAgentInstance: vi.fn().mockResolvedValue(null),
      getConversationMeta: vi.fn().mockResolvedValue(null),
    } as unknown as IAgentStorage;

    const msg: ChatMessage = {
      messageId: 'm1',
      conversationId: 'c-att',
      originNodeId: 'B',
      timestamp: Date.now(),
      lamportClock: 1,
      role: 'user',
      content: 'pic',
      attachments: [
        { contentHash: 'sha256:have', filename: 'a', mimeType: 'x', size: 1 },
        { contentHash: 'sha256:noreader', filename: 'b', mimeType: 'x', size: 1 },
        { contentHash: 'sha256:need', filename: 'c', mimeType: 'x', size: 1 },
      ],
    };

    const peer1: ChatSyncPeer = {
      nodeId: 'B1',
      exchangeVersionVector: vi.fn().mockResolvedValue({
        remoteVersion: {},
        missingForRemote: [],
        missingForLocal: [],
      }),
      pullMissingMetadata: vi.fn().mockResolvedValue({
        items: [createConversation('c-att', 'B')],
      }),
      pullMissingMessages: vi.fn().mockResolvedValue([msg]),
      pullAttachmentBlob: vi.fn().mockRejectedValue(new Error('fail')),
    };
    const peer2: ChatSyncPeer = {
      nodeId: 'B2',
      exchangeVersionVector: vi.fn().mockResolvedValue({
        remoteVersion: {},
        missingForRemote: [],
        missingForLocal: [],
      }),
      pullMissingMetadata: vi.fn().mockResolvedValue({ items: [] }),
      pullMissingMessages: vi.fn().mockResolvedValue([]),
      pullAttachmentBlob: vi
        .fn()
        .mockResolvedValue({ data: new Uint8Array([9, 9]), filename: 'c', mimeType: 'x', size: 0 }),
    };

    const engine = new ChatSyncEngine({ nodeId: 'A', storage, peers: () => [peer1, peer2] });
    await engine.syncOnce();
    expect(saveAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ contentHash: 'sha256:need', size: 2 }),
      expect.any(Uint8Array),
    );
  });

  it('antiEntropyOnce invokes listConversations', async () => {
    const listConversations = vi.fn().mockResolvedValue([createConversation('cx', 'A')]);
    const storage = {
      listConversations,
      getMessages: vi.fn().mockResolvedValue([]),
      appendMessage: vi.fn().mockResolvedValue(undefined),
      upsertConversationMetadata: vi.fn().mockResolvedValue(undefined),
      insertMessagesIfAbsent: vi.fn().mockResolvedValue(undefined),
      getAttachment: vi.fn().mockResolvedValue(null),
      saveAttachment: vi.fn().mockResolvedValue(undefined),
      getAgentDefinition: vi.fn().mockResolvedValue(null),
      saveAgentInstance: vi.fn().mockResolvedValue(undefined),
      getConversationMeta: vi.fn().mockResolvedValue(null),
    } as unknown as IAgentStorage;

    const peer: ChatSyncPeer = {
      nodeId: 'B',
      exchangeVersionVector: vi.fn().mockResolvedValue({
        remoteVersion: {},
        missingForRemote: [],
        missingForLocal: [],
      }),
      pullMissingMetadata: vi.fn().mockResolvedValue({ items: [] }),
    };

    const engine = new ChatSyncEngine({ nodeId: 'A', storage, peers: () => [peer] });
    await engine.antiEntropyOnce();
    expect(listConversations).toHaveBeenCalled();
  });

  it('paginates more than 500 remote metadata records without loss', async () => {
    const metadata = Array.from({ length: 503 }, (_, index) => createConversation(`remote-${index}`, 'B'));
    const upsertConversationMetadata = vi.fn(async (_meta: ConversationMeta): Promise<void> => {});
    const storage = {
      listConversations: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue([]),
      appendMessage: vi.fn(),
      upsertConversationMetadata,
      insertMessagesIfAbsent: vi.fn(),
      getAttachment: vi.fn().mockResolvedValue(null),
      saveAttachment: vi.fn(),
      getAgentDefinition: vi.fn(),
      saveAgentInstance: vi.fn(),
      getConversationMeta: vi.fn(),
    } as unknown as IAgentStorage;
    const pullMissingMetadata = vi.fn(async (_version, cursor?: string) => {
      const offset = cursor === undefined ? 0 : Number(cursor);
      const items = metadata.slice(offset, offset + 100);
      return {
        items,
        ...(offset + items.length < metadata.length
          ? { nextCursor: String(offset + items.length) }
          : {}),
      };
    });
    const peer: ChatSyncPeer = {
      nodeId: 'B',
      exchangeVersionVector: vi.fn().mockResolvedValue({
        remoteVersion: { B: 503 },
        missingForRemote: [],
        missingForLocal: [{ originNodeId: 'B', fromExclusive: 0, toInclusive: 503 }],
      }),
      pullMissingMetadata,
    };

    await new ChatSyncEngine({ nodeId: 'A', storage, peers: () => [peer] }).syncOnce();

    expect(pullMissingMetadata).toHaveBeenCalledTimes(6);
    expect(upsertConversationMetadata).toHaveBeenCalledTimes(503);
    expect(new Set(upsertConversationMetadata.mock.calls.map(([meta]) => meta.conversationId)).size)
      .toBe(503);
  });

  it('reconciles metadata origin clocks into persistent state before exchange', async () => {
    const stateStore = new MemoryDeviceSyncStateStore({ A: 2 });
    const exchangeVersionVector = vi.fn().mockResolvedValue({
      remoteVersion: {},
      missingForRemote: [],
      missingForLocal: [],
    });
    const storage = {
      listConversations: vi.fn().mockResolvedValue([
        { ...createConversation('a-new', 'A'), originClock: 9 },
        { ...createConversation('b-new', 'B'), originClock: 4 },
      ]),
      getMessages: vi.fn().mockResolvedValue([]),
      appendMessage: vi.fn(),
      upsertConversationMetadata: vi.fn(),
      insertMessagesIfAbsent: vi.fn(),
      getAttachment: vi.fn().mockResolvedValue(null),
      saveAttachment: vi.fn(),
      getAgentDefinition: vi.fn(),
      saveAgentInstance: vi.fn(),
      getConversationMeta: vi.fn(),
    } as unknown as IAgentStorage;
    const peer: ChatSyncPeer = {
      nodeId: 'B',
      exchangeVersionVector,
      pullMissingMetadata: vi.fn().mockResolvedValue({ items: [] }),
    };

    await new ChatSyncEngine({ nodeId: 'A', storage, peers: () => [peer], stateStore }).syncOnce();

    expect(exchangeVersionVector).toHaveBeenCalledWith({ A: 9, B: 4 });
    expect(await stateStore.loadVersionVector()).toEqual({ A: 9, B: 4 });
  });
});
