import { describe, expect, it, vi } from 'vitest';

import { createTestStorage } from '../../../__tests__/testStorage.js';
import { IMChannelManager } from '../../../im/channelManager.js';
import type { FullAgentStorage, IChatSyncAdapter, ILLMProvider, INetworkService, IToolRegistry } from '../../../types.js';
import {
  imListConversationsImpl,
  imNewConversationImpl,
  type ImSessionBuiltinRegistration,
  imSummarizeHistoryImpl,
  imSwitchConversationImpl,
  registerImSessionBuiltinTools,
} from '../imBuiltinTools.js';
import type { BuiltinToolContext } from '../types.js';

function createStorage(overrides: Partial<FullAgentStorage> = {}): FullAgentStorage {
  return createTestStorage(undefined, {
    getConversationMeta: vi.fn().mockResolvedValue({
      conversationId: 'conv-active',
      title: 'IM test',
      lastMessagePreview: '',
      lastMessageTimestamp: 0,
      messageCount: 0,
      originNodeId: 'test-node',
      originClock: 1,
      definitionId: 'test-agent',
      isUserInitiated: true,
      sourceChannel: { channelId: 'ch1', imUserId: 'u1', platform: 'telegram' },
    }),
    ...overrides,
  });
}

function ctx(overrides: Partial<BuiltinToolContext> = {}): BuiltinToolContext {
  const llmProvider: ILLMProvider = { name: 'mock', chat: vi.fn().mockResolvedValue([]) };
  const tools: IToolRegistry = {
    registerTool: vi.fn(),
    getTool: vi.fn(),
    listTools: vi.fn().mockReturnValue([]),
  };
  const syncAdapters: IChatSyncAdapter[] = [];
  const network: INetworkService = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  return {
    activeToolConversationId: 'conv-active',
    storage: createStorage(),
    llmProvider,
    tools,
    syncAdapters,
    network,
    localNodeId: 'test-node-im-tools',
    ...overrides,
  };
}

function registration(
  overrides: Partial<ImSessionBuiltinRegistration> = {},
): ImSessionBuiltinRegistration {
  const runtime = {} as ReturnType<ImSessionBuiltinRegistration['getMemeLoopRuntime']>;
  return {
    imChannelManager: new IMChannelManager(),
    getMemeLoopRuntime: () => runtime,
    ...overrides,
  };
}

