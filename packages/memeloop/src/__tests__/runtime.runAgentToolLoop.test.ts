import { describe, expect, it, vi } from 'vitest';

import { AgentProfileRegistry } from '../agent/agentProfileRegistry.js';
import { ProviderRegistry } from '../llm/providerRegistry.js';
import { createMemeLoopRuntime } from '../runtime.js';
import type { AgentFrameworkContext, FullAgentStorage, IToolRegistry } from '../types.js';
import { AGENT_USER_MESSAGE_LIMITS } from '../userMessageAdmission.js';
import { createTestStorage } from './testStorage.js';

function baseStorage(): FullAgentStorage {
  return createTestStorage();
}

describe('createMemeLoopRuntime with runAgentToolLoop', () => {
  it('runs registry-backed agent profiles through the runtime child-agent capability', async () => {
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(
      { ownerId: 'test/provider', kind: 'host' },
      {
        name: 'test-provider',
        chat: async function*() {
          yield { type: 'text-delta' as const, id: 'child-text', text: 'child-profile-ok' };
          yield { type: 'finish' as const, finishReason: 'stop' };
        },
      },
      {
        models: [{ modelId: 'test-model', wireModelId: 'test-model', apiMode: 'chat-completions' }],
      },
    );
    const runtime = createMemeLoopRuntime({
      storage: baseStorage(),
      llmProvider: providerRegistry.get('test-provider')!,
      modelProviderRegistry: providerRegistry,
      defaultModelConfig: { providerId: 'test-provider', modelId: 'test-model' },
      agentProfiles: new AgentProfileRegistry(),
      tools: {
        registerTool: vi.fn(),
        getTool: vi.fn(),
        hasTool: () => false,
        listTools: () => [],
      },
      syncAdapters: [],
      network: { start: vi.fn(), stop: vi.fn() },
      localNodeId: 'runtime-child-profile-node',
    }, { allowEphemeralRunState: true });

    const steps = [];
    for await (
      const step of runtime.runChildAgent({
        profileId: 'memeloop:build',
        prompt: 'build it',
        conversationId: 'runtime-child-profile-conversation',
      })
    ) steps.push(step);

    expect(steps).toContainEqual({
      type: 'message',
      data: { type: 'text-delta', id: 'child-text', text: 'child-profile-ok' },
    });
    await runtime.dispose();
  });

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
      localNodeId: 'runtime-loop-node',
      conversationCancellation: new Set(),
      runAgentToolLoop: async function*() {
        yield { type: 'thinking' as const, data: { probe: true } };
      },
    };
    const runtime = createMemeLoopRuntime(ctx, { allowEphemeralRunState: true });
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

  it('rejects a whole-message pending payload before persistence or provider execution', async () => {
    const storage = createTestStorage();
    const execute = vi.fn(async function*() {
      yield { type: 'message' as const, data: 'must not run' };
    });
    const runtime = createMemeLoopRuntime({
      storage,
      llmProvider: { name: 'unused', chat: vi.fn(async () => '') },
      tools: {
        registerTool: vi.fn(),
        getTool: vi.fn(),
        listTools: vi.fn().mockReturnValue([]),
      },
      syncAdapters: [],
      network: { start: vi.fn(), stop: vi.fn() },
      localNodeId: 'runtime-message-admission-node',
      runAgentToolLoop: execute,
    }, { allowEphemeralRunState: true });
    const { conversationId } = await runtime.createAgent({ definitionId: 'def' });
    const handle = await runtime.sendMessage({
      conversationId,
      message: '',
      userMessage: {
        content: '',
        metadata: {
          padding: 'x'.repeat(AGENT_USER_MESSAGE_LIMITS.canonicalMessageBytes),
        },
      },
    });

    let status = await runtime.getRunStatus(handle.runId);
    for (let attempt = 0; attempt < 100 && status?.state !== 'failed'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
      status = await runtime.getRunStatus(handle.runId);
    }
    expect(status).toMatchObject({
      state: 'failed',
      error: {
        code: 'USER_MESSAGE_TOO_LARGE',
        messageKey: 'agent.run.error.userMessageTooLarge',
        retryable: false,
      },
    });
    expect(storage.state.events.filter(event => event.kind === 'message')).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it('cancelAgent publishes cancellation without mutating the caller-owned set', async () => {
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
      localNodeId: 'runtime-cancel-node',
      conversationCancellation: cancel,
      runAgentToolLoop: async function*() {
        yield { type: 'message' as const, data: 'x' };
      },
    };
    const runtime = createMemeLoopRuntime(ctx, { allowEphemeralRunState: true });
    const { conversationId } = await runtime.createAgent({ definitionId: 'def' });
    const updates: unknown[] = [];
    runtime.subscribeToUpdates(conversationId, update => updates.push(update));
    await runtime.cancelAgent(conversationId);
    expect(cancel.has(conversationId)).toBe(false);
    expect(updates).toContainEqual({ type: 'cancelled', conversationId });
  });
});
