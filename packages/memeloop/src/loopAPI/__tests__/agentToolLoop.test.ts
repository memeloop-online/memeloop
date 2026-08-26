import { describe, expect, it, vi } from 'vitest';

import { createTestStorage } from '../../__tests__/testStorage.js';
import { assertCanonicalChatMessageProjection, type ChatMessage } from '../../conversation/index.js';
import { ProviderRegistry } from '../../llm/providerRegistry.js';
import type { PortableLlmStreamPart } from '../../llm/response.js';
import { InMemoryCheckpointStore } from '../../storage/sessionStorage.js';
import { MAX_TOOL_ARGUMENT_CANONICAL_BYTES } from '../../tools/structuredToolArguments.js';
import { MAX_TOOL_RESULT_CANONICAL_BYTES, MEMELOOP_STRUCTURED_TOOL_KEY } from '../../tools/structuredToolResult.js';
import type { AgentFrameworkContext, IChatSyncAdapter, ILLMProvider, INetworkService, IToolRegistry } from '../../types.js';
import { createAgentToolLoopRunner } from '../agent-tool-loop/loop.js';
import { TRANSIENT_MESSAGE_STREAM_LIMITS } from '../agent-tool-loop/turnPrimitives.js';
import { HookRegistry } from '../hooks/registry.js';

function textDelta(text: string, id = 'test-text'): PortableLlmStreamPart {
  return { type: 'text-delta', id, text };
}

function withModelRoute(
  context: Omit<AgentFrameworkContext, 'modelProviderRegistry' | 'defaultModelConfig'>,
  provider: ILLMProvider,
): AgentFrameworkContext {
  const finishedProvider: ILLMProvider = {
    name: provider.name,
    async *chat(request) {
      const response = await provider.chat(request);
      let finished = false;
      if (typeof response === 'string') {
        yield textDelta(response);
      } else if (Symbol.asyncIterator in Object(response)) {
        for await (const part of response as AsyncIterable<PortableLlmStreamPart>) {
          if (part.type === 'finish') finished = true;
          yield part;
        }
      } else {
        const part = response as PortableLlmStreamPart;
        if (part.type === 'finish') finished = true;
        yield part;
      }
      if (!finished) yield { type: 'finish', finishReason: 'stop' };
    },
  };
  const registry = new ProviderRegistry();
  registry.register({ ownerId: `test:${provider.name}`, kind: 'host' }, finishedProvider, {
    models: [{ modelId: 'test-model', wireModelId: 'test-model', apiMode: 'chat-completions' }],
  });
  return {
    ...context,
    modelProviderRegistry: registry,
    defaultModelConfig: { providerId: provider.name, modelId: 'test-model' },
    hooks: context.hooks ?? new HookRegistry(),
  };
}

function createLoopTestStorage(messages: ChatMessage[] = []) {
  return createTestStorage(
    { messages },
    {
      getConversationMeta: async (conversationId) => ({
        conversationId,
        title: 'Loop test',
        lastMessagePreview: '',
        lastMessageTimestamp: 0,
        messageCount: messages.filter((message) => message.conversationId === conversationId)
          .length,
        originNodeId: 'test-node',
        originClock: 0,
        definitionId: 'test:agent',
        isUserInitiated: true,
      }),
      getAgentDefinition: async (id) => ({
        id,
        name: 'Loop test agent',
        description: 'Loop test agent',
        systemPrompt: 'You are a test agent.',
        tools: [],
        version: '1.0.0',
      }),
    },
  );
}

