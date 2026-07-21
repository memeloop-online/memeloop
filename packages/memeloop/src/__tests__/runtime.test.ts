import { describe, expect, it, vi } from 'vitest';

import type { AgentOrchestrationClient } from '../orchestration/index.js';
import { createAgentLoopRunner, createMemeLoopRuntime } from '../runtime.js';
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

  it('propagates the orchestration facade into nested script-created agents', async () => {
    const context = createMocks();
    const orchestration = {
      getCapabilities: async () => ({
        operations: ['apply'],
        resourceKinds: ['AgentWorkload'],
        interfaces: ['resource'],
      }),
    } as unknown as AgentOrchestrationClient;
    const parentSource = `
      export default async function run(ctx) {
        const child = await ctx.runAgent({ profileId: 'profile:child', conversationId: 'child-run' });
        ctx.finish(child.text);
      }
    `;
    const childSource = `
      export default async function run(ctx) {
        const capabilities = await ctx.orchestration.getCapabilities();
        ctx.finish('nested:' + capabilities.resourceKinds.join(','));
      }
    `;
    context.orchestration = orchestration;
    context.loopScriptPolicy = { allowSource: true, scriptLoadGate: { admitScriptLoad: () => ({ allowed: true, trustClass: 'trusted' as const }) } };
    context.resolveAgentDefinition = async (definitionId) => ({
      id: definitionId,
      name: definitionId,
      description: definitionId,
      loopId: 'agent-agent-loop',
      scriptReference: {
        kind: 'source',
        source: definitionId === 'profile:parent' ? parentSource : childSource,
      },
      version: '1.0.0',
    } as never);

    const runner = await createAgentLoopRunner(context, {
      definitionId: 'profile:parent',
      conversationId: 'parent-run',
    });
    const messages: unknown[] = [];
    for await (const step of runner?.({ conversationId: 'parent-run', message: 'deploy' }) ?? []) {
      if (step.type === 'message') messages.push(step.data);
    }

    expect(messages).toContain('nested:AgentWorkload');
  });
});
