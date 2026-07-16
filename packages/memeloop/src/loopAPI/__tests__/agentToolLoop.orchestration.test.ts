import { describe, expect, it, vi } from 'vitest';

import type { AgentOrchestrationClient } from '../../orchestration/client.js';
import { TOOL_OPERATION_API_VERSION, TOOL_OPERATION_KIND, type ToolOperationResource } from '../../orchestration/resources.js';
import type { AgentFrameworkContext, IAgentStorage, ILLMProvider, INetworkService, IToolRegistry } from '../../types.js';
import { createAgentToolLoopRunner } from '../agent-tool-loop/loop.js';

function completedOperation(name: string, value: unknown): ToolOperationResource {
  return {
    apiVersion: TOOL_OPERATION_API_VERSION,
    kind: TOOL_OPERATION_KIND,
    metadata: {
      name,
      uid: `uid-${name}`,
      generation: 1,
      resourceVersion: '1',
      creationTimestamp: new Date().toISOString(),
    },
    spec: {
      toolRef: { kind: 'BuiltinTool', name: 'echo' },
      effect: 'execute',
    },
    status: {
      phase: 'Completed',
      result: { value },
      attempts: 1,
    },
  };
}

function failedOperation(name: string, message: string): ToolOperationResource {
  const resource = completedOperation(name, undefined);
  resource.status = {
    phase: 'Failed',
    result: { error: { code: 'EXECUTION_FAILED', message, retryable: false } },
    attempts: 1,
  };
  return resource;
}

function createContext(options: {
  orchestration?: AgentOrchestrationClient;
  echoImpl?: (args: Record<string, unknown>) => unknown;
}) {
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

  const tools: IToolRegistry = {
    registerTool: vi.fn(),
    getTool: vi.fn().mockImplementation((id: string) => {
      if (id === 'echo' && options.echoImpl) return options.echoImpl;
      return undefined;
    }),
    listTools: vi.fn().mockReturnValue(options.echoImpl ? ['echo'] : []),
  };

  const network: INetworkService = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };

  const context: AgentFrameworkContext = {
    storage,
    llmProvider,
    tools,
    syncAdapters: [],
    network,
    ...(options.orchestration ? { orchestration: options.orchestration } : {}),
  };

  return { context, messageLog, tools };
}

function createClient(overrides: Partial<AgentOrchestrationClient> = {}): AgentOrchestrationClient {
  return {
    getCapabilities: vi.fn().mockResolvedValue({
      operations: ['apply', 'get', 'list', 'watch', 'delete'],
      resourceKinds: [TOOL_OPERATION_KIND],
      interfaces: [],
    }),
    apply: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn(),
    watch: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  };
}

describe('AgentToolLoop ToolOperation routing', () => {
  it('executes tools through the orchestration facade and skips the local registry', async () => {
    const client = createClient({
      apply: vi.fn().mockImplementation(async (manifest: { metadata: { name?: string } }) => completedOperation(manifest.metadata.name ?? 'op', { result: 'echo:hi' })),
    });
    const { context, messageLog, tools } = createContext({
      orchestration: client,
      echoImpl: async () => ({ result: 'should-not-be-used' }),
    });

    const steps = [];
    for await (const step of createAgentToolLoopRunner(context)({ conversationId: 'c1', message: 'hi' })) {
      steps.push(step);
    }

    expect(client.apply).toHaveBeenCalledTimes(1);
    const manifest = (client.apply as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      apiVersion: string;
      kind: string;
      spec: { toolRef: { name: string }; arguments?: Record<string, unknown>; effect: string };
    };
    expect(manifest.apiVersion).toBe(TOOL_OPERATION_API_VERSION);
    expect(manifest.kind).toBe(TOOL_OPERATION_KIND);
    expect(manifest.spec.toolRef.name).toBe('echo');
    expect(manifest.spec.arguments).toEqual({ text: 'hi' });
    expect(manifest.spec.effect).toBe('execute');

    expect(tools.getTool).not.toHaveBeenCalled();

    const toolMessage = messageLog.find((m) => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    const toolPart = toolMessage?.parts.find((p) => p.type === 'tool-result');
    expect(toolPart && 'result' in toolPart ? toolPart.result : undefined).toBe('echo:hi');

    const toolStep = steps.find((s) => s.type === 'tool');
    expect(toolStep?.data).toMatchObject({ toolId: 'echo', isError: false, result: 'echo:hi' });
  });

  it('surfaces a Failed ToolOperation as an error tool result', async () => {
    const client = createClient({
      apply: vi.fn().mockImplementation(async (manifest: { metadata: { name?: string } }) => failedOperation(manifest.metadata.name ?? 'op', 'boom')),
    });
    const { context, messageLog } = createContext({ orchestration: client });

    const steps = [];
    for await (const step of createAgentToolLoopRunner(context)({ conversationId: 'c1', message: 'hi' })) {
      steps.push(step);
    }

    const toolStep = steps.find((s) => s.type === 'tool');
    expect(toolStep?.data).toMatchObject({ toolId: 'echo', isError: true, result: 'boom' });
    const toolMessage = messageLog.find((m) => m.role === 'tool');
    expect(toolMessage?.metadata).toMatchObject({ isError: true, toolId: 'echo' });
  });

  it('falls back to the local registry when the facade does not serve ToolOperation', async () => {
    const client = createClient({
      getCapabilities: vi.fn().mockResolvedValue({
        operations: ['apply', 'get'],
        resourceKinds: ['AgentWorkload'],
        interfaces: [],
      }),
    });
    const { context, tools } = createContext({
      orchestration: client,
      echoImpl: async (args) => ({ result: `echo:${String(args.text)}` }),
    });

    const steps = [];
    for await (const step of createAgentToolLoopRunner(context)({ conversationId: 'c1', message: 'hi' })) {
      steps.push(step);
    }

    expect(client.apply).not.toHaveBeenCalled();
    expect(tools.getTool).toHaveBeenCalled();
    const toolStep = steps.find((s) => s.type === 'tool');
    expect(toolStep?.data).toMatchObject({ toolId: 'echo', isError: false, result: 'echo:hi' });
  });

  it('polls a non-terminal ToolOperation until it completes', async () => {
    let getCalls = 0;
    const client = createClient({
      apply: vi.fn().mockImplementation(async (manifest: { metadata: { name?: string } }) => {
        const pending = completedOperation(manifest.metadata.name ?? 'op', undefined);
        pending.status = { phase: 'Running', attempts: 1 };
        return pending;
      }),
      get: vi.fn().mockImplementation(async (reference: { name?: string }) => {
        getCalls += 1;
        if (getCalls < 2) {
          const running = completedOperation(reference.name ?? 'op', undefined);
          running.status = { phase: 'Running', attempts: 1 };
          return running;
        }
        return completedOperation(reference.name ?? 'op', { result: 'echo:hi' });
      }),
    });
    const { context } = createContext({ orchestration: client });

    const steps = [];
    for await (const step of createAgentToolLoopRunner(context)({ conversationId: 'c1', message: 'hi' })) {
      steps.push(step);
    }

    expect(client.get).toHaveBeenCalled();
    const toolStep = steps.find((s) => s.type === 'tool');
    expect(toolStep?.data).toMatchObject({ toolId: 'echo', isError: false, result: 'echo:hi' });
  });
});