describe('createAgentToolLoopRunner', () => {
  function createContextWithProvider(llmProvider: ILLMProvider) {
    const storage = createLoopTestStorage();

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

    const context: AgentFrameworkContext = withModelRoute(
      {
        storage,
        llmProvider,
        tools,
        syncAdapters,
        network,
        localNodeId: 'test-node',
      },
      llmProvider,
    );

    return { context, storage };
  }

  function createMockContext(chunks: Array<string | PortableLlmStreamPart> = []) {
    const llmProvider: ILLMProvider = {
      name: 'mock',
      async *chat(_request: unknown) {
        for (const chunk of chunks) {
          yield typeof chunk === 'string' ? textDelta(chunk) : chunk;
        }
      },
    };
    return createContextWithProvider(llmProvider);
  }

  it('appends user message and streams llm output as steps', async () => {
    const chunks = ['hello', ' ', 'world'];
    const { context, storage } = createMockContext(chunks);
    const transientMessages: ChatMessage[] = [];
    context.onTransientMessage = vi.fn((message) => {
      transientMessages.push(message);
    });
    const agent = createAgentToolLoopRunner(context);

    const steps = [];
    for await (const step of agent({ conversationId: 'c1', message: 'hi' })) {
      steps.push(step);
    }

    // First step is thinking.
    expect(steps[0].type).toBe('thinking');
    expect(steps[0].data).toMatchObject({ status: 'calling-llm', conversationId: 'c1' });

    // The remaining steps are message chunks.
    const messageSteps = steps.slice(1);
    expect(messageSteps.map((step) => step.data)).toEqual([
      ...chunks.map((text) => textDelta(text)),
      { type: 'finish', finishReason: 'stop' },
    ]);

    // Append-only storage receives the user message and one immutable final
    // assistant message; streaming partials are UI/in-memory state only.
    const appendCalls = storage.state.messages;
    expect(appendCalls).toHaveLength(2);
    const first = appendCalls[0];
    expect(first.conversationId).toBe('c1');
    expect(first.role).toBe('user');
    expect(first.content).toBe('hi');
    const assistantMessage = appendCalls[1];
    expect(assistantMessage.role).toBe('assistant');
    expect(assistantMessage.content).toBe('hello world');
    expect(transientMessages.map((message) => message.content)).toEqual(['hello']);
    expect(new Set(transientMessages.map((message) => message.messageId))).toEqual(
      new Set([assistantMessage.messageId]),
    );
    expect(transientMessages).not.toContainEqual(assistantMessage);
    expect(transientMessages[0]).toMatchObject({
      turnId: first.messageId,
      conversationId: 'c1',
      originNodeId: 'test-node',
      role: 'assistant',
      metadata: { transientStream: { state: 'partial' } },
    });
    expect(() => {
      assertCanonicalChatMessageProjection(transientMessages[0], 'c1');
    }).not.toThrow();

    // Long-history assembly uses the bounded keyset port, never a full-log read.
    expect(storage.getMessagePage).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({
        mode: 'full-content',
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('persists the final assistant message when a transient subscriber fails', async () => {
    const { context, storage } = createMockContext(['hello']);
    context.onTransientMessage = vi.fn(() => {
      throw new Error('renderer closed');
    });
    context.logger = {
      warn: vi.fn(() => {
        throw new Error('logger closed');
      }),
    };

    const agent = createAgentToolLoopRunner(context);
    for await (const _step of agent({ conversationId: 'c1', message: 'hi' })) {
      // Consume the complete turn.
    }

    expect(storage.appendLocalEvent).toHaveBeenCalledTimes(2);
    expect(storage.state.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'hello' });
    expect(context.logger.warn).toHaveBeenCalledWith(
      '[agentToolLoop] transient message subscriber failed:',
      expect.any(Error),
    );
  });

  it('publishes timely accumulated text, reasoning, and tool progress without a transient final', async () => {
    const provider: ILLMProvider = {
      name: 'slow-stream',
      async *chat() {
        yield textDelta('answer');
        await new Promise((resolve) => setTimeout(resolve, 60));
        yield { type: 'reasoning-delta', id: 'reasoning', text: 'thinking' };
        await new Promise((resolve) => setTimeout(resolve, 60));
        yield { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'lookup' };
        yield { type: 'tool-input-delta', toolCallId: 'call-1', delta: '{"query":"x"}' };
        await new Promise((resolve) => setTimeout(resolve, 60));
        yield { type: 'tool-input-end', toolCallId: 'call-1' };
        yield {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'lookup',
          input: { query: 'x' },
        };
        await new Promise((resolve) => setTimeout(resolve, 60));
      },
    };
    const { context, storage } = createContextWithProvider(provider);
    context.agentToolLoop = { enableToolLoop: false };
    const transients: ChatMessage[] = [];
    context.onTransientMessage = (message) => {
      transients.push(structuredClone(message));
    };

    for await (
      const _step of createAgentToolLoopRunner(context)({
        conversationId: 'slow-conversation',
        message: 'go',
      })
    ) {
      // Consume the complete turn.
    }

    expect(transients.length).toBeGreaterThanOrEqual(4);
    expect(transients.some((message) => message.content === 'answer')).toBe(true);
    expect(transients.some((message) => message.reasoning_content === 'thinking')).toBe(true);
    expect(
      transients.some((message) => {
        const stream = message.metadata?.transientStream as
          | { activeToolInputs?: Array<{ toolCallId: string; inputBytes: number }> }
          | undefined;
        return (
          stream?.activeToolInputs?.some(
            (input) => input.toolCallId === 'call-1' && input.inputBytes === 13,
          ) === true
        );
      }),
    ).toBe(true);
    expect(transients.some((message) => message.toolCalls?.[0]?.id === 'call-1')).toBe(true);
    const durable = storage.state.messages.at(-1)!;
    expect(durable).toMatchObject({
      role: 'assistant',
      content: 'answer',
      reasoning_content: 'thinking',
      toolCalls: [{ id: 'call-1', toolName: 'lookup', arguments: { query: 'x' } }],
    });
    expect(transients).not.toContainEqual(durable);
    expect(storage.appendLocalEvent).toHaveBeenCalledTimes(2);
  });

  it('coalesces high-frequency deltas under a hard emission cap and persists once', async () => {
    const chunks = Array.from({ length: 1_024 }, () => 'x');
    const { context, storage } = createMockContext(chunks);
    const subscriber = vi.fn();
    context.onTransientMessage = subscriber;
    let logicalNow = Date.now();
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      logicalNow += TRANSIENT_MESSAGE_STREAM_LIMITS.minimumIntervalMs;
      return logicalNow;
    });
    try {
      for await (
        const _step of createAgentToolLoopRunner(context)({
          conversationId: 'fast-conversation',
          message: 'go',
        })
      ) {
        // Consume the complete turn.
      }
    } finally {
      now.mockRestore();
    }

    expect(subscriber.mock.calls.length).toBeGreaterThan(1);
    expect(subscriber.mock.calls.length).toBeLessThanOrEqual(
      TRANSIENT_MESSAGE_STREAM_LIMITS.emissions,
    );
    expect(storage.state.messages).toHaveLength(2);
    expect(storage.state.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'x'.repeat(chunks.length),
    });
    expect(storage.appendLocalEvent).toHaveBeenCalledTimes(2);
  });

  it('keeps one subscriber call in flight and coalesces a fast burst to its latest snapshot', async () => {
    const provider: ILLMProvider = {
      name: 'slow-subscriber-stream',
      async *chat() {
        for (let index = 0; index < 100; index += 1) yield textDelta('x');
        await new Promise((resolve) => setTimeout(resolve, 225));
      },
    };
    const { context, storage } = createContextWithProvider(provider);
    const contents: string[] = [];
    let concurrent = 0;
    let maximumConcurrent = 0;
    context.onTransientMessage = async (message) => {
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      contents.push(message.content);
      await new Promise((resolve) => setTimeout(resolve, 75));
      concurrent -= 1;
    };

    for await (
      const _step of createAgentToolLoopRunner(context)({
        conversationId: 'slow-subscriber-conversation',
        message: 'go',
      })
    ) {
      // Consume the complete turn.
    }

    expect(maximumConcurrent).toBe(1);
    expect(contents).toEqual(['x', 'x'.repeat(100)]);
    expect(storage.state.messages.at(-1)?.content).toBe('x'.repeat(100));
    expect(storage.appendLocalEvent).toHaveBeenCalledTimes(2);
  });

  it('bounds oversized transient content while retaining the complete durable assistant message', async () => {
    const oversized = '🙂'.repeat(50_000);
    const { context, storage } = createMockContext([oversized]);
    const transients: ChatMessage[] = [];
    context.onTransientMessage = (message) => {
      transients.push(message);
    };
    for await (
      const _step of createAgentToolLoopRunner(context)({
        conversationId: 'oversized-conversation',
        message: 'go',
      })
    ) {
      // Consume the complete turn.
    }

    expect(transients).toHaveLength(1);
    expect(new TextEncoder().encode(transients[0].content).byteLength).toBeLessThanOrEqual(
      160 * 1_024,
    );
    expect(transients[0].content.endsWith('\ud83d')).toBe(false);
    expect(transients[0]).toMatchObject({
      metadata: { transientStream: { textTruncated: true } },
    });
    expect(storage.state.messages.at(-1)?.content).toBe(oversized);
  });

  it('drops pending partials and does not persist an assistant after external cancellation', async () => {
    let releaseProvider: (() => void) | undefined;
    const provider: ILLMProvider = {
      name: 'cancel-stream',
      async *chat() {
        yield textDelta('partial');
        await new Promise<void>((resolve) => {
          releaseProvider = resolve;
        });
        yield textDelta('stale');
      },
    };
    const { context, storage } = createContextWithProvider(provider);
    const transients: ChatMessage[] = [];
    context.onTransientMessage = (message) => {
      transients.push(message);
    };
    const controller = new AbortController();
    const iterator = createAgentToolLoopRunner(context)({
      conversationId: 'cancel-conversation',
      message: 'go',
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    const pending = iterator.next();
    await Promise.resolve();
    controller.abort(new DOMException('cancel test', 'AbortError'));
    // The provider owns an awaited operation; let its async-generator return()
    // settle after Core has already fenced the cancelled turn.
    releaseProvider?.();
    await expect(pending).rejects.toThrow('cancel test');
    const countAtCancellation = transients.length;
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(transients).toHaveLength(countAtCancellation);
    expect(transients.map((message) => message.content)).toEqual(['partial']);
    expect(storage.state.messages.map((message) => message.role)).toEqual(['user']);
    expect(storage.appendLocalEvent).toHaveBeenCalledTimes(1);
  });

  it('removes the in-memory partial and does not persist a final after provider failure', async () => {
    const runtimeMessages: ChatMessage[] = [];
    const provider: ILLMProvider = {
      name: 'error-stream',
      async *chat() {
        yield textDelta('partial');
        throw new Error('provider failed');
      },
    };
    const { context, storage } = createContextWithProvider(provider);
    context.resolveAgentRuntimeView = async (conversationId) => ({
      id: conversationId,
      agentDefId: 'test:agent',
      status: { state: 'working', modified: new Date() },
      created: new Date(),
      messages: runtimeMessages,
      description: 'Transient failure test',
      systemPrompt: 'Test',
      tools: [],
      version: '1.0.0',
    });
    const transients: ChatMessage[] = [];
    context.onTransientMessage = (message) => {
      transients.push(message);
    };

    await expect(
      (async () => {
        for await (
          const _step of createAgentToolLoopRunner(context)({
            conversationId: 'error-conversation',
            message: 'go',
          })
        ) {
          // Consume until the provider fails.
        }
      })(),
    ).rejects.toThrow('provider failed');

    expect(transients.map((message) => message.content)).toEqual(['partial']);
    expect(runtimeMessages).toEqual([]);
    expect(storage.state.messages.map((message) => message.role)).toEqual(['user']);
    expect(storage.appendLocalEvent).toHaveBeenCalledTimes(1);
  });

  it('runs tool loop: executes registry tool then second LLM round', async () => {
    let round = 0;
    const llmProvider: ILLMProvider = {
      name: 'mock',
      async *chat() {
        round += 1;
        if (round === 1) {
          yield textDelta('<tool_use name="echo">{"text":"hi"}</tool_use>');
        } else {
          yield textDelta('final-answer');
        }
      },
    };

    const messageLog: import('../../conversation/index.js').ChatMessage[] = [];
    const storage = createLoopTestStorage(messageLog);

    const tools: IToolRegistry = {
      registerTool: vi.fn(),
      getTool: vi.fn().mockImplementation((id: string) => {
        if (id === 'echo') {
          return async (args: Record<string, unknown>) => ({ result: `echo:${String(args.text)}` });
        }
        return undefined;
      }),
      listTools: vi.fn().mockReturnValue(['echo']),
    };

    const context: AgentFrameworkContext = withModelRoute(
      {
        storage,
        llmProvider,
        tools,
        syncAdapters: [],
        network: {
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
        },
        agentToolLoop: { maxIterations: 8, legacyTextToolCalls: true },
        localNodeId: 'test-node',
      },
      llmProvider,
    );

    const agent = createAgentToolLoopRunner(context);
    const steps = [];
    for await (const step of agent({ conversationId: 'def:abc', message: 'user1' })) {
      steps.push(step);
    }

    const toolSteps = steps.filter((s) => s.type === 'tool');
    expect(toolSteps.length).toBe(1);
    expect(toolSteps[0].data).toMatchObject({ toolId: 'echo' });

    const appended = storage.state.messages;
    const roles = appended.map((message) => message.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
    expect(roles).toContain('tool');
    expect(round).toBe(2);
  });

  it('persists a stable detached tool error for oversized native arguments without execution', async () => {
    let round = 0;
    const oversized = 'x'.repeat(MAX_TOOL_ARGUMENT_CANONICAL_BYTES + 1);
    const provider: ILLMProvider = {
      name: 'hostile-tool-input',
      async *chat() {
        round += 1;
        if (round === 1) {
          yield {
            type: 'tool-call',
            toolCallId: 'call-oversized',
            toolName: 'echo',
            input: { value: oversized },
          } satisfies PortableLlmStreamPart;
        } else {
          yield textDelta('done');
        }
      },
    };
    const { context, storage } = createContextWithProvider(provider);
    const execute = vi.fn(async () => ({ result: 'must-not-run' }));
    context.tools.getTool = vi.fn().mockReturnValue(execute);
    context.tools.listTools = vi.fn().mockReturnValue(['echo']);
    context.agentToolLoop = { maxIterations: 2 };

    for await (
      const _ of createAgentToolLoopRunner(context)({
        conversationId: 'native-oversized-tool-arguments',
        message: 'go',
      })
    ) {
      // Drain the loop.
    }

    const persistedAssistant = storage.state.messages.find(
      (message) => message.role === 'assistant' && message.toolCalls?.length === 1,
    );
    const persistedTool = storage.state.messages.find((message) => message.role === 'tool');
    expect(execute).not.toHaveBeenCalled();
    expect(persistedAssistant?.toolCalls?.[0]?.arguments).toEqual({
      __memeloopToolArgumentError: 'tool_arguments_result_too_large',
    });
    expect(persistedTool).toMatchObject({
      content: 'tool_arguments_result_too_large',
      metadata: {
        isError: true,
        toolParameters: {
          __memeloopToolArgumentError: 'tool_arguments_result_too_large',
        },
      },
    });
    expect(JSON.stringify(storage.state.messages)).not.toContain(oversized);
  });

  it('saves checkpoints through the injected store after a tool turn', async () => {
    let round = 0;
    const llmProvider: ILLMProvider = {
      name: 'mock',
      async *chat() {
        round += 1;
        if (round === 1) {
          yield textDelta('<tool_use name="echo">{"text":"hi"}</tool_use>');
        } else {
          yield textDelta('final-answer');
        }
      },
    };

    const messageLog: import('../../conversation/index.js').ChatMessage[] = [];
    const storage = createLoopTestStorage(messageLog);
    const tools: IToolRegistry = {
      registerTool: vi.fn(),
      getTool: vi.fn().mockImplementation((id: string) => {
        if (id === 'echo') {
          return async (args: Record<string, unknown>) => ({ result: `echo:${String(args.text)}` });
        }
        return undefined;
      }),
      listTools: vi.fn().mockReturnValue(['echo']),
    };
    const checkpointStore = new InMemoryCheckpointStore();
    const context: AgentFrameworkContext = withModelRoute(
      {
        storage,
        llmProvider,
        tools,
        syncAdapters: [],
        network: {
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
        },
        agentToolLoop: {
          maxIterations: 8,
          legacyTextToolCalls: true,
          sessionCheckpoint: { enabled: true, store: checkpointStore },
        },
        localNodeId: 'test-node',
      },
      llmProvider,
    );

    const agent = createAgentToolLoopRunner(context);
    for await (const _ of agent({ conversationId: 'def:checkpoint', message: 'user1' })) {
      /* drain */
    }

    const checkpoint = await checkpointStore.loadCheckpoint('def:checkpoint');
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.messages.map((m) => m.role)).toContain('tool');
  });

  it('persists detailRef when tool returns structured __memeloopToolResult', async () => {
    let round = 0;
    const llmProvider: ILLMProvider = {
      name: 'mock',
      async *chat() {
        round += 1;
        if (round === 1) {
          yield textDelta('<tool_use name="big">{"x":1}</tool_use>');
        } else {
          yield textDelta('done');
        }
      },
    };

    const messageLog: import('../../conversation/index.js').ChatMessage[] = [];
    const storage = createLoopTestStorage(messageLog);

    const tools: IToolRegistry = {
      registerTool: vi.fn(),
      getTool: vi.fn().mockImplementation((id: string) => {
        if (id === 'big') {
          return async () => ({
            [MEMELOOP_STRUCTURED_TOOL_KEY]: {
              summary: 'short summary for model',
              detailRef: { type: 'terminal-session', sessionId: 's1', nodeId: 'n1' },
            },
          });
        }
        return undefined;
      }),
      listTools: vi.fn().mockReturnValue(['big']),
    };

    const context: AgentFrameworkContext = withModelRoute(
      {
        storage,
        llmProvider,
        tools,
        syncAdapters: [],
        network: {
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
        },
        agentToolLoop: { maxIterations: 8, legacyTextToolCalls: true },
        localNodeId: 'test-node',
      },
      llmProvider,
    );

    const agent = createAgentToolLoopRunner(context);
    for await (const _ of agent({ conversationId: 'def:big', message: 'go' })) {
      /* drain */
    }

    const toolMsg = messageLog.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('short summary for model');
    expect(toolMsg?.detailRef).toEqual({
      type: 'terminal-session',
      sessionId: 's1',
      nodeId: 'n1',
    });
  });

  it('turns hostile or oversized plugin results into bounded typed tool errors', async () => {
    let getterCalls = 0;
    const cases: Array<{ expectedCode: string; result: () => unknown }> = [
      {
        expectedCode: 'tool_result_unsafe_result',
        result: () =>
          Object.defineProperty({}, 'result', {
            enumerable: true,
            get() {
              getterCalls += 1;
              return 'must-not-run';
            },
          }),
      },
      {
        expectedCode: 'tool_result_unsafe_result',
        result: () => {
          const cyclic: Record<string, unknown> = {};
          cyclic.self = cyclic;
          return cyclic;
        },
      },
      {
        expectedCode: 'tool_result_result_too_large',
        result: () => ({ result: 'x'.repeat(MAX_TOOL_RESULT_CANONICAL_BYTES) }),
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      let round = 0;
      const llmProvider: ILLMProvider = {
        name: `hostile-result-${index}`,
        async *chat() {
          round += 1;
          yield textDelta(round === 1 ? '<tool_use name="hostile">{}</tool_use>' : 'done');
        },
      };
      const messageLog: ChatMessage[] = [];
      const storage = createLoopTestStorage(messageLog);
      const tools: IToolRegistry = {
        registerTool: vi.fn(),
        getTool: vi.fn().mockReturnValue(async () => testCase.result()),
        listTools: vi.fn().mockReturnValue(['hostile']),
      };
      const context = withModelRoute(
        {
          storage,
          llmProvider,
          tools,
          syncAdapters: [],
          network: {
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
          },
          agentToolLoop: { maxIterations: 8, legacyTextToolCalls: true },
          localNodeId: 'test-node',
          logger: { warn: vi.fn() },
        },
        llmProvider,
      );

      for await (
        const _step of createAgentToolLoopRunner(context)({
          conversationId: `def:hostile-${index}`,
          message: 'go',
        })
      ) {
        // Drain the complete turn.
      }

      const toolMessage = messageLog.find((message) => message.role === 'tool');
      expect(toolMessage).toMatchObject({
        content: testCase.expectedCode,
        parts: [
          {
            type: 'tool-result',
            result: testCase.expectedCode,
            isError: true,
          },
        ],
      });
      expect(toolMessage).not.toHaveProperty('detailRef');
      expect(toolMessage?.parts?.[0]).not.toHaveProperty('payload');
      expect(new TextEncoder().encode(toolMessage?.content ?? '').byteLength).toBeLessThan(128);
    }
    expect(getterCalls).toBe(0);
  });

  it('waits for terminal session when tool sets awaitSessionId and waitForTerminalSession is configured', async () => {
    let round = 0;
    const llmProvider: ILLMProvider = {
      name: 'mock',
      async *chat() {
        round += 1;
        if (round === 1) {
          yield textDelta('<tool_use name="term">{}</tool_use>');
        } else {
          yield textDelta('done after await');
        }
      },
    };

    const messageLog: import('../../conversation/index.js').ChatMessage[] = [];
    const storage = createLoopTestStorage(messageLog);

    const tools: IToolRegistry = {
      registerTool: vi.fn(),
      getTool: vi.fn().mockImplementation((id: string) => {
        if (id === 'term') {
          return async () => ({
            [MEMELOOP_STRUCTURED_TOOL_KEY]: {
              summary: '[terminal.await] running',
              awaitSessionId: 'sid-1',
              detailRef: { type: 'terminal-session', sessionId: 'sid-1', nodeId: 'n1' },
            },
          });
        }
        return undefined;
      }),
      listTools: vi.fn().mockReturnValue(['term']),
    };

    const waitForTerminalSession = vi.fn().mockResolvedValue({
      exitCode: 0,
      truncatedOutput: 'final output',
    });

    const context: AgentFrameworkContext = withModelRoute(
      {
        storage,
        llmProvider,
        tools,
        syncAdapters: [],
        network: {
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
        },
        agentToolLoop: { maxIterations: 8, waitForTerminalSession, legacyTextToolCalls: true },
        localNodeId: 'test-node',
      },
      llmProvider,
    );

    const agent = createAgentToolLoopRunner(context);
    for await (const _ of agent({ conversationId: 'def:term', message: 'go' })) {
      /* drain */
    }

    expect(waitForTerminalSession).toHaveBeenCalledWith('sid-1');
    expect(
      messageLog.some((m) => m.role === 'tool' && m.content.includes('terminal.await done')),
    ).toBe(true);
  });

  it('handles LLM provider that returns a Promise resolving to an AsyncIterable (streaming)', async () => {
    const messageLog: import('../../conversation/index.js').ChatMessage[] = [];
    const llmProvider: ILLMProvider = {
      name: 'stream-promise',
      chat() {
        async function* gen() {
          yield textDelta('a', 'a');
          yield textDelta('b', 'b');
        }
        return Promise.resolve(gen());
      },
    };
    const storage = createLoopTestStorage(messageLog);
    const tools: IToolRegistry = {
      registerTool: vi.fn(),
      getTool: vi.fn(),
      listTools: vi.fn().mockReturnValue([]),
    };
    const context: AgentFrameworkContext = withModelRoute(
      {
        storage,
        llmProvider,
        tools,
        syncAdapters: [],
        network: {
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
        },
        agentToolLoop: { maxIterations: 4 },
        localNodeId: 'test-node',
      },
      llmProvider,
    );
    const agent = createAgentToolLoopRunner(context);
    const steps = [];
    for await (const step of agent({ conversationId: 'c-stream', message: 'hi' })) {
      steps.push(step);
    }
    const messageSteps = steps.filter((s) => s.type === 'message');
    expect(messageSteps.map((step) => step.data)).toEqual([
      textDelta('a', 'a'),
      textDelta('b', 'b'),
      { type: 'finish', finishReason: 'stop' },
    ]);
    expect(storage.appendLocalEvent).toHaveBeenCalled();
  });

  it('applies tool permission deny by wildcard', async () => {
    const messageLog: import('../../conversation/index.js').ChatMessage[] = [];
    const llmProvider: ILLMProvider = {
      name: 'mock',
      async *chat() {
        yield textDelta('<tool_use name="terminal.execute">{"command":"echo hi"}</tool_use>');
      },
    };
    const storage = createLoopTestStorage(messageLog);
    const tools: IToolRegistry = {
      registerTool: vi.fn(),
      getTool: vi.fn().mockReturnValue(async () => ({ result: 'should-not-run' })),
      listTools: vi.fn().mockReturnValue(['terminal.execute']),
    };
    const context: AgentFrameworkContext = withModelRoute(
      {
        storage,
        llmProvider,
        tools,
        syncAdapters: [],
        network: {
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
        },
        agentToolLoop: {
          maxIterations: 2,
          legacyTextToolCalls: true,
          toolPermissions: { rules: [{ pattern: 'terminal.*', action: 'deny' }] },
        },
        localNodeId: 'test-node',
      },
      llmProvider,
    );
    const agent = createAgentToolLoopRunner(context);
    for await (const _step of agent({ conversationId: 'deny:1', message: 'go' })) {
      // consume
    }
    expect(tools.getTool).not.toHaveBeenCalled();
    const deniedMessages = storage.state.messages.filter((message) => message.role === 'tool');
    expect(deniedMessages).toHaveLength(2);
    expect(new Set(deniedMessages.map((message) => message.messageId)).size).toBe(2);
  });

  it('applies tool permission deny in parallel calls', async () => {
    const messageLog: import('../../conversation/index.js').ChatMessage[] = [];
    const llmProvider: ILLMProvider = {
      name: 'mock',
      async *chat() {
        yield textDelta(
          '<function_calls parallel="true"><tool_use name="terminal.execute">{"command":"echo a"}</tool_use><tool_use name="terminal.execute">{"command":"echo b"}</tool_use></function_calls>',
        );
      },
    };
    const storage = createLoopTestStorage(messageLog);
    const tools: IToolRegistry = {
      registerTool: vi.fn(),
      getTool: vi.fn().mockReturnValue(async () => ({ result: 'should-not-run' })),
      listTools: vi.fn().mockReturnValue(['terminal.execute']),
    };
    const context: AgentFrameworkContext = withModelRoute(
      {
        storage,
        llmProvider,
        tools,
        syncAdapters: [],
        network: {
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
        },
        agentToolLoop: {
          maxIterations: 2,
          legacyTextToolCalls: true,
          toolPermissions: { rules: [{ pattern: 'terminal.*', action: 'deny' }] },
        },
        localNodeId: 'test-node',
      },
      llmProvider,
    );
    const agent = createAgentToolLoopRunner(context);
    for await (const _step of agent({ conversationId: 'deny:parallel', message: 'go' })) {
      // consume
    }
    expect(tools.getTool).not.toHaveBeenCalled();
    const deniedMessages = storage.state.messages.filter((message) => message.role === 'tool');
    expect(deniedMessages).toHaveLength(4);
    expect(new Set(deniedMessages.map((message) => message.messageId)).size).toBe(4);
  });
});
