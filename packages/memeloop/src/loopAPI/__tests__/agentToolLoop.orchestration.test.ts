import { describe, expect, it, vi } from 'vitest';

import { configureLoopTestContext, typedTextChat } from '../../__tests__/testLoopContext.js';
import { createTestStorage } from '../../__tests__/testStorage.js';
import type { AgentOrchestrationClient } from '../../orchestration/client.js';
import { OrchestrationError } from '../../orchestration/errors.js';
import { TOOL_OPERATION_API_VERSION, TOOL_OPERATION_KIND, type ToolOperationResource } from '../../orchestration/resources.js';
import type { AgentFrameworkContext, AgentToolLoopOptions, ILLMProvider, INetworkService, IToolRegistry } from '../../types.js';
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
    result: { error: { code: 'INTERNAL', message, retryable: false } },
    attempts: 1,
  };
  return resource;
}

/** Build a ToolOperationResource from the applied manifest, preserving the spec (idempotencyKey, timeoutMs, ...). */
function operationFromManifest(
  manifest: {
    apiVersion: string;
    kind: string;
    metadata: { name?: string };
    spec: ToolOperationResource['spec'];
  },
  status: ToolOperationResource['status'],
): ToolOperationResource {
  const name = manifest.metadata.name ?? 'op';
  return {
    apiVersion: manifest.apiVersion,
    kind: manifest.kind,
    metadata: {
      name,
      uid: `uid-${name}`,
      generation: 1,
      resourceVersion: '1',
      creationTimestamp: new Date().toISOString(),
    },
    spec: manifest.spec,
    status,
  };
}

