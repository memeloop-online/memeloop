import { describe, expect, it, vi } from 'vitest';
import type { AgentGoal, AgentGoalStatus, GoalStore } from '../agent-management/goal.js';
import { GoalCoordinator } from '../agent-management/GoalCoordinator.js';
import { domainSeparatedCanonicalJsonBytes } from '../encoding/canonicalJson.js';
import { sha256HexSync } from '../encoding/sha256.js';
import { ProviderRegistry } from '../llm/providerRegistry.js';
import type { PortableLlmRequest } from '../llm/request.js';
import { MemoryAgentRunStateStore } from '../runState.js';
import { createMemeLoopRuntime, type MemeLoopRunState, type MemeLoopRuntime } from '../runtime.js';
import { GOAL_SYSTEM_PROMPT } from '../tools/builtins/goal.js';
import type { ILLMProvider } from '../types.js';
import { createTestStorage } from './testStorage.js';

describe('durable goal execution', () => {
  it.each(['accepted', 'queued'] as const)('replays a %s goal acceptance before its user event was saved', async state => {
    const definition = { id: 'personal', name: 'Personal', description: 'Recovery test', systemPrompt: '', tools: [], version: '1' };
    const storage = createTestStorage(undefined, { getAgentDefinition: async () => definition });
    storage.state.conversations.set('chat', {
      conversationId: 'chat',
      definitionId: definition.id,
      title: 'Chat',
      isUserInitiated: true,
      lastMessagePreview: '',
      lastMessageTimestamp: 0,
      messageCount: 0,
      originNodeId: 'desktop',
      originClock: 0,
    });
    const pendingRound = { requestId: 'saved-request', turnId: 'saved-turn', message: 'Resume the exact saved objective prompt.' };
    let goal: AgentGoal = {
      id: 'saved-goal',
      conversationId: 'chat',
      definitionId: definition.id,
      executionNodeId: 'desktop',
      objective: 'Finish the persisted objective.',
      status: 'active',
      revision: 2,
      controlRevision: 1,
      round: 1,
      pendingRound,
      updatedAt: new Date().toISOString(),
    };
    const store: GoalStore = {
      get: async () => structuredClone(goal),
      save: async (value, revision) => {
        if (goal.revision !== revision) return false;
        goal = structuredClone(value);
        return true;
      },
      listActive: async () => ({ items: goal.status === 'active' ? [goal] : [] }),
    };
    const runStateStore = new MemoryAgentRunStateStore();
    await runStateStore.createOrGet({
      runId: 'saved-run',
      conversationId: 'chat',
      definitionId: definition.id,
      requestPeerId: 'desktop',
      requestId: pendingRound.requestId,
      turnId: pendingRound.turnId,
      payloadDigest: sha256HexSync(domainSeparatedCanonicalJsonBytes('memeloop-run-payload-v1', {
        conversationId: 'chat',
        definitionId: definition.id,
        message: pendingRound.message,
        turnId: pendingRound.turnId,
      })),
      state,
      acceptedAt: Date.now(),
      updatedAt: Date.now(),
    });
    const requests: PortableLlmRequest[] = [];
    const provider: ILLMProvider = {
      name: 'acceptance-recovery',
      async *chat(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: 'tool-call', toolCallId: 'complete-saved-goal', toolName: 'goal', input: { action: 'complete', evidence: 'Original acceptance recovered once.' } };
        } else {
          yield { type: 'text-delta', id: 'saved-final', text: 'Recovered final output.' };
        }
        yield { type: 'finish', finishReason: 'stop' };
      },
    };
    const registry = new ProviderRegistry();
    registry.register({ ownerId: 'test', kind: 'host' }, provider, {
      models: [{ modelId: 'test-model', wireModelId: 'test-model', apiMode: 'chat-completions' }],
    });
    const coordinator = new GoalCoordinator({ store, executionNodeId: 'desktop', getRuntime: async () => runtime });
    const runtime = createMemeLoopRuntime({
      storage,
      llmProvider: provider,
      modelProviderRegistry: registry,
      defaultModelConfig: { providerId: provider.name, modelId: 'test-model' },
      tools: { registerTool: vi.fn(), hasTool: () => false, getTool: () => undefined, listTools: () => [] },
      localNodeId: 'desktop',
      syncAdapters: [],
      network: { start: async () => {}, stop: async () => {} },
      goals: coordinator,
    }, { runStateStore });
    try {
      await coordinator.restore();
      const replay = { conversationId: 'chat', definitionId: definition.id, requestPeerId: 'desktop', ...pendingRound };
      const handles = await Promise.all([runtime.sendMessage(replay), runtime.sendMessage(replay)]);
      expect(handles.map(handle => handle.runId)).toEqual(['saved-run', 'saved-run']);
      await vi.waitFor(async () => {
        expect((await runtime.getRunStatus('saved-run'))?.state).toBe('completed');
        expect(goal.status).toBe('completed');
      });
      expect(goal.round).toBe(1);
      expect(goal.evidence).toBe('Original acceptance recovered once.');
      expect(requests).toHaveLength(2);
      expect(storage.state.messages.filter(message => message.role === 'user')).toEqual([
        expect.objectContaining({ messageId: pendingRound.turnId, content: pendingRound.message }),
      ]);
      expect(storage.state.messages.filter(message => message.content === 'Recovered final output.')).toHaveLength(1);
      expect(storage.state.messages.flatMap(message => message.parts).filter(part => part.type === 'tool-result'))
        .toEqual([expect.objectContaining({ toolName: 'goal', isError: false })]);
      await runtime.sendMessage(replay);
      expect(requests).toHaveLength(2);
    } finally {
      await coordinator.suspend();
      await runtime.dispose();
    }
  });

  it.each(
    (['paused', 'blocked', 'completed'] as const).flatMap(status => (['accepted', 'queued', 'running'] as const).map(runState => ({ status, runState }))),
  )('restores $status goal + $runState crash state without replaying its tools, while ordinary runs recover', async ({ status, runState }: {
    status: AgentGoalStatus;
    runState: MemeLoopRunState;
  }) => {
    const definition = { id: 'personal', name: 'Personal', description: 'Recovery test', systemPrompt: '', tools: [], version: '1' };
    const storage = createTestStorage(undefined, { getAgentDefinition: async () => definition });
    storage.state.conversations.set('chat', {
      conversationId: 'chat',
      definitionId: definition.id,
      title: 'Chat',
      isUserInitiated: true,
      lastMessagePreview: '',
      lastMessageTimestamp: 0,
      messageCount: 0,
      originNodeId: 'desktop',
      originClock: 0,
    });
    const runStateStore = new MemoryAgentRunStateStore();
    for (const request of ['goal-request', 'ordinary-request']) {
      await storage.appendLocalEvent({
        kind: 'message',
        eventId: request,
        conversationId: 'chat',
        originNodeId: 'desktop',
        timestamp: Date.now(),
        message: { messageId: request, turnId: request, role: 'user', content: request, parts: [{ type: 'text', text: request }] },
      });
      await runStateStore.createOrGet({
        runId: request,
        conversationId: 'chat',
        definitionId: definition.id,
        turnId: request,
        requestPeerId: 'desktop',
        requestId: request,
        payloadDigest: 'a'.repeat(64),
        state: runState,
        acceptedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    await storage.appendLocalEvent({
      kind: 'message',
      eventId: 'saved-final',
      conversationId: 'chat',
      originNodeId: 'desktop',
      timestamp: Date.now(),
      message: {
        messageId: 'saved-final',
        turnId: 'goal-request',
        role: 'assistant',
        content: 'Previously verified output',
        parts: [{ type: 'text', text: 'Previously verified output' }],
      },
    });
    const goal: AgentGoal = {
      id: 'goal-1',
      conversationId: 'chat',
      definitionId: definition.id,
      executionNodeId: 'desktop',
      objective: 'Original objective',
      status,
      revision: 4,
      controlRevision: 4,
      round: 1,
      pendingRound: { requestId: 'goal-request', turnId: 'goal-request', message: 'goal-request', runId: 'goal-request' },
      ...(status === 'completed' ? { evidence: 'Persisted evidence' } : {}),
      updatedAt: new Date().toISOString(),
    };
    const requests: PortableLlmRequest[] = [];
    const provider: ILLMProvider = {
      name: 'recovery-provider',
      async *chat(request) {
        requests.push(request);
        yield { type: 'text-delta', id: 'ordinary-final', text: 'Ordinary run recovered' };
        yield { type: 'finish', finishReason: 'stop' };
      },
    };
    const registry = new ProviderRegistry();
    registry.register({ ownerId: 'test', kind: 'host' }, provider, {
      models: [{ modelId: 'test-model', wireModelId: 'test-model', apiMode: 'chat-completions' }],
    });
    const runtime = createMemeLoopRuntime({
      storage,
      llmProvider: provider,
      modelProviderRegistry: registry,
      defaultModelConfig: { providerId: provider.name, modelId: 'test-model' },
      tools: { registerTool: vi.fn(), hasTool: () => false, getTool: () => undefined, listTools: () => [] },
      localNodeId: 'desktop',
      syncAdapters: [],
      network: { start: async () => {}, stop: async () => {} },
      goals: { get: async () => goal, completeFromRun: vi.fn(), blockFromRun: vi.fn() },
    }, { runStateStore });
    try {
      await vi.waitFor(async () => {
        expect((await runtime.getRunStatus('ordinary-request'))?.state).toBe('completed');
      });
      expect((await runtime.getRunStatus('goal-request'))?.state).toBe('cancelled');
      expect(requests).toHaveLength(1);
      expect(goal.status).toBe(status);
      expect(storage.state.messages.filter(message => message.content === 'Previously verified output')).toHaveLength(1);
      if (status === 'completed') expect(goal.evidence).toBe('Persisted evidence');
    } finally {
      await runtime.dispose();
    }
  });

  it.each(['agent-agent-loop', 'agent-tool-loop'])('completes a persistent goal explicitly from a custom %s mjs facade', async loopId => {
    const definition = {
      id: 'custom',
      name: 'Custom loop',
      description: 'Custom goal workflow',
      systemPrompt: '',
      tools: [],
      version: '1',
      loopId,
      scriptReference: {
        kind: 'source' as const,
        source: `export default async function run(ctx) {
          const goal = await ctx.goal.get();
          if (goal.round === 1) { ctx.finish("First round progress"); return; }
          await ctx.goal.complete("Verified full objective: " + goal.objective);
          ctx.finish("Custom loop finished");
        }`,
        name: 'custom-goal.mjs',
      },
    };
    const storage = createTestStorage(undefined, { getAgentDefinition: async () => definition });
    let goal: AgentGoal | null = null;
    const store: GoalStore = {
      get: async () => structuredClone(goal),
      save: async (value, revision) => {
        if ((goal?.revision ?? null) !== revision) return false;
        goal = structuredClone(value);
        return true;
      },
      listActive: async () => ({ items: goal?.status === 'active' ? [goal] : [] }),
    };
    const coordinator = new GoalCoordinator({ store, executionNodeId: 'desktop', getRuntime: async () => runtime, continuationDelayMs: 1 });
    const provider: ILLMProvider = { name: 'unused', chat: vi.fn(async () => 'This script owns the workflow.') };
    const registry = new ProviderRegistry();
    registry.register({ ownerId: 'test', kind: 'host' }, provider, {
      models: [{ modelId: 'test-model', wireModelId: 'test-model', apiMode: 'chat-completions' }],
    });
    const runtime = createMemeLoopRuntime({
      storage,
      llmProvider: provider,
      modelProviderRegistry: registry,
      defaultModelConfig: { providerId: provider.name, modelId: 'test-model' },
      tools: { registerTool: vi.fn(), hasTool: () => false, getTool: () => undefined, listTools: () => [] },
      localNodeId: 'desktop',
      syncAdapters: [],
      network: { start: async () => {}, stop: async () => {} },
      goals: coordinator,
      loopScriptPolicy: { allowSource: true, scriptLoadGate: { admitScriptLoad: () => ({ allowed: true, trustClass: 'trusted' }) } },
    }, { runStateStore: new MemoryAgentRunStateStore() });
    const { conversationId } = await runtime.createAgent({ definitionId: definition.id });
    try {
      await coordinator.start({ conversationId, definitionId: definition.id, objective: 'Finish the custom workflow.' });
      await vi.waitFor(async () => {
        expect((await store.get(conversationId))?.status).toBe('completed');
      }, { timeout: 5000 });
      expect((await store.get(conversationId))?.round).toBe(2);
      expect((await store.get(conversationId))?.evidence).toBe('Verified full objective: Finish the custom workflow.');
      expect(provider.chat).not.toHaveBeenCalled();
    } finally {
      await coordinator.suspend();
      await runtime.dispose();
    }
  });

  it('continues after an orderly real runtime dispose/reopen with the same persisted objective', async () => {
    const definition = {
      id: 'personal',
      name: 'Personal',
      description: 'Personal assistant',
      systemPrompt: '',
      tools: [],
      version: '1',
    };
    const storage = createTestStorage(undefined, { getAgentDefinition: async () => definition });
    const runStateStore = new MemoryAgentRunStateStore();
    let goal: AgentGoal | null = null;
    const store: GoalStore = {
      get: async () => structuredClone(goal),
      save: async (value, revision) => {
        if ((goal?.revision ?? null) !== revision) return false;
        goal = structuredClone(value);
        return true;
      },
      listActive: async () => ({ items: goal?.status === 'active' ? [goal] : [] }),
    };
    let requests = 0;
    const provider: ILLMProvider = {
      name: 'scripted-reopen',
      async *chat(request) {
        requests += 1;
        if (requests === 1) {
          yield { type: 'text-delta', id: 'progress', text: 'Working' };
          await new Promise<void>(resolve => {
            if (request.signal?.aborted) resolve();
            else {request.signal?.addEventListener('abort', () => {
                resolve();
              }, { once: true });}
          });
          request.signal?.throwIfAborted();
        } else if (requests === 2) {
          yield { type: 'tool-call', toolCallId: 'complete-reopened-goal', toolName: 'goal', input: { action: 'complete', evidence: 'Verified after restart.' } };
        } else {
          yield { type: 'text-delta', id: 'done', text: 'Finished after restart.' };
        }
        yield { type: 'finish', finishReason: 'stop' };
      },
    };
    const registry = new ProviderRegistry();
    registry.register({ ownerId: 'test', kind: 'host' }, provider, {
      models: [{ modelId: 'test-model', wireModelId: 'test-model', apiMode: 'chat-completions' }],
    });
    const createHost = () => {
      const coordinator = new GoalCoordinator({ store, executionNodeId: 'desktop', getRuntime: async () => runtime });
      const runtime = createMemeLoopRuntime({
        storage,
        llmProvider: provider,
        modelProviderRegistry: registry,
        defaultModelConfig: { providerId: provider.name, modelId: 'test-model' },
        tools: { registerTool: vi.fn(), hasTool: () => false, getTool: () => undefined, listTools: () => [] },
        localNodeId: 'desktop',
        syncAdapters: [],
        network: { start: async () => {}, stop: async () => {} },
        goals: coordinator,
      }, { runStateStore });
      return { coordinator, runtime };
    };
    const first = createHost();
    const { conversationId } = await first.runtime.createAgent({ definitionId: definition.id });
    await first.coordinator.start({ conversationId, definitionId: definition.id, objective: 'Retain the whole objective across restart.' });
    await vi.waitFor(() => {
      expect(requests).toBe(1);
    });
    await first.coordinator.suspend();
    await first.runtime.dispose();
    expect((await store.get(conversationId))?.status).toBe('active');
    const second = createHost();
    try {
      await second.coordinator.restore();
      await vi.waitFor(async () => {
        expect((await store.get(conversationId))?.status).toBe('completed');
        expect(storage.state.messages.some(message => message.content === 'Finished after restart.')).toBe(true);
      }, { timeout: 5000 });
      expect((await store.get(conversationId))?.round).toBe(2);
      expect((await store.get(conversationId))?.objective).toBe('Retain the whole objective across restart.');
    } finally {
      await second.coordinator.suspend();
      await second.runtime.dispose();
    }
  });

  it('offers the goal tool to the matching pending run and persists explicit completion through its real invocation', async () => {
    const requests: PortableLlmRequest[] = [];
    const definition = {
      id: 'personal',
      name: 'Personal',
      description: 'Personal assistant',
      systemPrompt: 'Complete the assigned work.',
      tools: [],
      version: '1',
    };
    const storage = createTestStorage(undefined, { getAgentDefinition: async () => definition });
    let goal: AgentGoal | null = null;
    const store: GoalStore = {
      get: async () => structuredClone(goal),
      save: async (value, revision) => {
        if ((goal?.revision ?? null) !== revision) return false;
        goal = structuredClone(value);
        return true;
      },
      listActive: async () => ({ items: goal?.status === 'active' ? [goal] : [] }),
    };
    const coordinator = new GoalCoordinator({
      store,
      executionNodeId: 'desktop',
      getRuntime: async () => runtime,
    });
    const provider: ILLMProvider = {
      name: 'scripted',
      async *chat(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: 'tool-call', toolCallId: 'complete-goal', toolName: 'goal', input: { action: 'complete', evidence: 'Saved note read back exactly.' } };
        } else {
          yield { type: 'text-delta', id: 'final', text: 'Verified and saved.' };
        }
        yield { type: 'finish', finishReason: 'stop' };
      },
    };
    const registry = new ProviderRegistry();
    registry.register({ ownerId: 'test', kind: 'host' }, provider, {
      models: [{ modelId: 'test-model', wireModelId: 'test-model', apiMode: 'chat-completions' }],
    });
    const runtime: MemeLoopRuntime = createMemeLoopRuntime({
      storage,
      llmProvider: provider,
      modelProviderRegistry: registry,
      defaultModelConfig: { providerId: provider.name, modelId: 'test-model' },
      tools: { registerTool: vi.fn(), hasTool: () => false, getTool: () => undefined, listTools: () => [] },
      localNodeId: 'desktop',
      syncAdapters: [],
      network: { start: async () => {}, stop: async () => {} },
      goals: coordinator,
    }, { runStateStore: new MemoryAgentRunStateStore() });
    const { conversationId } = await runtime.createAgent({ definitionId: definition.id });
    try {
      await coordinator.start({ conversationId, definitionId: definition.id, objective: 'Save and verify the note.' });
      await vi.waitFor(async () => {
        expect((await coordinator.get(conversationId))?.status).toBe('completed');
        expect(storage.state.messages.some(message => message.content === 'Verified and saved.')).toBe(true);
      }, { timeout: 5000 });
      expect(requests[0].tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'goal', inputSchema: expect.objectContaining({ required: ['action'] }) }),
      ]));
      expect(requests[0].messages).toContainEqual({ role: 'system', content: GOAL_SYSTEM_PROMPT });
      expect((await coordinator.get(conversationId))?.evidence).toBe('Saved note read back exactly.');
      expect(storage.state.messages.flatMap(message => message.parts).filter(part => part.type === 'tool-result'))
        .toEqual([expect.objectContaining({ toolName: 'goal', isError: false })]);
      expect(definition.tools).toEqual([]);
      expect(storage.state.messages.filter(message => message.role === 'user')).toHaveLength(1);
      expect(storage.state.messages.find(message => message.role === 'user')?.content).toBe('Save and verify the note.');
      const manual = await runtime.sendMessage({ conversationId, message: 'Ordinary chat.' });
      await vi.waitFor(async () => {
        expect((await runtime.getRunStatus(manual.runId))?.state).toBe('completed');
      });
      expect(requests.at(-1)?.tools?.some(tool => tool.name === 'goal') ?? false).toBe(false);
      expect(requests.at(-1)?.messages.some(message => message.content === GOAL_SYSTEM_PROMPT)).toBe(false);
    } finally {
      coordinator.dispose();
      await runtime.dispose();
    }
  });
});
