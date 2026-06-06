import { describe, expect, it, vi } from 'vitest';

import { createMemeLoopRuntime } from '../runtime.js';
import type { AgentFrameworkContext, IAgentStorage, IChatSyncAdapter, ILLMProvider, INetworkService, IToolRegistry } from '../types.js';

function createMocks(): AgentFrameworkContext {
  const storage: IAgentStorage = {
    async listConversations() {
      return [];
    },
    async getMessages() {
      return [];
    },
    async appendMessage() {
      return;
    },
    async upsertConversationMetadata() {
      return;
    },
    async insertMessagesIfAbsent() {
      return;
    },
    async getAttachment() {
      return null;
    },
    async saveAttachment() {
      return;
    },
    async getAgentDefinition() {
      return null;
    },
    async saveAgentInstance() {
      return;
    },
    async getConversationMeta() {
      return null;
    },
  };

  const llmProvider: ILLMProvider = {
    name: 'dummy',
    async chat() {
      return;
    },
  };

  const tools: IToolRegistry = {
    registerTool: vi.fn(),
    getTool: vi.fn(),
    listTools: vi.fn().mockReturnValue([]),
  };

  const syncAdapters: IChatSyncAdapter[] = [];

  const network: INetworkService = {
    start: vi.fn(),
    stop: vi.fn(),
  };

  return { storage, llmProvider, tools, syncAdapters, network };
}

describe('createMemeLoopRuntime', () => {
  it('creates runtime and allows subscribing to updates', async () => {
    const ctx = createMocks();
    const runtime = createMemeLoopRuntime(ctx);

    const updates: unknown[] = [];
    const { conversationId } = await runtime.createAgent({
      definitionId: 'memeloop:general-assistant',
    });
    const unsubscribe = runtime.subscribeToUpdates(conversationId, (u) => updates.push(u));

    await runtime.sendMessage({ conversationId, message: 'hello' });
    await runtime.cancelAgent(conversationId);

    unsubscribe();

    expect(updates.length).toBeGreaterThan(0);
  });
});