function createContext(options: {
  orchestration?: AgentOrchestrationClient;
  echoImpl?: (args: Record<string, unknown>) => unknown;
  agentToolLoop?: AgentToolLoopOptions;
  /** Tool-use rounds before the final answer (default 1). */
  toolRounds?: number;
}) {
  const messageLog: import('../../conversation/index.js').ChatMessage[] = [];
  const storage = createTestStorage({ messages: messageLog });

  const toolRounds = options.toolRounds ?? 1;
  let round = 0;
  const llmProvider: ILLMProvider = {
    name: 'mock',
    chat: typedTextChat(async function*() {
      round += 1;
      if (round <= toolRounds) {
        // Round-specific suffix keeps assistant contents distinct so the loop's
        // duplicate-output detection does not treat round N as already handled.
        yield `<tool_use name="echo">{"text":"hi"}</tool_use> [round ${round}]`;
      } else {
        yield 'final-answer';
      }
    }),
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
    localNodeId: 'test-node',
    ...(options.orchestration ? { orchestration: options.orchestration } : {}),
    ...(options.agentToolLoop ? { agentToolLoop: options.agentToolLoop } : {}),
  };

  configureLoopTestContext(context);
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
      apply: vi
        .fn()
        .mockImplementation(async (manifest: { metadata: { name?: string } }) => completedOperation(manifest.metadata.name ?? 'op', { result: 'echo:hi' })),
    });
    const { context, messageLog, tools } = createContext({
      orchestration: client,
      echoImpl: async () => ({ result: 'should-not-be-used' }),
    });

    const steps = [];
    for await (
      const step of createAgentToolLoopRunner(context)({
        conversationId: 'c1',
        message: 'hi',
      })
    ) {
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
    if (toolMessage === undefined) throw new Error('expected persisted tool message');
    const toolPart = toolMessage.parts?.find((p) => p.type === 'tool-result');
    expect(toolPart && 'result' in toolPart ? toolPart.result : undefined).toBe('echo:hi');

    const toolStep = steps.find((s) => s.type === 'tool');
    expect(toolStep?.data).toMatchObject({ toolId: 'echo', isError: false, result: 'echo:hi' });
  });

  it('fails closed when apply returns a matching kind with an invalid resource schema', async () => {
    const client = createClient({
      apply: vi.fn().mockResolvedValue({
        apiVersion: TOOL_OPERATION_API_VERSION,
        kind: TOOL_OPERATION_KIND,
        metadata: { name: 'malformed' },
        spec: { toolRef: { kind: 'BuiltinTool', name: 'echo' }, effect: 'execute' },
      }),
    });
    const { context } = createContext({ orchestration: client });

    const steps = [];
    for await (
      const step of createAgentToolLoopRunner(context)({
        conversationId: 'c-malformed-tool-operation',
        message: 'hi',
      })
    ) {
      steps.push(step);
    }

    expect(steps.find((step) => step.type === 'tool')?.data).toMatchObject({
      toolId: 'echo',
      isError: true,
      result: expect.stringContaining('canonical resource schema'),
    });
  });

  it('uses the host-authoritative tool effect instead of a caller-selected effect', async () => {
    const client = createClient({
      apply: vi.fn().mockImplementation(async (manifest: { metadata: { name?: string } }) =>
        completedOperation(manifest.metadata.name ?? 'op', {
          result: 'updated',
        })
      ),
    });
    const { context } = createContext({ orchestration: client });
    context.tools.getToolEffect = () => 'update';

    for await (
      const _step of createAgentToolLoopRunner(context)({
        conversationId: 'c-effect',
        message: 'update it',
      })
    ) {
      void _step;
    }

    expect(client.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: expect.objectContaining({ effect: 'update' }),
      }),
      expect.objectContaining({ deadline: expect.any(String) }),
    );
  });

  it('surfaces a Failed ToolOperation as an error tool result', async () => {
    const client = createClient({
      apply: vi
        .fn()
        .mockImplementation(async (manifest: { metadata: { name?: string } }) => failedOperation(manifest.metadata.name ?? 'op', 'boom')),
    });
    const { context, messageLog } = createContext({ orchestration: client });

    const steps = [];
    for await (
      const step of createAgentToolLoopRunner(context)({
        conversationId: 'c1',
        message: 'hi',
      })
    ) {
      steps.push(step);
    }

    const toolStep = steps.find((s) => s.type === 'tool');
    expect(toolStep?.data).toMatchObject({ toolId: 'echo', isError: true, result: 'boom' });
    const toolMessage = messageLog.find((m) => m.role === 'tool');
    expect(toolMessage?.metadata).toMatchObject({ isError: true, toolId: 'echo' });
  });

  it('canonicalizes remote completed values without invoking hostile accessors', async () => {
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, 'result', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'must-not-run';
      },
    });
    const client = createClient({
      apply: vi
        .fn()
        .mockImplementation(async (manifest: { metadata: { name?: string } }) => completedOperation(manifest.metadata.name ?? 'op', hostile)),
    });
    const { context, messageLog } = createContext({ orchestration: client });

    const steps = [];
    for await (
      const step of createAgentToolLoopRunner(context)({
        conversationId: 'c-hostile-remote-result',
        message: 'hi',
      })
    ) {
      steps.push(step);
    }

    expect(getterCalls).toBe(0);
    expect(steps.find((step) => step.type === 'tool')?.data).toMatchObject({
      isError: true,
      result: 'ToolOperation execution error: tool_result_unsafe_result',
    });
    const toolMessage = messageLog.find((message) => message.role === 'tool');
    expect(toolMessage?.parts?.[0]).not.toHaveProperty('payload');
    expect(toolMessage).not.toHaveProperty('detailRef');
  });

  it('fails closed instead of using the local registry when the facade does not serve ToolOperation', async () => {
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
    for await (
      const step of createAgentToolLoopRunner(context)({
        conversationId: 'c1',
        message: 'hi',
      })
    ) {
      steps.push(step);
    }

    expect(client.apply).not.toHaveBeenCalled();
    expect(tools.getTool).not.toHaveBeenCalled();
    const toolStep = steps.find((s) => s.type === 'tool');
    expect(toolStep?.data).toMatchObject({
      toolId: 'echo',
      isError: true,
      result: expect.stringContaining('does not support ToolOperation'),
    });
  });

  it('fails closed instead of using the local registry when capability discovery fails', async () => {
    const client = createClient({
      getCapabilities: vi
        .fn()
        .mockRejectedValue(
          new OrchestrationError({
            code: 'UNAVAILABLE',
            message: 'control plane offline',
            retryable: true,
          }),
        ),
    });
    const { context, tools } = createContext({
      orchestration: client,
      echoImpl: async (args) => ({ result: `echo:${String(args.text)}` }),
    });

    const steps = [];
    for await (
      const step of createAgentToolLoopRunner(context)({
        conversationId: 'c-capability-error',
        message: 'hi',
      })
    ) {
      steps.push(step);
    }

    expect(client.apply).not.toHaveBeenCalled();
    expect(tools.getTool).not.toHaveBeenCalled();
    const toolStep = steps.find((s) => s.type === 'tool');
    expect(toolStep?.data).toMatchObject({
      toolId: 'echo',
      isError: true,
      result: expect.stringContaining('capabilities could not be verified'),
    });
  });

  it('uses the local registry only when the host explicitly selects the local route', async () => {
    const client = createClient();
    const { context, tools } = createContext({
      orchestration: client,
      echoImpl: async (args) => ({ result: `echo:${String(args.text)}` }),
      agentToolLoop: { toolExecutionRoute: 'local' },
    });

    const steps = [];
    for await (
      const step of createAgentToolLoopRunner(context)({
        conversationId: 'c-explicit-local',
        message: 'hi',
      })
    ) {
      steps.push(step);
    }

    expect(client.getCapabilities).not.toHaveBeenCalled();
    expect(client.apply).not.toHaveBeenCalled();
    expect(tools.getTool).toHaveBeenCalled();
    const toolStep = steps.find((s) => s.type === 'tool');
    expect(toolStep?.data).toMatchObject({ toolId: 'echo', isError: false, result: 'echo:hi' });
  });

  it('fails closed when the host requires orchestration but no facade is configured', async () => {
    const { context, tools } = createContext({
      echoImpl: async (args) => ({ result: `echo:${String(args.text)}` }),
      agentToolLoop: { toolExecutionRoute: 'orchestration-required' },
    });

    const steps = [];
    for await (
      const step of createAgentToolLoopRunner(context)({
        conversationId: 'c-missing-facade',
        message: 'hi',
      })
    ) {
      steps.push(step);
    }

    expect(tools.getTool).not.toHaveBeenCalled();
    const toolStep = steps.find((s) => s.type === 'tool');
    expect(toolStep?.data).toMatchObject({
      toolId: 'echo',
      isError: true,
      result: expect.stringContaining('no orchestration facade'),
    });
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
    for await (
      const step of createAgentToolLoopRunner(context)({
        conversationId: 'c1',
        message: 'hi',
      })
    ) {
      steps.push(step);
    }

    expect(client.get).toHaveBeenCalled();
    const toolStep = steps.find((s) => s.type === 'tool');
    expect(toolStep?.data).toMatchObject({ toolId: 'echo', isError: false, result: 'echo:hi' });
  });

  it('derives a stable idempotency key per logical call and honors the configured timeout', async () => {
    const client = createClient({
      apply: vi
        .fn()
        .mockImplementation(async (manifest: { metadata: { name?: string } }) => completedOperation(manifest.metadata.name ?? 'op', { result: 'echo:hi' })),
    });
    const { context } = createContext({
      orchestration: client,
      agentToolLoop: { toolOperationTimeoutMs: 5000 },
      toolRounds: 2,
    });

    for await (
      const _ of createAgentToolLoopRunner(context)({
        conversationId: 'c1',
        message: 'hi',
      })
    ) {
      // consume
    }

    expect(client.apply).toHaveBeenCalledTimes(2);
    const specs = (client.apply as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { spec: { idempotencyKey?: string; timeoutMs?: number } }).spec,
    );
    expect(specs[0].idempotencyKey).toMatch(/^c1:[0-9a-f]{64}:1$/);
    expect(specs[1].idempotencyKey).toMatch(/^c1:[0-9a-f]{64}:2$/);
    // Same tool + parameters → same hash segment across occurrences.
    expect(specs[0].idempotencyKey?.split(':')[1]).toBe(specs[1].idempotencyKey?.split(':')[1]);
    expect(specs[0].timeoutMs).toBe(5000);
  });

  it('keeps waiting through transient get failures when reconciliation allows retry', async () => {
    let getCalls = 0;
    const client = createClient({
      apply: vi
        .fn()
        .mockImplementation(
          async (manifest: {
            metadata: { name?: string };
            apiVersion: string;
            kind: string;
            spec: ToolOperationResource['spec'];
          }) => operationFromManifest(manifest, { phase: 'Running', attempts: 1 }),
        ),
      get: vi.fn().mockImplementation(async (reference: { name?: string }) => {
        getCalls += 1;
        if (getCalls === 1) {
          throw new OrchestrationError({
            code: 'UNAVAILABLE',
            message: 'executor disconnected',
            retryable: true,
          });
        }
        return completedOperation(reference.name ?? 'op', { result: 'echo:hi' });
      }),
    });
    const { context } = createContext({ orchestration: client });

    const steps = [];
    for await (
      const step of createAgentToolLoopRunner(context)({
        conversationId: 'c1',
        message: 'hi',
      })
    ) {
      steps.push(step);
    }

    const toolStep = steps.find((s) => s.type === 'tool');
    expect(toolStep?.data).toMatchObject({ toolId: 'echo', isError: false, result: 'echo:hi' });
  });

  it('stops waiting and surfaces verification-required when the idempotent retry budget is exhausted', async () => {
    const client = createClient({
      apply: vi
        .fn()
        .mockImplementation(
          async (manifest: {
            metadata: { name?: string };
            apiVersion: string;
            kind: string;
            spec: ToolOperationResource['spec'];
          }) =>
            // attempts (3) already at the default budget → reconciliation must not retry.
            operationFromManifest(manifest, { phase: 'Running', attempts: 3 }),
        ),
      get: vi
        .fn()
        .mockRejectedValue(
          new OrchestrationError({
            code: 'UNAVAILABLE',
            message: 'executor disconnected',
            retryable: true,
          }),
        ),
    });
    const { context } = createContext({ orchestration: client });

    const steps = [];
    for await (
      const step of createAgentToolLoopRunner(context)({
        conversationId: 'c1',
        message: 'hi',
      })
    ) {
      steps.push(step);
    }

    const toolStep = steps.find((s) => s.type === 'tool');
    if (toolStep?.data === null || typeof toolStep?.data !== 'object') {
      throw new Error('expected structured tool step');
    }
    expect('isError' in toolStep.data ? toolStep.data.isError : undefined).toBe(true);
    expect(String('result' in toolStep.data ? toolStep.data.result : undefined)).toContain(
      'verification-required',
    );
  });
});
