import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const approval = vi.hoisted(() => ({
  requestApproval: vi.fn(async () => 'deny' as const),
}));
vi.mock('../../tools/approval.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../tools/approval.js')>()),
  evaluateApproval: vi.fn(() => 'allow' as const),
  requestApproval: approval.requestApproval,
}));

import { configureLoopTestContext, typedTextChat } from '../../__tests__/testLoopContext.js';
import { createTestStorage } from '../../__tests__/testStorage.js';
import type { AgentDefinition } from '../../agent/types.js';
import type { ChatMessage } from '../../conversation/index.js';
import { ToolApprovalBroker } from '../../tools/approval.js';
import { defineTool as defineToolForRegistry } from '../../tools/defineTool.js';
import type { ToolDefinition } from '../../tools/defineToolTypes.js';
import { MAX_TOOL_ARGUMENT_CANONICAL_BYTES } from '../../tools/structuredToolArguments.js';
import type { PromptConcatTool } from '../../tools/types.js';
import type { AgentFrameworkContext, IToolRegistry } from '../../types.js';
import { createAgentToolLoopRunner } from '../agent-tool-loop/loop.js';
import { HookRegistry } from '../hooks/registry.js';
import type { HookHandler, HookType } from '../hooks/types.js';
import type { AgentLoopStep } from '../types.js';

const promptPlugins = new Map<string, PromptConcatTool>();
const hookRegistry = new HookRegistry();
const registerHook = (type: HookType, handler: HookHandler, name?: string) => {
  hookRegistry.registerOwnedHook(type, handler, name);
};
const clearHooks = () => {
  hookRegistry.clearHooks();
};

function defineTool<
  TConfigSchema extends z.ZodType,
  TLLMToolSchemas extends Record<string, z.ZodType> = Record<string, z.ZodType>,
>(definition: ToolDefinition<TConfigSchema, TLLMToolSchemas>) {
  return defineToolForRegistry(definition, { pluginRegistry: promptPlugins });
}

function createBase(
  storageMessages: ChatMessage[] = [],
  llmChat?: Parameters<typeof typedTextChat>[0],
) {
  const storage = createTestStorage({ messages: storageMessages });
  const llmProvider: AgentFrameworkContext['llmProvider'] = {
    name: 'mock',
    model: undefined,
    chat: typedTextChat(
      llmChat ??
        async function*() {
          yield 'done';
        },
    ),
  };
  const tools: IToolRegistry = {
    registerTool: vi.fn(),
    getTool: vi.fn().mockReturnValue(async () => ({ result: 'ok' })),
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
    localNodeId: 'test-node',
    promptPlugins,
    hooks: hookRegistry,
  };
  const approvalBroker = new ToolApprovalBroker({ runtimeId: 'test-runtime' });
  approvalBroker.onApprovalRequest((request) => {
    void approval.requestApproval();
    approvalBroker.resolveApproval({
      ...request,
      decision: 'deny',
    });
  });
  context.runtimeId = 'test-runtime';
  context.toolApprovals = approvalBroker;
  configureLoopTestContext(context);
  return { context, storage, storageMessages };
}

function makeDefinition(
  id: string,
  agentFrameworkConfig: NonNullable<AgentDefinition['agentFrameworkConfig']>,
): AgentDefinition {
  return {
    id,
    name: id,
    description: 'test definition',
    systemPrompt: '',
    tools: [],
    agentFrameworkConfig,
    version: 'test',
  };
}

