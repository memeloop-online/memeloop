import { describe, expect, it, vi } from 'vitest';

import type { AgentOrchestrationClient } from '../orchestration/index.js';
import { createAgentLoopRunner, createMemeLoopRuntime } from '../runtime.js';
import type { AgentFrameworkContext, IChatSyncAdapter, ILLMProvider, INetworkService, IToolRegistry } from '../types.js';
import { configureLoopTestContext } from './testLoopContext.js';
import { createTestStorage } from './testStorage.js';

function createMocks(): AgentFrameworkContext {
  const storage = createTestStorage();

  const llmProvider: ILLMProvider = {
    name: 'dummy',
    async *chat() {
      yield { type: 'finish', finishReason: 'stop' };
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

  return configureLoopTestContext({
    storage,
    llmProvider,
    tools,
    syncAdapters,
    network,
    localNodeId: 'runtime-test-node',
  }, { definitionId: 'memeloop:general-assistant', legacyTextToolCalls: false });
}

describe('createMemeLoopRuntime', () => {
  it('creates runtime and allows subscribing to updates', async () => {
    const ctx = createMocks();
    const runtime = createMemeLoopRuntime(ctx, { allowEphemeralRunState: true });

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

  it('idempotently reopens a host-stable durable conversation id', async () => {
    const context = createMocks();
    const runtime = createMemeLoopRuntime(context, { allowEphemeralRunState: true });

    await expect(runtime.createAgent({
      definitionId: 'memeloop:general-assistant',
      conversationId: 'host-chat-1',
    })).resolves.toEqual({ conversationId: 'host-chat-1' });
    await expect(runtime.createAgent({
      definitionId: 'memeloop:general-assistant',
      conversationId: 'host-chat-1',
    })).resolves.toEqual({ conversationId: 'host-chat-1' });
    await expect(runtime.createAgent({
      definitionId: 'different-definition',
      conversationId: 'host-chat-1',
    })).rejects.toThrow('belongs to memeloop:general-assistant');
  });

  it('propagates the orchestration facade into nested script-created agents', async () => {
    const context = createMocks();
    const storage = context.storage as ReturnType<typeof createTestStorage>;
    context.storage.getConversationMeta = async conversationId => storage.state.conversations.get(conversationId) ?? null;
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
