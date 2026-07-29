import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const approval = vi.hoisted(() => ({
  requestApproval: vi.fn(async () => 'deny' as const),
}));
vi.mock('../../tools/approval.js', () => ({
  evaluateApproval: vi.fn(() => 'allow' as const),
  requestApproval: approval.requestApproval,
}));

import { defineTool } from '../../tools/defineTool.js';
import type { AgentFrameworkContext, IAgentStorage, IToolRegistry } from '../../types.js';
import { createAgentToolLoopRunner } from '../agent-tool-loop/loop.js';
import { clearHooks, registerHook } from '../hooks/registry.js';

function createBase(
  storageMessages: any[] = [],
  llmChat?: AgentFrameworkContext['llmProvider']['chat'],
) {
  const storage: IAgentStorage = {
    listConversations: vi.fn().mockResolvedValue([]),
    getMessages: vi.fn().mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      async () => [...storageMessages],
    ),
    appendMessage: vi.fn().mockImplementation(async (m) => {
      storageMessages.push(m);
    }),
    upsertConversationMetadata: vi.fn().mockResolvedValue(undefined),
    insertMessagesIfAbsent: vi.fn().mockResolvedValue(undefined),
    getAttachment: vi.fn().mockResolvedValue(null),
    saveAttachment: vi.fn().mockResolvedValue(undefined),
    getAgentDefinition: vi.fn().mockResolvedValue(null),
    saveAgentInstance: vi.fn().mockResolvedValue(undefined),
    getConversationMeta: vi.fn().mockResolvedValue(null),
  };
  const llmProvider: AgentFrameworkContext['llmProvider'] = {
    name: 'mock',
    model: undefined,
    chat: llmChat ??
      async function*() {
        yield 'done';
      },
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
  };
  return { context, storage, storageMessages };
}

