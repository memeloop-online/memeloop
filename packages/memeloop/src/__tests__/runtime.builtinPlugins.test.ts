import { describe, expect, it, vi } from 'vitest';

import { sha256HexSync } from '../encoding/sha256.js';
import { ProviderRegistry } from '../llm/providerRegistry.js';
import type { PortableLlmJsonValue, PortableLlmRequest } from '../llm/request.js';
import { LoopRegistryImpl } from '../loopAPI/registry.js';
import type { LoopPlugin, LoopProfile } from '../loopAPI/types.js';
import { MemoryAgentRunStateStore } from '../runState.js';
import { createAgentLoopRunner, createMemeLoopRuntime, type MemeLoopRuntime } from '../runtime.js';
import { InMemoryTodoStateStore } from '../tools/builtins/todoWrite.js';
import type { AgentFrameworkContext, ILLMProvider, IToolRegistry } from '../types.js';
import { createTestStorage, type TestStorage } from './testStorage.js';

const GENERAL_TOOL_IDS = [
  'mcpClient',
  'mcpForward',
  'spawnAgent',
  'ask-question',
  'todoWrite',
] as const;

function emptyHostTools(): IToolRegistry & { registerTool: ReturnType<typeof vi.fn> } {
  return {
    registerTool: vi.fn(() => {
      throw new Error('Core runtime tools must not mutate the host registry');
    }),
    hasTool: () => false,
    getTool: () => undefined,
    listTools: () => [],
  };
}

function runtimeContext(options: {
  provider: ILLMProvider;
  tools?: IToolRegistry;
  loopRegistry?: LoopRegistryImpl;
}): { context: AgentFrameworkContext; storage: TestStorage } {
  const storage = createTestStorage();
  const providers = new ProviderRegistry();
  providers.register(
    { ownerId: `test:${options.provider.name}`, kind: 'host' },
    options.provider,
    { models: [{ modelId: 'test-model', wireModelId: 'test-model', apiMode: 'chat-completions' }] },
  );
  return {
    storage,
    context: {
      storage,
      llmProvider: options.provider,
      modelProviderRegistry: providers,
      defaultModelConfig: { providerId: options.provider.name, modelId: 'test-model' },
      tools: options.tools ?? emptyHostTools(),
      syncAdapters: [],
      network: { start: async () => undefined, stop: async () => undefined },
      localNodeId: 'runtime-plugin-test-node',
      loopRegistry: options.loopRegistry,
      todoStore: new InMemoryTodoStateStore(),
      agentToolLoop: { maxIterations: 16 },
    },
  };
}