describe('imBuiltinTools', () => {
  it('list returns errors for invalid args / no active conversation / non-im source', async () => {
    const c = ctx();
    await expect(imListConversationsImpl({}, c, registration())).resolves.toEqual({
      result: '（暂无会话）',
    });

    const c2 = ctx({ activeToolConversationId: undefined });
    await expect(imListConversationsImpl({}, c2, registration())).resolves.toEqual({
      error: 'no_active_conversation',
    });

    const c3 = ctx({
      storage: createStorage({ getConversationMeta: vi.fn().mockResolvedValue(null) }),
    });
    await expect(imListConversationsImpl({}, c3, registration())).resolves.toEqual({
      error: 'im_tools_only_in_im_session',
    });
  });

  it('list returns sorted result lines', async () => {
    const c = ctx({
      storage: createStorage({
        getConversationMeta: vi.fn().mockResolvedValue({
          sourceChannel: { channelId: 'ch1', imUserId: 'u1', platform: 'telegram' },
        }),
        listConversationsPage: vi.fn().mockResolvedValue({
          reset: false,
          items: [
            { conversationId: 'c1', title: 'A', definitionId: 'd1', lastMessageTimestamp: 1 },
            { conversationId: 'c2', title: 'B', definitionId: 'd2', lastMessageTimestamp: 2 },
          ],
          revision: 'test-list-1',
          total: 2,
          hasMoreBefore: false,
          hasMoreAfter: false,
        }),
      }),
    });
    const r = await imListConversationsImpl({}, c, registration());
    if (!('result' in r)) throw new Error(`expected result, received ${r.error}`);
    expect(r.result).toContain('可切换的会话');
    expect(r.result.indexOf('c2')).toBeLessThan(r.result.indexOf('c1'));
  });

  it('switch validates args and delegates to manager', async () => {
    await expect(imSwitchConversationImpl({}, ctx(), registration())).resolves.toEqual({
      error: 'invalid_args',
    });
    const c = ctx();
    const imChannelManager = new IMChannelManager();
    const switchConversation = vi.spyOn(imChannelManager, 'switchConversation').mockResolvedValue(undefined);
    const reg = registration({ imChannelManager });
    await expect(imSwitchConversationImpl({ conversationId: 'new-c' }, c, reg)).resolves.toEqual({
      result: '已切换到会话：new-c',
    });
    expect(switchConversation).toHaveBeenCalledWith('ch1', 'u1', 'new-c');
  });

  it('newConversation creates agent, sets binding, updates metadata', async () => {
    await expect(imNewConversationImpl({ definitionId: 1 }, ctx(), registration())).resolves.toEqual({
      error: 'invalid_args',
    });
    const c = ctx({
      storage: createStorage({
        getConversationMeta: vi.fn().mockResolvedValue({
          sourceChannel: { channelId: 'ch1', imUserId: 'u1', platform: 'telegram' },
        }),
        upsertConversationMetadata: vi.fn().mockResolvedValue(undefined),
      }),
    });
    const imChannelManager = new IMChannelManager();
    vi.spyOn(imChannelManager, 'getBinding').mockResolvedValue({
      channelId: 'ch1',
      imUserId: 'u1',
      activeConversationId: 'conv-active',
      createdAt: 1,
      defaultDefinitionId: 'def-1',
    });
    const setBinding = vi.spyOn(imChannelManager, 'setBinding').mockResolvedValue(undefined);
    const runtime = {
      createAgent: vi.fn().mockResolvedValue({ conversationId: 'new-conv' }),
    } as unknown as ReturnType<ImSessionBuiltinRegistration['getMemeLoopRuntime']>;
    const reg = registration({ imChannelManager, getMemeLoopRuntime: () => runtime });
    const r = await imNewConversationImpl({}, c, reg);
    if (!('result' in r)) throw new Error(`expected result, received ${r.error}`);
    expect(r.result).toContain('new-conv');
    expect(setBinding).toHaveBeenCalled();
  });

  it('newConversation works when metadata missing and summarize invalid args', async () => {
    const c = ctx({
      storage: createStorage({
        getConversationMeta: vi
          .fn()
          .mockResolvedValueOnce({
            sourceChannel: { channelId: 'ch1', imUserId: 'u1', platform: 'telegram' },
          })
          .mockResolvedValueOnce(null),
        upsertConversationMetadata: vi.fn().mockResolvedValue(undefined),
      }),
    });
    const imChannelManager = new IMChannelManager();
    vi.spyOn(imChannelManager, 'getBinding').mockResolvedValue(undefined);
    vi.spyOn(imChannelManager, 'setBinding').mockResolvedValue(undefined);
    const runtime = {
      createAgent: vi.fn().mockResolvedValue({ conversationId: 'new-conv-2' }),
    } as unknown as ReturnType<ImSessionBuiltinRegistration['getMemeLoopRuntime']>;
    const reg = registration({ imChannelManager, getMemeLoopRuntime: () => runtime });
    const r = await imNewConversationImpl({ definitionId: '  ' }, c, reg);
    if (!('result' in r)) throw new Error(`expected result, received ${r.error}`);
    expect(r.result).toContain('memeloop:general-assistant');
    await expect(imSummarizeHistoryImpl({ maxMessages: 0 }, c, registration())).resolves.toEqual({
      error: 'invalid_args',
    });
  });

  it('summarize returns empty and truncated forms', async () => {
    const c = ctx();
    await expect(imSummarizeHistoryImpl({}, c, registration())).resolves.toEqual({
      result: '（当前会话尚无消息）',
    });

    const c2 = ctx({
      storage: createStorage({
        getConversationMeta: vi.fn().mockResolvedValue({
          sourceChannel: { channelId: 'ch1', imUserId: 'u1', platform: 'telegram' },
        }),
        getFullContentMessagePage: vi.fn().mockResolvedValue({
          reset: false,
          conversationId: 'conv-active',
          items: [{
            messageId: 'message-1',
            turnId: 'message-1',
            conversationId: 'conv-active',
            originNodeId: 'test-node-im-tools',
            originSequence: 1,
            timestamp: 1,
            lamportClock: 1,
            role: 'user',
            content: 'x'.repeat(2100),
            parts: [{ type: 'text', text: 'x'.repeat(2100) }],
          }],
          revision: 'test-messages-1',
          hasMoreBefore: false,
          hasMoreAfter: false,
          startCursor: {
            timestamp: 1,
            lamportClock: 1,
            originNodeId: 'test-node-im-tools',
            messageId: 'message-1',
          },
          endCursor: {
            timestamp: 1,
            lamportClock: 1,
            originNodeId: 'test-node-im-tools',
            messageId: 'message-1',
          },
        }),
      }),
    });
    const r2 = await imSummarizeHistoryImpl({ maxMessages: 1 }, c2, registration());
    if (!('result' in r2)) throw new Error(`expected result, received ${r2.error}`);
    expect(r2.result).toContain('最近 1 条消息摘要');
    expect(r2.result).toContain('…');
  });

  it('registerImSessionBuiltinTools registers tool ids', () => {
    const registerTool = vi.fn<IToolRegistry['registerTool']>();
    const registry = {
      registerTool,
      getTool: vi.fn(),
      listTools: vi.fn().mockReturnValue([]),
    } satisfies IToolRegistry;
    const runtime = {} as ReturnType<ImSessionBuiltinRegistration['getMemeLoopRuntime']>;
    const registration: ImSessionBuiltinRegistration = {
      imChannelManager: {} as ImSessionBuiltinRegistration['imChannelManager'],
      getMemeLoopRuntime: () => runtime,
    };
    registerImSessionBuiltinTools(registry, ctx(), registration);
    const ids = registerTool.mock.calls.map((call) => call[0]);
    expect(ids).toEqual(
      expect.arrayContaining([
        'im.listConversations',
        'im.switchConversation',
        'im.newConversation',
        'im.summarizeHistory',
      ]),
    );
  });
});