describe('agentToolLoop branch coverage', () => {
  afterEach(() => {
    clearHooks();
    approval.requestApproval.mockClear();
  });

  it('cancels early when isCancelled returns true', async () => {
    const { context } = createBase();
    context.agentToolLoop = { isCancelled: () => true };
    const gen = createAgentToolLoopRunner(context)({ conversationId: 'c1', message: 'hi' });
    const steps: any[] = [];
    for await (const s of gen) steps.push(s);
    expect(steps.some((s) => s.type === 'thinking' && s.data?.status === 'cancelled')).toBe(true);
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
      { type: 'start', conversationId: 'definition:conversation', definitionId: 'definition' },
      { type: 'stop', conversationId: 'definition:conversation', reason: 'completed' },
    ]);
  });

  it('runs AgentStop with cancelled reason after AgentStart', async () => {
    const stops: Array<Record<string, unknown>> = [];
    const { context } = createBase();
    context.agentToolLoop = { isCancelled: () => true };
    registerHook('AgentStart', async () => ({ allowed: true }));
    registerHook('AgentStop', async (_ctx, data) => {
      stops.push(data);
      return { allowed: true };
    });

    for await (const _ of createAgentToolLoopRunner(context)({ conversationId: 'c-cancel', message: 'hi' })) {
      /* drain */
    }

    expect(stops).toEqual([{ conversationId: 'c-cancel', reason: 'cancelled' }]);
  });

  it('runs AgentStop with max-iterations reason', async () => {
    const stops: Array<Record<string, unknown>> = [];
    const { context } = createBase([], async function*() {
      yield '<tool_use name="echo">{"x":1}</tool_use>';
    });
    context.agentToolLoop = { maxIterations: 1 } as any;
    registerHook('AgentStart', async () => ({ allowed: true }));
    registerHook('AgentStop', async (_ctx, data) => {
      stops.push(data);
      return { allowed: true };
    });

    for await (const _ of createAgentToolLoopRunner(context)({ conversationId: 'c-max', message: 'hi' })) {
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
      toolPermissions: {
        default: 'allow',
        rules: [{ pattern: 'echo', action: 'ask' }],
      },
    } as any;
    const steps: any[] = [];
    for await (const s of createAgentToolLoopRunner(context)({ conversationId: 'c1', message: 'hi' })) {
      steps.push(s);
    }
    expect(approval.requestApproval).toHaveBeenCalled();
    const toolMsg = storageMessages.find((m) => m.role === 'tool');
    expect(toolMsg.content).toContain('Tool approval denied or timed out');
  });

  it('lets PreToolUse request approval before registry tool execution', async () => {
    const { context, storageMessages } = createBase([], async function*() {
      yield '<tool_use name="echo">{"x":1}</tool_use>';
    });
    context.agentToolLoop = { maxIterations: 2 } as any;
    registerHook('PreToolUse', async () => ({ allowed: true, permissionAction: 'ask' }));

    const steps: any[] = [];
    for await (const s of createAgentToolLoopRunner(context)({ conversationId: 'c-hook', message: 'hi' })) {
      steps.push(s);
    }

    expect(approval.requestApproval).toHaveBeenCalled();
    expect(steps.some((s) => s.type === 'permission_request')).toBe(true);
    const toolMsg = storageMessages.find((m) => m.role === 'tool');
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
    context.agentToolLoop = { maxIterations: 2 } as any;
    context.tools.getTool = vi.fn().mockReturnValue(async (parameters: Record<string, unknown>) => {
      seenParameters.push(parameters);
      return { result: `x:${String(parameters.x)}` };
    });
    registerHook('PreToolUse', async () => ({
      allowed: true,
      modified: { parameters: { x: 2 } },
    }));

    for await (const _ of createAgentToolLoopRunner(context)({ conversationId: 'c-modify', message: 'hi' })) {
      /* drain */
    }

    expect(seenParameters).toEqual([{ x: 2 }]);
    expect(
      storageMessages.some((m) => m.role === 'tool' && String(m.content).includes('x:2')),
    ).toBe(true);
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
    context.agentToolLoop = { maxIterations: 4, doomLoopThreshold: 2 } as any;
    const steps: any[] = [];
    for await (const s of createAgentToolLoopRunner(context)({ conversationId: 'c2', message: 'hello' })) {
      steps.push(s);
    }
    expect(steps.some((s) => s.type === 'tool' && s.data.parallel === true)).toBe(true);
    expect(
      storageMessages.some(
        (m) => m.role === 'tool' && String(m.content).includes('Blocked by doom-loop guard'),
      ),
    ).toBe(true);
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
    context.resolveAgentDefinition = () =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      Promise.resolve({
        id: 'd1',
        agentFrameworkConfig: {
          prompts: [],
          plugins: [{ toolId: 'yield-human-plugin', id: 'p1', 'yield-human-pluginParam': {} }],
        },
      }) as any;
    const steps: any[] = [];
    for await (const s of createAgentToolLoopRunner(context)({ conversationId: 'd1:c1', message: 'hi' })) {
      steps.push(s);
    }
    expect(steps.some((s) => s.type === 'thinking' && s.data?.status === 'input-required')).toBe(
      true,
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
    context.resolveAgentDefinition = () =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      Promise.resolve({
        id: 'd1',
        agentFrameworkConfig: {
          prompts: [{ id: 'system', role: 'system', text: 'system' }],
          plugins: [{
            toolId: 'agent-aware-prompt-plugin',
            id: 'p1',
            'agent-aware-prompt-pluginParam': {},
          }],
        },
      }) as any;

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
    context.resolveAgentDefinition = () =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      Promise.resolve({
        id: 'd1',
        agentFrameworkConfig: {
          prompts: [],
          plugins: [{ toolId: 'doom-loop-plugin', id: 'p1', 'doom-loop-pluginParam': {} }],
        },
      }) as any;
    context.agentToolLoop = {
      maxIterations: 10,
      doomLoopThreshold: 3,
      fallbackRegistryTools: false,
    };

    const steps: any[] = [];
    for await (
      const step of createAgentToolLoopRunner(context)({
        conversationId: 'd1:doom',
        message: 'repeat',
      })
    ) {
      steps.push(step);
    }

    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      storageMessages.some(
        message =>
          message.role === 'tool' &&
          String(message.content).includes('Blocked by doom-loop guard'),
      ),
    ).toBe(true);
    expect(
      steps.some(
        step =>
          step.type === 'thinking' &&
          step.data?.status === 'blocked' &&
          String(step.data?.reason).includes('Blocked by doom-loop guard'),
      ),
    ).toBe(true);
  });
});
