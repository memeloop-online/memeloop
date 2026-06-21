import { describe, expect, it, vi } from 'vitest';

import { createMemeLoopRuntime } from '../runtime.js';
import type { AgentFrameworkContext, IAgentStorage, IToolRegistry } from '../types.js';

function baseStorage(): IAgentStorage {
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

describe('createMemeLoopRuntime with runAgentToolLoop', () => {
  it('sendMessage runs runAgentToolLoop and subscribers receive agent-step updates', async () => {
    const storage = baseStorage();
    const tools: IToolRegistry = {
      registerTool: vi.fn(),
      getTool: vi.fn(),
      listTools: vi.fn().mockReturnValue([]),
    };
    const ctx: AgentFrameworkContext = {
      storage,
      llmProvider: {
        name: 'x',
        async chat() {
          return '';
        },
      },
      tools,
      syncAdapters: [],
      network: { start: vi.fn(), stop: vi.fn() },
      conversationCancellation: new Set(),
      runAgentToolLoop: async function*() {
        yield { type: 'thinking' as const, data: { probe: true } };
      },
    };
    const runtime = createMemeLoopRuntime(ctx);
    const { conversationId } = await runtime.createAgent({ definitionId: 'def' });

    const updates: unknown[] = [];
    runtime.subscribeToUpdates(conversationId, (u) => updates.push(u));

    await runtime.sendMessage({ conversationId, message: 'hi' });

    for (let i = 0; i < 150; i += 1) {
      if (
        updates.some((u) => (u as { type?: string }).type === 'agent-step') &&
        updates.some((u) => (u as { type?: string }).type === 'agent-done')
      ) {
        break;
      }

      await new Promise((r) => setTimeout(r, 20));
    }
    expect(updates.some((u) => (u as { type?: string }).type === 'agent-step')).toBe(true);
    expect(updates.some((u) => (u as { type?: string }).type === 'agent-done')).toBe(true);
  });

  it('cancelAgent adds conversation to cancellation set', async () => {
    const cancel = new Set<string>();
    const ctx: AgentFrameworkContext = {
      storage: baseStorage(),
      llmProvider: {
        name: 'x',
        async chat() {
          return '';
        },
      },
      tools: {
        registerTool: vi.fn(),
        getTool: vi.fn(),
        listTools: vi.fn().mockReturnValue([]),
      },
      syncAdapters: [],
      network: { start: vi.fn(), stop: vi.fn() },
      conversationCancellation: cancel,
      runAgentToolLoop: async function*() {
        yield { type: 'message' as const, data: 'x' };
      },
    };
    const runtime = createMemeLoopRuntime(ctx);
    const { conversationId } = await runtime.createAgent({ definitionId: 'def' });
    await runtime.cancelAgent(conversationId);
    expect(cancel.has(conversationId)).toBe(true);
  });
});
