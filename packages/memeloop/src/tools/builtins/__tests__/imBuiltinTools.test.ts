import { describe, expect, it, vi } from 'vitest';

import { imListConversationsImpl, imNewConversationImpl, imSummarizeHistoryImpl, imSwitchConversationImpl, registerImSessionBuiltinTools } from '../imBuiltinTools.js';

function ctx(overrides: any = {}) {
  return {
    activeToolConversationId: 'conv-active',
    storage: {
      getConversationMeta: vi.fn().mockResolvedValue({
        sourceChannel: { channelId: 'ch1', imUserId: 'u1', platform: 'telegram' },
      }),
      listConversations: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue([]),
      upsertConversationMetadata: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

describe('imBuiltinTools', () => {
  it('list returns errors for invalid args / no active conversation / non-im source', async () => {
    const c = ctx();
    await expect(imListConversationsImpl({}, c, {} as any)).resolves.toEqual({ result: '（暂无会话）' });

    const c2 = ctx({ activeToolConversationId: undefined });
    await expect(imListConversationsImpl({}, c2, {} as any)).resolves.toEqual({ error: 'no_active_conversation' });

    const c3 = ctx({
      storage: { ...c.storage, getConversationMeta: vi.fn().mockResolvedValue(null) },
    });
    await expect(imListConversationsImpl({}, c3, {} as any)).resolves.toEqual({ error: 'im_tools_only_in_im_session' });
  });

  it('list returns sorted result lines', async () => {
    const c = ctx({
      storage: {
        getConversationMeta: vi.fn().mockResolvedValue({
          sourceChannel: { channelId: 'ch1', imUserId: 'u1', platform: 'telegram' },
        }),
        listConversations: vi.fn().mockResolvedValue([
          { conversationId: 'c1', title: 'A', definitionId: 'd1', lastMessageTimestamp: 1 },
          { conversationId: 'c2', title: 'B', definitionId: 'd2', lastMessageTimestamp: 2 },
        ]),
      },
    });
    const r = await imListConversationsImpl({}, c, {} as any);
    expect((r as any).result).toContain('可切换的会话');
    expect((r as any).result.indexOf('c2')).toBeLessThan((r as any).result.indexOf('c1'));
  });

  it('switch validates args and delegates to manager', async () => {
    await expect(imSwitchConversationImpl({}, ctx(), {} as any)).resolves.toEqual({ error: 'invalid_args' });
    const c = ctx();
    const reg = { imChannelManager: { switchConversation: vi.fn().mockResolvedValue(undefined) } } as any;
    await expect(imSwitchConversationImpl({ conversationId: 'new-c' }, c, reg)).resolves.toEqual({
      result: '已切换到会话：new-c',
    });
    expect(reg.imChannelManager.switchConversation).toHaveBeenCalledWith('ch1', 'u1', 'new-c');
  });

  it('newConversation creates agent, sets binding, updates metadata', async () => {
    await expect(imNewConversationImpl({ definitionId: 1 }, ctx(), {} as any)).resolves.toEqual({ error: 'invalid_args' });
    const c = ctx({
      storage: {
        getConversationMeta: vi.fn().mockResolvedValue({
          sourceChannel: { channelId: 'ch1', imUserId: 'u1', platform: 'telegram' },
        }),
        upsertConversationMetadata: vi.fn().mockResolvedValue(undefined),
      },
    });
    const reg = {
      imChannelManager: {
        getBinding: vi.fn().mockResolvedValue({ defaultDefinitionId: 'def-1' }),
        setBinding: vi.fn().mockResolvedValue(undefined),
      },
      getMemeLoopRuntime: () => ({
        createAgent: vi.fn().mockResolvedValue({ conversationId: 'new-conv' }),
      }),
    } as any;
    const r = await imNewConversationImpl({}, c, reg);
    expect((r as any).result).toContain('new-conv');
    expect(reg.imChannelManager.setBinding).toHaveBeenCalled();
  });

  it('newConversation works when metadata missing and summarize invalid args', async () => {
    const c = ctx({
      storage: {
        getConversationMeta: vi.fn().mockResolvedValueOnce({
          sourceChannel: { channelId: 'ch1', imUserId: 'u1', platform: 'telegram' },
        }).mockResolvedValueOnce(null),
        upsertConversationMetadata: vi.fn().mockResolvedValue(undefined),
      },
    });
    const reg = {
      imChannelManager: {
        getBinding: vi.fn().mockResolvedValue(null),
        setBinding: vi.fn().mockResolvedValue(undefined),
      },
      getMemeLoopRuntime: () => ({
        createAgent: vi.fn().mockResolvedValue({ conversationId: 'new-conv-2' }),
      }),
    } as any;
    const r = await imNewConversationImpl({ definitionId: '  ' }, c, reg);
    expect((r as any).result).toContain('memeloop:general-assistant');
    await expect(imSummarizeHistoryImpl({ maxMessages: 0 }, c, {} as any)).resolves.toEqual({ error: 'invalid_args' });
  });

  it('summarize returns empty and truncated forms', async () => {
    const c = ctx();
    await expect(imSummarizeHistoryImpl({}, c, {} as any)).resolves.toEqual({ result: '（当前会话尚无消息）' });

    const c2 = ctx({
      storage: {
        getConversationMeta: vi.fn().mockResolvedValue({
          sourceChannel: { channelId: 'ch1', imUserId: 'u1', platform: 'telegram' },
        }),
        getMessages: vi.fn().mockResolvedValue([{ role: 'user', content: 'x'.repeat(2100) }]),
      },
    });
    const r2 = await imSummarizeHistoryImpl({ maxMessages: 1 }, c2, {} as any);
    expect((r2 as any).result).toContain('最近 1 条消息摘要');
    expect((r2 as any).result).toContain('…');
  });

  it('registerImSessionBuiltinTools registers tool ids', () => {
    const registry = { registerTool: vi.fn() } as any;
    registerImSessionBuiltinTools(registry, ctx(), {
      imChannelManager: {} as any,
      getMemeLoopRuntime: () => ({} as any),
    });
    const ids = registry.registerTool.mock.calls.map((c: any[]) => c[0]);
    expect(ids).toEqual(expect.arrayContaining(['im.listConversations', 'im.switchConversation', 'im.newConversation', 'im.summarizeHistory']));
  });
});