describe('agentToolLoop branch coverage', () => {
  afterEach(() => {
    clearHooks();
    promptPlugins.clear();
    approval.requestApproval.mockClear();
  });

  it('cancels early when isCancelled returns true', async () => {
    const { context } = createBase();
    context.runCancellation = new Set(['cancelled-run']);
    const gen = createAgentToolLoopRunner(context)({
      conversationId: 'c1',
      message: 'hi',
      runId: 'cancelled-run',
    });
    const steps: AgentLoopStep[] = [];
    for await (const s of gen) steps.push(s);
    expect(steps).toContainEqual(
      expect.objectContaining({
        type: 'thinking',
        data: expect.objectContaining({ status: 'cancelled' }),
      }),
    );
  });

  it('runs AgentStart and AgentStop hooks around a completed turn', async () => {
    const events: Array<Record<string, unknown>> = [];
    const { context } = createBase();
    registerHook('AgentStart', async (_ctx, data) => {
      events.push({ type: 'start', ...data });
      return { allowed: true };
    });
    registerHook('AgentStop', async (_ctx, data) => {
      events.push({ type: 'stop', ...data });
      return { allowed: true };
    });

    for await (
      const _ of createAgentToolLoopRunner(context)({
        conversationId: 'definition:conversation',
        message: 'hi',
      })
    ) {
      /* drain */
    }

    expect(events).toEqual([
      { type: 'start', conversationId: 'definition:conversation', definitionId: 'test:agent' },
      { type: 'stop', conversationId: 'definition:conversation', reason: 'completed' },
    ]);
  });

  it('runs AgentStop with cancelled reason after AgentStart', async () => {
    const stops: Array<Record<string, unknown>> = [];
    const { context } = createBase();
    context.runCancellation = new Set(['cancelled-run']);
    context.agentToolLoop = { textToolCallProtocolEnabled: true };
    registerHook('AgentStart', async () => ({ allowed: true }));
    registerHook('AgentStop', async (_ctx, data) => {
      stops.push(data);
      return { allowed: true };
    });

    for await (
      const _ of createAgentToolLoopRunner(context)({
        conversationId: 'c-cancel',
        message: 'hi',
        runId: 'cancelled-run',
      })
    ) {
      /* drain */
    }

    expect(stops).toEqual([{ conversationId: 'c-cancel', reason: 'cancelled' }]);
  });

  it('runs AgentStop with max-iterations reason', async () => {
    const stops: Array<Record<string, unknown>> = [];
    const { context } = createBase([], async function*() {
      yield '<tool_use name="echo">{"x":1}</tool_use>';
    });
    context.agentToolLoop = { maxIterations: 1, textToolCallProtocolEnabled: true };
    registerHook('AgentStart', async () => ({ allowed: true }));
    registerHook('AgentStop', async (_ctx, data) => {
      stops.push(data);
      return { allowed: true };
    });

    for await (
      const _ of createAgentToolLoopRunner(context)({
        conversationId: 'c-max',
        message: 'hi',
      })
    ) {
      /* drain */
    }

    expect(stops).toEqual([{ conversationId: 'c-max', reason: 'max-iterations' }]);
  });

  it('handles permission ask -> deny and persists denied tool result', async () => {
    const { context, storageMessages } = createBase([], async function*() {
      yield '<tool_use name="echo">{"x":1}</tool_use>';
    });
    context.agentToolLoop = {
      maxIterations: 2,
      textToolCallProtocolEnabled: true,
      toolPermissions: {
        default: 'allow',
        rules: [{ pattern: 'echo', action: 'ask' }],
      },
    };
    const steps: AgentLoopStep[] = [];
    for await (
      const s of createAgentToolLoopRunner(context)({
        conversationId: 'c1',
        message: 'hi',
      })
    ) {
      steps.push(s);
    }
    expect(approval.requestApproval).toHaveBeenCalled();
    const toolMsg = storageMessages.find((m) => m.role === 'tool');
    if (toolMsg === undefined) throw new Error('expected persisted tool denial message');
    expect(toolMsg.content).toContain('Tool approval denied or timed out');
  });

  it('lets PreToolUse request approval before registry tool execution', async () => {
    const { context, storageMessages } = createBase([], async function*() {
      yield '<tool_use name="echo">{"x":1}</tool_use>';
    });
    context.agentToolLoop = { maxIterations: 2, textToolCallProtocolEnabled: true };
    registerHook('PreToolUse', async () => ({ allowed: true, permissionAction: 'ask' }));

    const steps: AgentLoopStep[] = [];
    for await (
      const s of createAgentToolLoopRunner(context)({
        conversationId: 'c-hook',
        message: 'hi',
      })
    ) {
      steps.push(s);
    }

    expect(approval.requestApproval).toHaveBeenCalled();
    expect(steps.some((s) => s.type === 'permission_request')).toBe(true);
    const toolMsg = storageMessages.find((m) => m.role === 'tool');
    if (toolMsg === undefined) throw new Error('expected persisted tool denial message');
    expect(toolMsg.content).toContain('Tool approval denied or timed out');
  });

  it('lets PreToolUse modify tool parameters before registry execution', async () => {
    const seenParameters: Record<string, unknown>[] = [];
    let round = 0;
    const { context, storageMessages } = createBase([], async function*() {
      round += 1;
      if (round === 1) {
        yield '<tool_use name="echo">{"x":1}</tool_use>';
      } else {
        yield 'done';
      }
    });
    context.agentToolLoop = { maxIterations: 2, textToolCallProtocolEnabled: true };
    context.tools.getTool = vi.fn().mockReturnValue(async (parameters: Record<string, unknown>) => {
      seenParameters.push(parameters);
      return { result: `x:${String(parameters.x)}` };
    });
    registerHook('PreToolUse', async () => ({
      allowed: true,
      modified: { parameters: { x: 2 } },
    }));

    for await (
      const _ of createAgentToolLoopRunner(context)({
        conversationId: 'c-modify',
        message: 'hi',
      })
    ) {
      /* drain */
    }

    expect(seenParameters).toEqual([{ x: 2 }]);
    expect(storageMessages.some((m) => m.role === 'tool' && m.content.includes('x:2'))).toBe(true);
  });

  it.each([
    {
      name: 'cycle',
      modifiedParameters: () => {
        const value: Record<string, unknown> = {};
        value.self = value;
        return value;
      },
      expectedError: 'tool_arguments_unsafe',
    },
    {
      name: 'max plus one',
      modifiedParameters: () => ({
        value: 'x'.repeat(MAX_TOOL_ARGUMENT_CANONICAL_BYTES + 1),
      }),
      expectedError: 'tool_arguments_result_too_large',
    },
  ])(
    'fails closed for hook-modified $name arguments',
    async ({ modifiedParameters, expectedError }) => {
      let round = 0;
      const { context, storageMessages } = createBase([], async function*() {
        round += 1;
        yield round === 1 ? '<tool_use name="echo">{"x":1}</tool_use>' : 'done';
      });
      context.agentToolLoop = { maxIterations: 2, textToolCallProtocolEnabled: true };
      const execute = vi.fn(async () => ({ result: 'must-not-run' }));
      context.tools.getTool = vi.fn().mockReturnValue(execute);
      registerHook('PreToolUse', async () => ({
        allowed: true,
        modified: { parameters: modifiedParameters() },
      }));

      for await (
        const _ of createAgentToolLoopRunner(context)({
          conversationId: `c-hook-${expectedError}`,
          message: 'hi',
        })
      ) {
        // Drain the loop.
      }

      expect(execute).not.toHaveBeenCalled();
      expect(storageMessages.find((message) => message.role === 'tool')).toMatchObject({
        content: expectedError,
        metadata: {
          isError: true,
          toolParameters: { x: 1 },
        },
      });
    },
  );

  it('never invokes a getter in hook-modified arguments and persists only detached input', async () => {
    let round = 0;
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'must-not-run';
      },
    });
    const { context, storageMessages } = createBase([], async function*() {
      round += 1;
      yield round === 1 ? '<tool_use name="echo">{"x":1}</tool_use>' : 'done';
    });
    context.agentToolLoop = { maxIterations: 2, textToolCallProtocolEnabled: true };
    const execute = vi.fn(async () => ({ result: 'must-not-run' }));
    context.tools.getTool = vi.fn().mockReturnValue(execute);
    registerHook('PreToolUse', async () => ({
      allowed: true,
      modified: { parameters: accessor },
    }));

    for await (
      const _ of createAgentToolLoopRunner(context)({
        conversationId: 'c-hook-getter',
        message: 'hi',
      })
    ) {
      // Drain the loop.
    }

    expect(getterCalls).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(storageMessages.find((message) => message.role === 'tool')).toMatchObject({
      content: 'tool_arguments_unsafe',
      metadata: {
        isError: true,
        toolParameters: { x: 1 },
      },
    });
  });

  it('parallel tool calls path yields parallel=true and doom-loop guard', async () => {
    let round = 0;
    const { context, storageMessages } = createBase([], async function*() {
      round += 1;
      if (round === 1) {
        yield `<parallel_tool_calls>
<tool_use name="echo">{"x":1}</tool_use>
<tool_use name="echo">{"x":1}</tool_use>
</parallel_tool_calls>`;
      } else {
        yield '<tool_use name="echo">{"x":1}</tool_use>';
      }
    });
    context.agentToolLoop = { maxIterations: 4, doomLoopThreshold: 2, textToolCallProtocolEnabled: true };
    const steps: AgentLoopStep[] = [];
    for await (
      const s of createAgentToolLoopRunner(context)({
        conversationId: 'c2',
        message: 'hello',
      })
    ) {
      steps.push(s);
    }
    expect(steps).toContainEqual(
      expect.objectContaining({
        type: 'tool',
        data: expect.objectContaining({ parallel: true }),
      }),
    );
    expect(
      storageMessages.some(
        (m) => m.role === 'tool' && m.content.includes('Blocked by doom-loop guard'),
      ),
    ).toBe(true);
  });

  it('blocks no-progress parameter tweaks on the registry-only path', async () => {
    let page = 0;
    const execute = vi.fn(async () => ({ result: 'unchanged result' }));
    const { context, storageMessages } = createBase([], async function*() {
      page += 1;
      yield `<tool_use name="echo">{"page":${page}}</tool_use>`;
    });
    context.tools.getTool = vi.fn().mockReturnValue(execute);
    context.agentToolLoop = {
      maxIterations: 10,
      doomLoopThreshold: 3,
      doomLoopSameToolThreshold: 4,
      textToolCallProtocolEnabled: true,
    };

    for await (
      const _ of createAgentToolLoopRunner(context)({
        conversationId: 'registry-doom',
        message: 'paginate',
      })
    ) {
      /* drain */
    }

    expect(execute).toHaveBeenCalledTimes(3);
    expect(
      storageMessages.some((message) => message.content.includes('without observable progress')),
    ).toBe(true);
  });

  it.each([
    { fallbackRegistryTools: false, human: false, unhandled: false },
    { fallbackRegistryTools: true, human: false, unhandled: false },
    { fallbackRegistryTools: false, human: true, unhandled: false },
    { fallbackRegistryTools: true, human: true, unhandled: false },
    { fallbackRegistryTools: false, human: false, unhandled: true },
  ])('completes mixed native batches before continuing ($fallbackRegistryTools/$human/$unhandled)', async ({ fallbackRegistryTools, human, unhandled }) => {
    const calls = [
      { toolName: 'mcp-ui_evaluate', toolCallId: 'call-mcp', input: {} },
      { toolName: 'wiki-search', toolCallId: 'call-wiki', input: {} },
      { toolName: 'manage-todo', toolCallId: 'call-todo-1', input: {} },
      { toolName: 'manage-todo', toolCallId: 'call-todo-2', input: {} },
    ];
    const executed: string[] = [];
    for (const name of ['mcp-ui_evaluate', 'wiki-search', 'manage-todo']) {
      if ((fallbackRegistryTools || unhandled) && name === 'mcp-ui_evaluate') continue;
      defineTool({
        toolId: name,
        displayName: name,
        description: name,
        configSchema: z.object({}),
        llmToolSchemas: { [name]: z.object({}) },
        async onResponseComplete(ctx) {
          if (!ctx.toolCall?.found || ctx.toolCall.toolId !== name) return;
          const id = ctx.toolCall.toolCallId!;
          await ctx.executeToolCall(name, async () => {
            executed.push(id);
            return { success: true, data: id };
          });
          if (human && name === (fallbackRegistryTools ? 'wiki-search' : 'mcp-ui_evaluate')) ctx.yieldToHuman();
        },
      });
    }
    const { context, storageMessages } = createBase();
    context.tools.getTool = vi.fn(name =>
      name === 'mcp-ui_evaluate'
        ? async () => {
          executed.push('call-mcp');
          return { result: 'mcp result' };
        }
        : undefined
    );
    let requests = 0;
    context.llmProvider.chat = async function*(request) {
      requests++;
      if (requests === 1) {
        for (const call of calls) yield { type: 'tool-call', ...call };
        yield { type: 'finish', finishReason: 'tool-calls' };
        return;
      }
      // Validate the actual next provider request, not just UI/persisted counts.
      const pending = new Set<string>();
      for (const message of request.messages) {
        if (typeof message.content === 'string') continue;
        for (const part of message.content) {
          if (part.type === 'tool-call') pending.add(part.toolCallId);
          if (part.type === 'tool-result') {
            if (!pending.delete(part.toolCallId)) throw new Error('Unexpected tool output');
          }
        }
      }
      if (pending.size > 0) throw new Error(`Missing tool outputs: ${[...pending].join(',')}`);
      const requestCallIds = request.messages.flatMap(message =>
        typeof message.content === 'string'
          ? []
          : message.content.flatMap(part => part.type === 'tool-call' ? [part.toolCallId] : [])
      );
      expect(requestCallIds).toEqual(calls.map(call => call.toolCallId));
      yield { type: 'text-delta', id: 'done', text: 'All tools completed' };
      yield { type: 'finish', finishReason: 'stop' };
    };
    context.resolveAgentDefinition = async () =>
      makeDefinition('test:agent', {
        prompts: [],
        plugins: [...promptPlugins.keys()].map(toolId => ({ id: toolId, toolId })),
      });
    context.agentToolLoop = { maxIterations: 3, fallbackRegistryTools };
    const steps: AgentLoopStep[] = [];
    const run = async () => {
      for await (const step of createAgentToolLoopRunner(context)({ conversationId: 'mixed-batch', message: 'run tools', runId: `run-${requests}` })) steps.push(step);
    };
    if (unhandled) {
      await expect(run()).rejects.toThrow('Tool plugins did not complete all requested tool calls');
      expect(requests).toBe(1);
      return;
    }
    await run();
    expect(requests).toBe(human ? 1 : 2);
    if (human) expect(steps).toContainEqual(expect.objectContaining({ type: 'thinking', data: expect.objectContaining({ status: 'input-required' }) }));
    const pluginOrder = ['call-wiki', 'call-todo-1', 'call-todo-2'];
    const expectedExecutions = fallbackRegistryTools
      ? [...pluginOrder, ...(human ? [] : ['call-mcp'])]
      : ['call-mcp', ...pluginOrder];
    expect(executed).toEqual(expectedExecutions);
    if (!human) expect(storageMessages.at(-1)?.content).toBe('All tools completed');
    const resultIds = storageMessages.flatMap(message => message.parts.flatMap(part => part.type === 'tool-result' ? [part.toolCallId] : []));
    expect(resultIds).toEqual(fallbackRegistryTools ? [...pluginOrder, 'call-mcp'] : expectedExecutions);
    if (human && fallbackRegistryTools) {
      expect(storageMessages.find(message => message.metadata?.humanYieldNotExecuted)?.parts).toEqual([
        expect.objectContaining({ type: 'tool-result', toolCallId: 'call-mcp', isError: true, result: expect.stringContaining('Not executed:') }),
      ]);
      // Resume on a new human turn: the provider must receive the full paired
      // batch, including the explicit non-execution, without running the tool.
      await run();
      expect(requests).toBe(2);
      expect(executed).toEqual(expectedExecutions);
    }
  });

  it('plugin yieldToHuman branch returns input-required', async () => {
    defineTool({
      toolId: 'yield-human-plugin',
      displayName: 'Yield Human Plugin',
      description: 'yield',
      configSchema: z.object({}),
      async onResponseComplete(ctx) {
        ctx.yieldToHuman();
      },
    });
    const { context } = createBase([], async function*() {
      yield 'assistant-text';
    });
    context.resolveAgentDefinition = async () =>
      makeDefinition('test:agent', {
        prompts: [],
        plugins: [{ toolId: 'yield-human-plugin', id: 'p1', 'yield-human-pluginParam': {} }],
      });
    const steps: AgentLoopStep[] = [];
    for await (
      const s of createAgentToolLoopRunner(context)({
        conversationId: 'd1:c1',
        message: 'hi',
      })
    ) {
      steps.push(s);
    }
    expect(steps).toContainEqual(
      expect.objectContaining({
        type: 'thinking',
        data: expect.objectContaining({ status: 'input-required' }),
      }),
    );
  });

  it('provides the resolved live agent to prompt-processing plugins', async () => {
    let promptAgentId: string | undefined;
    defineTool({
      toolId: 'agent-aware-prompt-plugin',
      displayName: 'Agent Aware Prompt Plugin',
      description: 'reads the live agent during prompt processing',
      configSchema: z.object({}),
      onProcessPrompts(ctx) {
        promptAgentId = ctx.agentFrameworkContext.agent.id;
      },
    });
    const { context } = createBase();
    context.resolveAgentDefinition = async () =>
      makeDefinition('test:agent', {
        prompts: [{ id: 'system', role: 'system', text: 'system' }],
        plugins: [
          {
            toolId: 'agent-aware-prompt-plugin',
            id: 'p1',
            'agent-aware-prompt-pluginParam': {},
          },
        ],
      });

    for await (
      const _ of createAgentToolLoopRunner(context)({
        conversationId: 'd1:live-agent',
        message: 'hello',
      })
    ) {
      /* drain */
    }

    expect(promptAgentId).toBe('d1:live-agent');
  });

  it('blocks a legacy plugin before a third identical tool execution', async () => {
    const execute = vi.fn(async () => ({ success: false, error: 'invalid input' }));
    defineTool({
      toolId: 'doom-loop-plugin',
      displayName: 'Doom Loop Plugin',
      description: 'handles a repeated tool call',
      configSchema: z.object({}),
      llmToolSchemas: { repeat: z.object({ value: z.string() }) },
      async onResponseComplete(ctx) {
        await ctx.executeToolCall('repeat', execute);
      },
    });
    const { context, storageMessages } = createBase([], async function*() {
      yield '<tool_use name="repeat">{"value":"same"}</tool_use>';
    });
    context.resolveAgentDefinition = async () =>
      makeDefinition('test:agent', {
        prompts: [],
        plugins: [{ toolId: 'doom-loop-plugin', id: 'p1', 'doom-loop-pluginParam': {} }],
      });
    context.agentToolLoop = {
      maxIterations: 10,
      doomLoopThreshold: 3,
      fallbackRegistryTools: false,
      textToolCallProtocolEnabled: true,
    };
    const steps: AgentLoopStep[] = [];
    for await (
      const step of createAgentToolLoopRunner(context)({
        conversationId: 'd1:doom',
        message: 'repeat',
        userMessage: {
          messageId: 'remote-doom-message',
          turnId: 'remote-doom-message',
          originNodeId: 'test-node',
          timestamp: 1,
        },
      })
    ) {
      steps.push(step);
    }

    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      storageMessages.some(
        (message) => message.role === 'tool' && message.content.includes('Blocked by doom-loop guard'),
      ),
    ).toBe(true);
    expect(
      storageMessages.find((message) => message.metadata?.doomLoopBlocked === true)?.originNodeId,
    ).toBe('test-node');
    expect(
      steps.some((step) => {
        if (step.type !== 'thinking' || step.data === null || typeof step.data !== 'object') {
          return false;
        }
        const data = step.data as { status?: unknown; reason?: unknown };
        return (
          data.status === 'blocked' && String(data.reason).includes('Blocked by doom-loop guard')
        );
      }),
    ).toBe(true);
  });

  it('blocks no-progress parameter tweaks when a plugin call falls back to the registry', async () => {
    defineTool({
      toolId: 'fallback-noop-plugin',
      displayName: 'Fallback Noop Plugin',
      description: 'leaves calls for the registry fallback',
      configSchema: z.object({}),
      async onResponseComplete() {
        // The registry fallback handles the model call.
      },
    });
    let page = 0;
    const execute = vi.fn(async () => ({ result: 'unchanged result' }));
    const { context, storageMessages } = createBase([], async function*() {
      page += 1;
      yield `<tool_use name="echo">{"page":${page}}</tool_use>`;
    });
    context.tools.getTool = vi.fn().mockReturnValue(execute);
    context.resolveAgentDefinition = async () =>
      makeDefinition('test:agent', {
        prompts: [],
        plugins: [
          {
            toolId: 'fallback-noop-plugin',
            id: 'p1',
            'fallback-noop-pluginParam': {},
          },
        ],
      });
    context.agentToolLoop = {
      maxIterations: 10,
      doomLoopThreshold: 3,
      doomLoopSameToolThreshold: 4,
      fallbackRegistryTools: true,
      textToolCallProtocolEnabled: true,
    };

    for await (
      const _ of createAgentToolLoopRunner(context)({
        conversationId: 'd1:fallback-doom',
        message: 'paginate',
      })
    ) {
      /* drain */
    }

    expect(execute).toHaveBeenCalledTimes(3);
    expect(
      storageMessages.some(
        (message) =>
          message.metadata?.doomLoopBlocked === true &&
          message.content.includes('without observable progress'),
      ),
    ).toBe(true);
  });
});