async function waitForRun(runtime: MemeLoopRuntime, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await runtime.getRunStatus(runId);
    const state = status?.state;
    if (state === 'completed') return;
    if (state === 'failed' || state === 'cancelled') {
      throw new Error(`run reached ${state}: ${JSON.stringify(status?.error)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('run did not complete');
}

describe('MemeLoopRuntime builtin plugin ownership', () => {
  it('gives a standalone profile runner a bounded builtin activation scope', async () => {
    let round = 0;
    const requests: PortableLlmRequest[] = [];
    const provider: ILLMProvider = {
      name: 'standalone-provider',
      async *chat(request) {
        requests.push(request);
        round += 1;
        if (round === 1) {
          yield {
            type: 'tool-call',
            toolCallId: 'standalone-todo',
            toolName: 'todoWrite',
            input: { action: 'list' },
          } as const;
        } else {
          yield { type: 'text-delta', id: 'standalone-done', text: 'done' } as const;
        }
        yield { type: 'finish', finishReason: 'stop' } as const;
      },
    };
    const hostTools = emptyHostTools();
    const { context, storage } = runtimeContext({ provider, tools: hostTools });
    storage.state.conversations.set('standalone-conversation', {
      conversationId: 'standalone-conversation',
      title: 'Standalone',
      lastMessagePreview: '',
      lastMessageTimestamp: 0,
      messageCount: 0,
      originNodeId: context.localNodeId!,
      originClock: 0,
      definitionId: 'memeloop:general-assistant',
      isUserInitiated: true,
    });

    const runner = await createAgentLoopRunner(context, {
      definitionId: 'memeloop:general-assistant',
      conversationId: 'standalone-conversation',
    });
    expect(runner).not.toBeNull();
    for await (
      const _step of runner?.({
        conversationId: 'standalone-conversation',
        message: 'list todos',
      }) ?? []
    ) {
      // Drain the bounded standalone runner scope.
    }

    expect(requests[0]?.tools?.map(tool => tool.name)).toEqual(GENERAL_TOOL_IDS);
    expect(storage.state.messages.some(message => message.role === 'tool' && message.parts?.some(part => part.type === 'tool-result' && part.toolName === 'todoWrite'))).toBe(true);
    expect(hostTools.registerTool).not.toHaveBeenCalled();
    expect(hostTools.listTools()).toEqual([]);
  });

  it('runs every general-assistant builtin through an empty host tool registry', async () => {
    const pendingCalls: Array<{ toolName: string; input: PortableLlmJsonValue }> = [
      { toolName: 'mcpClient', input: { nodeId: 'n', serverName: 's', toolName: 't' } },
      { toolName: 'mcpForward', input: { action: 'list' } },
      { toolName: 'spawnAgent', input: {} },
      { toolName: 'ask-question', input: {} },
      { toolName: 'todoWrite', input: { action: 'list' } },
    ];
    const requests: PortableLlmRequest[] = [];
    const provider: ILLMProvider = {
      name: 'empty-host-provider',
      async *chat(request) {
        requests.push(request);
        const call = pendingCalls.shift();
        if (call) {
          yield {
            type: 'tool-call',
            toolCallId: `call-${requests.length}`,
            toolName: call.toolName,
            input: call.input,
          } as const;
        } else {
          yield { type: 'text-delta', id: 'done', text: 'done' } as const;
        }
        yield { type: 'finish', finishReason: 'stop' } as const;
      },
    };
    const hostTools = emptyHostTools();
    const { context, storage } = runtimeContext({ provider, tools: hostTools });
    const runtime = createMemeLoopRuntime(context, {
      runStateStore: new MemoryAgentRunStateStore(),
    });

    await runtime.createAgent({
      definitionId: 'memeloop:general-assistant',
      conversationId: 'general-empty-host',
    });
    const handle = await runtime.sendMessage({
      conversationId: 'general-empty-host',
      definitionId: 'memeloop:general-assistant',
      message: 'exercise builtins',
    });
    await waitForRun(runtime, handle.runId);

    expect(hostTools.registerTool).not.toHaveBeenCalled();
    expect(hostTools.listTools()).toEqual([]);
    expect(requests).toHaveLength(6);
    for (const request of requests) {
      expect(request.tools?.map(tool => tool.name)).toEqual(GENERAL_TOOL_IDS);
    }
    const toolNames = storage.state.messages
      .filter(message => message.role === 'tool')
      .flatMap(message => message.parts ?? [])
      .filter(part => part.type === 'tool-result')
      .map(part => part.toolName);
    expect(toolNames).toEqual(GENERAL_TOOL_IDS);

    await runtime.dispose();
  });

  it('runs the first todoWrite round with an injected native digest provider and no WebCrypto', async () => {
    let round = 0;
    const provider: ILLMProvider = {
      name: 'react-native-todo-provider',
      async *chat() {
        round += 1;
        if (round === 1) {
          yield {
            type: 'tool-call',
            toolCallId: 'mobile-first-todo',
            toolName: 'todoWrite',
            input: { action: 'list' },
          } as const;
        } else {
          yield { type: 'text-delta', id: 'mobile-done', text: 'done' } as const;
        }
        yield { type: 'finish', finishReason: 'stop' } as const;
      },
    };
    const { context, storage } = runtimeContext({ provider });
    const digestCalls: Array<{ envelope: string; signal?: AbortSignal }> = [];
    const sha256Hex = vi.fn((bytes: Uint8Array, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      digestCalls.push({ envelope: new TextDecoder().decode(bytes), signal });
      return sha256HexSync(bytes);
    });
    vi.stubGlobal('crypto', undefined);
    let nextId = 0;
    let runtime: MemeLoopRuntime | undefined;
    try {
      runtime = createMemeLoopRuntime(context, {
        runStateStore: new MemoryAgentRunStateStore(),
        sha256Hex,
        idFactory: () => `mobile-test-${++nextId}`,
      });
      await runtime.createAgent({
        definitionId: 'memeloop:general-assistant',
        conversationId: 'react-native-first-todo',
      });
      const handle = await runtime.sendMessage({
        conversationId: 'react-native-first-todo',
        definitionId: 'memeloop:general-assistant',
        message: 'list todos',
      });
      await waitForRun(runtime, handle.runId);

      const progressDigests = digestCalls.filter(call =>
        call.envelope.includes('memeloop-tool-call-batch-v2') ||
        call.envelope.includes('memeloop-tool-id-batch-v1') ||
        call.envelope.includes('memeloop-tool-progress-v1')
      );
      expect(progressDigests).toHaveLength(2);
      expect(progressDigests.map(call => call.envelope)).toEqual(expect.arrayContaining([
        expect.stringContaining('memeloop-tool-call-batch-v2'),
        expect.stringContaining('memeloop-tool-id-batch-v1'),
      ]));
      expect(progressDigests.every(call => call.signal instanceof AbortSignal)).toBe(true);
      expect(storage.state.messages).toContainEqual(expect.objectContaining({
        role: 'tool',
        parts: expect.arrayContaining([
          expect.objectContaining({ type: 'tool-result', toolName: 'todoWrite' }),
        ]),
      }));
    } finally {
      await runtime?.dispose();
      vi.unstubAllGlobals();
    }
  });

  it('activates custom runtime plugins per runtime and releases only the disposed owner', async () => {
    const installTargets: unknown[] = [];
    const installedRuntimeIds: string[] = [];
    const disposers: Array<ReturnType<typeof vi.fn>> = [];
    const plugin: LoopPlugin = {
      id: 'test:runtime-tool',
      targetLoopId: 'agent-tool-loop',
      activationScope: 'runtime',
      providedToolIds: ['runtimeTool'],
      install(target) {
        installTargets.push(target.toolRegistry);
        installedRuntimeIds.push(String(target.runtimeId));
        const tools = target.toolRegistry as IToolRegistry;
        tools.registerTool('runtimeTool', async () => ({ result: String(target.runtimeId) }));
        const dispose = vi.fn(() => tools.unregisterTool?.('runtimeTool'));
        disposers.push(dispose);
        return dispose;
      },
    };
    const profile: LoopProfile = {
      id: 'test:runtime-profile',
      name: 'Runtime profile',
      description: 'Runtime plugin isolation test',
      loopId: 'agent-tool-loop',
      systemPrompt: 'Call runtimeTool.',
      tools: ['runtimeTool'],
      plugins: [{ id: plugin.id }],
    };
    const loopRegistry = new LoopRegistryImpl();
    loopRegistry.registerPlugin(plugin);
    loopRegistry.registerProfile(profile);
    const sharedHostTools = emptyHostTools();

    const providerFor = (name: string): ILLMProvider => {
      let round = 0;
      return {
        name,
        async *chat() {
          round += 1;
          if (round === 1) {
            yield {
              type: 'tool-call',
              toolCallId: `${name}-call`,
              toolName: 'runtimeTool',
              input: {},
            } as const;
          } else {
            yield { type: 'text-delta', id: `${name}-done`, text: 'done' } as const;
          }
          yield { type: 'finish', finishReason: 'stop' } as const;
        },
      };
    };

    const first = runtimeContext({
      provider: providerFor('runtime-one'),
      tools: sharedHostTools,
      loopRegistry,
    });
    const second = runtimeContext({
      provider: providerFor('runtime-two'),
      tools: sharedHostTools,
      loopRegistry,
    });
    const firstRuntime = createMemeLoopRuntime(first.context, {
      runStateStore: new MemoryAgentRunStateStore(),
    });
    const secondRuntime = createMemeLoopRuntime(second.context, {
      runStateStore: new MemoryAgentRunStateStore(),
    });

    expect(installTargets).toHaveLength(2);
    expect(installTargets[0]).not.toBe(installTargets[1]);
    expect(sharedHostTools.registerTool).not.toHaveBeenCalled();
    await firstRuntime.dispose();
    expect(disposers[0]).toHaveBeenCalledOnce();
    expect(disposers[1]).not.toHaveBeenCalled();

    await secondRuntime.createAgent({
      definitionId: profile.id,
      conversationId: 'second-runtime-conversation',
    });
    const handle = await secondRuntime.sendMessage({
      conversationId: 'second-runtime-conversation',
      definitionId: profile.id,
      message: 'still live',
    });
    await waitForRun(secondRuntime, handle.runId);
    expect(second.storage.state.messages.some(message => message.role === 'tool' && message.content.includes(installedRuntimeIds[1]))).toBe(true);

    await secondRuntime.dispose();
    expect(disposers[1]).toHaveBeenCalledOnce();
    expect(sharedHostTools.listTools()).toEqual([]);
  });
});
