import { describe, expect, it, type MockedFunction, vi } from 'vitest';

import { InMemoryCheckpointStore } from '../../storage/sessionStorage.js';
import { MEMELOOP_STRUCTURED_TOOL_KEY } from '../../tools/structuredToolResult.js';
import type { AgentFrameworkContext, GetMessagesOptions, IAgentStorage, IChatSyncAdapter, ILLMProvider, INetworkService, IToolRegistry } from '../../types.js';
import { createAgentToolLoopRunner } from '../agent-tool-loop/loop.js';

describe('createAgentToolLoopRunner', () => {
  function createMockContext(chunks: unknown[] = []) {
    const storage: IAgentStorage = {
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

    const llmProvider: ILLMProvider = {
      name: 'mock',
      async *chat(_request: unknown) {
        for (const c of chunks) {
          yield c;
        }
      },
    };

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

    const context: AgentFrameworkContext = {
      storage,
      llmProvider,
      tools,
      syncAdapters,
      network,
    };

    return { context, storage };
  }

  it('appends user message and streams llm output as steps', async () => {
    const chunks = ['hello', ' ', 'world'];
    const { context, storage } = createMockContext(chunks);
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
    expect(messageSteps.map((s) => s.data)).toEqual(chunks);

    // Append-only storage receives the user message and one immutable final
    // assistant message; streaming partials are UI/in-memory state only.
    const appendCalls = (storage.appendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      call => call[0] as { conversationId: string; role: string; content: string; messageId: string },
    );
    expect(appendCalls).toHaveLength(2);
    const first = appendCalls[0];
    expect(first.conversationId).toBe('c1');
    expect(first.role).toBe('user');
    expect(first.content).toBe('hi');
    const assistantMessage = appendCalls[1];
    expect(assistantMessage.role).toBe('assistant');
    expect(assistantMessage.content).toBe('hello world');

    // Lamport / history assembly reads the messages multiple times.
    expect(storage.getMessages).toHaveBeenCalledWith('c1', {
      mode: 'full-content',
    } as GetMessagesOptions);
    expect(
      (storage.getMessages as MockedFunction<IAgentStorage['getMessages']>).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('runs tool loop: executes registry tool then second LLM round', async () => {
    let round = 0;
    const llmProvider: ILLMProvider = {
      name: 'mock',
      async *chat() {
        round += 1;
        if (round === 1) {
          yield '<tool_use name="echo">{"text":"hi"}</tool_use>';
        } else {
          yield 'final-answer';
        }
      },
    };

    const messageLog: import('../../conversation/index.js').ChatMessage[] = [];
    const storage: IAgentStorage = {
      listConversations: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockImplementation(async () => [...messageLog]),
      appendMessage: vi.fn().mockImplementation(async (m) => {
        messageLog.push(m);
      }),
      upsertConversationMetadata: vi.fn().mockResolvedValue(undefined),
      insertMessagesIfAbsent: vi.fn().mockResolvedValue(undefined),
      getAttachment: vi.fn().mockResolvedValue(null),
      saveAttachment: vi.fn().mockResolvedValue(undefined),
      getAgentDefinition: vi.fn().mockResolvedValue(null),
      saveAgentInstance: vi.fn().mockResolvedValue(undefined),
      getConversationMeta: vi.fn().mockResolvedValue(null),
    };

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

    const context: AgentFrameworkContext = {
      storage,
      llmProvider,
      tools,
      syncAdapters: [],
      network: {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      agentToolLoop: { maxIterations: 8 },
    };

    const agent = createAgentToolLoopRunner(context);
    const steps = [];
    for await (const step of agent({ conversationId: 'def:abc', message: 'user1' })) {
      steps.push(step);
    }

    const toolSteps = steps.filter((s) => s.type === 'tool');
    expect(toolSteps.length).toBe(1);
    expect(toolSteps[0].data).toMatchObject({ toolId: 'echo' });

    const appended = (storage.appendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    const roles = appended.map(
      (m) => (m as import('../../conversation/index.js').ChatMessage).role,
    );
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
    expect(roles).toContain('tool');
    expect(round).toBe(2);
  });

  it('saves checkpoints through the injected store after a tool turn', async () => {
    let round = 0;
    const llmProvider: ILLMProvider = {
      name: 'mock',
      async *chat() {
        round += 1;
        if (round === 1) {
          yield '<tool_use name="echo">{"text":"hi"}</tool_use>';
        } else {
          yield 'final-answer';
        }
      },
    };

    const messageLog: import('../../conversation/index.js').ChatMessage[] = [];
    const storage: IAgentStorage = {
      listConversations: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockImplementation(async () => [...messageLog]),
      appendMessage: vi.fn().mockImplementation(async (m) => {
        messageLog.push(m);
      }),
      upsertConversationMetadata: vi.fn().mockResolvedValue(undefined),
      insertMessagesIfAbsent: vi.fn().mockResolvedValue(undefined),
      getAttachment: vi.fn().mockResolvedValue(null),
      saveAttachment: vi.fn().mockResolvedValue(undefined),
      getAgentDefinition: vi.fn().mockResolvedValue(null),
      saveAgentInstance: vi.fn().mockResolvedValue(undefined),
      getConversationMeta: vi.fn().mockResolvedValue(null),
    };
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
    const context: AgentFrameworkContext = {
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
        sessionCheckpoint: { enabled: true, store: checkpointStore },
      },
    };

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
          yield '<tool_use name="big">{"x":1}</tool_use>';
        } else {
          yield 'done';
        }
      },
    };

    const messageLog: import('../../conversation/index.js').ChatMessage[] = [];
    const storage: IAgentStorage = {
      listConversations: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockImplementation(async () => [...messageLog]),
      appendMessage: vi.fn().mockImplementation(async (m) => {
        messageLog.push(m);
      }),
      upsertConversationMetadata: vi.fn().mockResolvedValue(undefined),
      insertMessagesIfAbsent: vi.fn().mockResolvedValue(undefined),
      getAttachment: vi.fn().mockResolvedValue(null),
      saveAttachment: vi.fn().mockResolvedValue(undefined),
      getAgentDefinition: vi.fn().mockResolvedValue(null),
      saveAgentInstance: vi.fn().mockResolvedValue(undefined),
      getConversationMeta: vi.fn().mockResolvedValue(null),
    };

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

    const context: AgentFrameworkContext = {
      storage,
      llmProvider,
      tools,
      syncAdapters: [],
      network: {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      agentToolLoop: { maxIterations: 8 },
    };

    const agent = createAgentToolLoopRunner(context);
    for await (const _ of agent({ conversationId: 'def:big', message: 'go' })) {
      /* drain */
    }

    const toolMsg = messageLog.find((m) => m.role === 'tool' && m.content.includes('big'));
    expect(toolMsg?.content).toContain('short summary for model');
    expect(toolMsg?.detailRef).toEqual({
      type: 'terminal-session',
      sessionId: 's1',
      nodeId: 'n1',
    });
  });

  it('waits for terminal session when tool sets awaitSessionId and waitForTerminalSession is configured', async () => {
    let round = 0;
    const llmProvider: ILLMProvider = {
      name: 'mock',
      async *chat() {
        round += 1;
        if (round === 1) {
          yield '<tool_use name="term">{}</tool_use>';
        } else {
          yield 'done after await';
        }
      },
    };

    const messageLog: import('../../conversation/index.js').ChatMessage[] = [];
    const storage: IAgentStorage = {
      listConversations: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockImplementation(async () => [...messageLog]),
      appendMessage: vi.fn().mockImplementation(async (m) => {
        messageLog.push(m);
      }),
      upsertConversationMetadata: vi.fn().mockResolvedValue(undefined),
      insertMessagesIfAbsent: vi.fn().mockResolvedValue(undefined),
      getAttachment: vi.fn().mockResolvedValue(null),
      saveAttachment: vi.fn().mockResolvedValue(undefined),
      getAgentDefinition: vi.fn().mockResolvedValue(null),
      saveAgentInstance: vi.fn().mockResolvedValue(undefined),
      getConversationMeta: vi.fn().mockResolvedValue(null),
    };

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

    const context: AgentFrameworkContext = {
      storage,
      llmProvider,
      tools,
      syncAdapters: [],
      network: {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      agentToolLoop: { maxIterations: 8, waitForTerminalSession },
    };

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
          yield 'a';
          yield 'b';
        }
        return Promise.resolve(gen());
      },
    };
    const storage: IAgentStorage = {
      listConversations: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockImplementation(async () => [...messageLog]),
      appendMessage: vi.fn().mockImplementation(async (m) => {
        messageLog.push(m);
      }),
      upsertConversationMetadata: vi.fn().mockResolvedValue(undefined),
      insertMessagesIfAbsent: vi.fn().mockResolvedValue(undefined),
      getAttachment: vi.fn().mockResolvedValue(null),
      saveAttachment: vi.fn().mockResolvedValue(undefined),
      getAgentDefinition: vi.fn().mockResolvedValue(null),
      saveAgentInstance: vi.fn().mockResolvedValue(undefined),
      getConversationMeta: vi.fn().mockResolvedValue(null),
    };
    const tools: IToolRegistry = {
      registerTool: vi.fn(),
      getTool: vi.fn(),
      listTools: vi.fn().mockReturnValue([]),
    };
    const context: AgentFrameworkContext = {
      storage,
      llmProvider,
      tools,
      syncAdapters: [],
      network: {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      agentToolLoop: { maxIterations: 4 },
    };
    const agent = createAgentToolLoopRunner(context);
    const steps = [];
    for await (const step of agent({ conversationId: 'c-stream', message: 'hi' })) {
      steps.push(step);
    }
    const messageSteps = steps.filter((s) => s.type === 'message');
    expect(messageSteps.map((s) => s.data)).toEqual(['a', 'b']);
    expect(storage.appendMessage).toHaveBeenCalled();
  });

  it('applies tool permission deny by wildcard', async () => {
    const messageLog: import('../../conversation/index.js').ChatMessage[] = [];
    const llmProvider: ILLMProvider = {
      name: 'mock',
      async *chat() {
        yield '<tool_use name="terminal.execute">{"command":"echo hi"}</tool_use>';
      },
    };
    const storage: IAgentStorage = {
      listConversations: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockImplementation(async () => [...messageLog]),
      appendMessage: vi.fn().mockImplementation(async (m) => {
        messageLog.push(m);
      }),
      upsertConversationMetadata: vi.fn().mockResolvedValue(undefined),
      insertMessagesIfAbsent: vi.fn().mockResolvedValue(undefined),
      getAttachment: vi.fn().mockResolvedValue(null),
      saveAttachment: vi.fn().mockResolvedValue(undefined),
      getAgentDefinition: vi.fn().mockResolvedValue(null),
      saveAgentInstance: vi.fn().mockResolvedValue(undefined),
      getConversationMeta: vi.fn().mockResolvedValue(null),
    };
    const tools: IToolRegistry = {
      registerTool: vi.fn(),
      getTool: vi.fn().mockReturnValue(async () => ({ result: 'should-not-run' })),
      listTools: vi.fn().mockReturnValue(['terminal.execute']),
    };
    const context: AgentFrameworkContext = {
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
        toolPermissions: { rules: [{ pattern: 'terminal.*', action: 'deny' }] },
      },
    };
    const agent = createAgentToolLoopRunner(context);
    for await (const _step of agent({ conversationId: 'deny:1', message: 'go' })) {
      // consume
    }
    expect(tools.getTool).not.toHaveBeenCalled();
  });

  it('applies tool permission deny in parallel calls', async () => {
    const messageLog: import('../../conversation/index.js').ChatMessage[] = [];
    const llmProvider: ILLMProvider = {
      name: 'mock',
      async *chat() {
        yield '<function_calls parallel="true"><tool_use name="terminal.execute">{"command":"echo a"}</tool_use><tool_use name="terminal.execute">{"command":"echo b"}</tool_use></function_calls>';
      },
    };
    const storage: IAgentStorage = {
      listConversations: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockImplementation(async () => [...messageLog]),
      appendMessage: vi.fn().mockImplementation(async (m) => {
        messageLog.push(m);
      }),
      upsertConversationMetadata: vi.fn().mockResolvedValue(undefined),
      insertMessagesIfAbsent: vi.fn().mockResolvedValue(undefined),
      getAttachment: vi.fn().mockResolvedValue(null),
      saveAttachment: vi.fn().mockResolvedValue(undefined),
      getAgentDefinition: vi.fn().mockResolvedValue(null),
      saveAgentInstance: vi.fn().mockResolvedValue(undefined),
      getConversationMeta: vi.fn().mockResolvedValue(null),
    };
    const tools: IToolRegistry = {
      registerTool: vi.fn(),
      getTool: vi.fn().mockReturnValue(async () => ({ result: 'should-not-run' })),
      listTools: vi.fn().mockReturnValue(['terminal.execute']),
    };
    const context: AgentFrameworkContext = {
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
        toolPermissions: { rules: [{ pattern: 'terminal.*', action: 'deny' }] },
      },
    };
    const agent = createAgentToolLoopRunner(context);
    for await (const _step of agent({ conversationId: 'deny:parallel', message: 'go' })) {
      // consume
    }
    expect(tools.getTool).not.toHaveBeenCalled();
  });
});
