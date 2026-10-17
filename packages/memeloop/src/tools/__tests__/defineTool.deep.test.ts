import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createTestStorage } from '../../__tests__/testStorage.js';
import { matchAllToolCallings } from '../../promptUtilities/responsePatternUtility.js';

type ApprovalDecision = 'allow' | 'deny' | 'pending';
type ApprovalRequestDecision = 'allow' | 'deny';
type ToolCallEntry = { call: unknown };
type ToolExecutionResult = {
  call: unknown;
  status: 'fulfilled' | 'rejected' | 'timeout';
  result?: { success: boolean; data?: string; error?: string };
  error?: string;
};

const mocks = vi.hoisted(() => ({
  evaluateApproval: vi.fn<(...parameters: unknown[]) => ApprovalDecision>(() => 'allow'),
  requestApproval: vi.fn<(...parameters: unknown[]) => Promise<ApprovalRequestDecision>>(
    async () => 'allow',
  ),
  executeToolCallsParallel: vi.fn<(entries: ToolCallEntry[]) => Promise<ToolExecutionResult[]>>(
    async (entries) =>
      entries.map((entry) => ({
        call: entry.call,
        status: 'fulfilled',
        result: { success: true, data: 'P' },
      })),
  ),
  executeToolCallsSequential: vi.fn<(entries: ToolCallEntry[]) => Promise<ToolExecutionResult[]>>(
    async (entries) =>
      entries.map((entry) => ({
        call: entry.call,
        status: 'fulfilled',
        result: { success: true, data: 'S' },
      })),
  ),
}));

vi.mock('../approval.js', () => ({
  evaluateApproval: (...parameters: unknown[]) => mocks.evaluateApproval(...parameters),
  requestApproval: (...parameters: unknown[]) => mocks.requestApproval(...parameters),
}));

vi.mock('../parallelExecution.js', () => ({
  executeToolCallsParallel: (entries: ToolCallEntry[]) => mocks.executeToolCallsParallel(entries),
  executeToolCallsSequential: (entries: ToolCallEntry[]) => mocks.executeToolCallsSequential(entries),
}));

import { defineTool as defineToolForRegistry } from '../defineTool.js';
import type { ToolDefinition } from '../defineToolTypes.js';
import {
  createAgentFrameworkHooks,
  createHooksWithPlugins as createHooksWithRegistry,
  runPostProcessHooks,
  runProcessPromptsHooks,
  runResponseCompleteHooks,
} from '../pluginRegistry.js';
import type { DefineToolAgentFrameworkContext } from '../types.js';
import type { PromptConcatTool } from '../types.js';

const promptPlugins = new Map<string, PromptConcatTool>();

function defineTool<
  TConfigSchema extends z.ZodType,
  TLLMToolSchemas extends Record<string, z.ZodType> = Record<string, z.ZodType>,
>(definition: ToolDefinition<TConfigSchema, TLLMToolSchemas>) {
  return defineToolForRegistry(definition, { pluginRegistry: promptPlugins });
}

function createHooksWithPlugins(
  config: Parameters<typeof createHooksWithRegistry>[0],
) {
  return createHooksWithRegistry(config, { pluginRegistry: promptPlugins });
}

function makePayload(content: string) {
  const storage = createTestStorage();
  const persist = storage.appendLocalEvent;
  const agent = {
    id: 'agent-1',
    messages: [
      {
        messageId: 'ai-1',
        turnId: 'turn-1',
        conversationId: 'agent-1',
        originNodeId: 'test-node',
        originSequence: 1,
        lamportClock: 1,
        timestamp: 1,
        role: 'assistant' as const,
        parts: [],
        content,
        duration: 1,
        metadata: {},
      },
    ],
  };
  const parsed = matchAllToolCallings(content);
  return {
    payload: {
      agentFrameworkContext: {
        storage,
        localNodeId: 'test-node',
        runtimeId: 'test-runtime',
        toolApprovals: {
          requestApproval: (...parameters: unknown[]) => mocks.requestApproval(...parameters),
        },
        agentToolLoop: { textToolCallProtocolEnabled: true },
        agent,
      } as unknown as DefineToolAgentFrameworkContext,
      response: { status: 'done' as const, content },
      toolCalls: parsed.calls.map((call, index) => ({
        ...call,
        toolCallId: call.toolCallId ?? `test-call-${index}`,
      })),
      isParallel: parsed.parallel,
      agentFrameworkConfig: {
        plugins: [
          {
            toolId: 'deep-tool',
            id: 'p1',
            enabled: true,
            'deep-toolParam': { toolResultDuration: 3 },
          },
        ] as Array<Record<string, unknown>>,
      },
      requestId: 'r1',
      toolConfig: { id: 'p1', toolId: 'deep-tool' },
      actions: {} as { yieldNextRoundTo?: 'human' | 'self' },
    },
    persist,
    agent,
  };
}

describe('defineTool deep behavior', () => {
  beforeEach(() => {
    promptPlugins.clear();
  });
  it('executeToolCall success path adds tool result and yields self', async () => {
    defineTool({
      toolId: 'deep-tool',
      displayName: 'Deep Tool',
      description: 'deep',
      configSchema: z.object({ toolResultDuration: z.number().optional() }),
      llmToolSchemas: { echo: z.object({ q: z.string() }) },
      async onResponseComplete(ctx) {
        await ctx.executeToolCall('echo', async (p) => ({ success: true, data: `ok:${p.q}` }));
      },
    });

    const { hooks } = await createHooksWithPlugins({
      plugins: [
        {
          toolId: 'deep-tool',
          id: 'p1',
          enabled: true,
          'deep-toolParam': { toolResultDuration: 3 },
        },
      ],
    });
    const content = `<tool_use name="echo">{"q":"x"}</tool_use>`;
    const { payload, persist } = makePayload(content);
    await runResponseCompleteHooks(hooks, payload as any);

    expect(payload.actions.yieldNextRoundTo).toBe('self');
    expect(persist).toHaveBeenCalled();
    const toolMsgs = (payload.agentFrameworkContext as any).agent.messages.filter(
      (m: any) => m.role === 'tool',
    );
    expect(toolMsgs.length).toBe(1);
    expect(toolMsgs[0].content).toContain('ok:x');
  });

  it('executes a canonical native tool call when the assistant text is empty', async () => {
    const execute = vi.fn(async (parameters: { q: string }) => ({ success: true, data: `native:${parameters.q}` }));
    defineTool({
      toolId: 'deep-tool',
      displayName: 'Deep Tool',
      description: 'deep',
      configSchema: z.object({}),
      llmToolSchemas: { echo: z.object({ q: z.string() }) },
      async onResponseComplete(ctx) {
        await ctx.executeToolCall('echo', execute);
      },
    });
    const { hooks } = await createHooksWithPlugins({
      plugins: [{ toolId: 'deep-tool', id: 'p1', enabled: true, 'deep-toolParam': {} }],
    });
    const { payload } = makePayload('');
    payload.toolCalls = [{
      found: true,
      toolCallId: 'native-call-1',
      toolId: 'echo',
      parameters: { q: 'x' },
      originalText: '',
    }];

    await runResponseCompleteHooks(hooks, payload as any);

    expect(execute).toHaveBeenCalledWith({ q: 'x' }, expect.any(AbortSignal));
    expect(payload.actions.yieldNextRoundTo).toBe('self');
  });

  it('approval deny/pending branches add denial result', async () => {
    mocks.evaluateApproval.mockReturnValueOnce('deny').mockReturnValueOnce('pending');
    mocks.requestApproval.mockResolvedValueOnce('deny');

    defineTool({
      toolId: 'deep-tool',
      displayName: 'Deep Tool',
      description: 'deep',
      configSchema: z.object({}),
      llmToolSchemas: { echo: z.object({ q: z.string() }) },
      async onResponseComplete(ctx) {
        await ctx.executeToolCall('echo', async () => ({ success: true, data: 'ok' }));
      },
    });
    const { hooks } = await createHooksWithPlugins({
      plugins: [{ toolId: 'deep-tool', id: 'p1', enabled: true, 'deep-toolParam': {} }],
    });
    const content = `<tool_use name="echo">{"q":"x"}</tool_use>`;

    const p1 = makePayload(content).payload;
    await runResponseCompleteHooks(hooks, p1 as any);
    const msg1 = (p1.agentFrameworkContext as any).agent.messages.find(
      (m: any) => m.role === 'tool',
    );
    expect(msg1.content).toContain('denied by approval policy');

    const p2 = makePayload(content).payload;
    await runResponseCompleteHooks(hooks, p2 as any);
    const msg2 = (p2.agentFrameworkContext as any).agent.messages.find(
      (m: any) => m.role === 'tool',
    );
    expect(msg2.content).toContain('denied by user');
  });

  it('executeAllMatchingToolCalls goes parallel and sequential', async () => {
    defineTool({
      toolId: 'deep-tool',
      displayName: 'Deep Tool',
      description: 'deep',
      configSchema: z.object({}),
      llmToolSchemas: { echo: z.object({ q: z.string() }) },
      async onResponseComplete(ctx) {
        await ctx.executeAllMatchingToolCalls('echo', async () => ({ success: true, data: 'x' }));
      },
    });
    const { hooks } = await createHooksWithPlugins({
      plugins: [{ toolId: 'deep-tool', id: 'p1', enabled: true, 'deep-toolParam': {} }],
    });

    const parallelContent = `<parallel_tool_calls>
<tool_use name="echo">{"q":"x1"}</tool_use>
<tool_use name="echo">{"q":"x2"}</tool_use>
</parallel_tool_calls>`;
    const p1 = makePayload(parallelContent).payload;
    await runResponseCompleteHooks(hooks, p1 as any);
    expect(mocks.executeToolCallsParallel).toHaveBeenCalled();

    const seqContent = `<tool_use name="echo">{"q":"x1"}</tool_use>`;
    const p2 = makePayload(seqContent).payload;
    await runResponseCompleteHooks(hooks, p2 as any);
    expect(mocks.executeToolCallsSequential).toHaveBeenCalled();
  });

  it('onProcessPrompts injects tool list/content and handles skip branches', async () => {
    defineTool({
      toolId: 'proc-tool',
      displayName: 'Proc Tool',
      description: 'proc',
      configSchema: z.object({}),
      llmToolSchemas: { t1: z.object({}) },
      async onProcessPrompts(ctx) {
        ctx.injectToolList({ targetId: 'p1', position: 'child' });
        ctx.injectContent({ targetId: 'p1', position: 'after', content: 'extra' });
      },
    });
    const hooks = createAgentFrameworkHooks();
    const tool = (
      await createHooksWithPlugins({
        plugins: [{ toolId: 'proc-tool', id: 'p1', 'proc-toolParam': {} }],
      })
    ).hooks;
    // register plugin into fresh hooks through createHooksWithPlugins result
    Object.assign(hooks, tool);

    const prompts: any[] = [{ id: 'p1', text: 'base', children: [] }];
    const baseCtx = {
      prompts,
      messages: [],
      toolConfig: { toolId: 'proc-tool', id: 'p1', 'proc-toolParam': {} },
      agentFrameworkContext: {} as any,
      pluginIndex: 0,
    };
    const out = await runProcessPromptsHooks(hooks as any, baseCtx);
    expect(out.prompts[0].children.length).toBe(1);
    expect(out.prompts.length).toBeGreaterThan(1);

    // skip: wrong tool id / disabled / missing raw config
    await runProcessPromptsHooks(hooks as any, {
      ...baseCtx,
      toolConfig: { toolId: 'other', id: 'x', 'proc-toolParam': {} },
    });
    await runProcessPromptsHooks(hooks as any, {
      ...baseCtx,
      toolConfig: { toolId: 'proc-tool', id: 'x', enabled: false, 'proc-toolParam': {} },
    });
    await runProcessPromptsHooks(hooks as any, {
      ...baseCtx,
      toolConfig: { toolId: 'proc-tool', id: 'x' },
    });
  });

  it('onPostProcess runs and skip branches', async () => {
    const spy = vi.fn();
    defineTool({
      toolId: 'post-tool',
      displayName: 'Post Tool',
      description: 'post',
      configSchema: z.object({}),
      async onPostProcess(ctx) {
        spy(ctx.llmResponse);
      },
    });
    const { hooks } = await createHooksWithPlugins({
      plugins: [{ toolId: 'post-tool', id: 'p1', 'post-toolParam': {} }],
    });
    const context: any = {
      toolConfig: { toolId: 'post-tool', id: 'p1', 'post-toolParam': {} },
      prompts: [],
      messages: [],
      agentFrameworkContext: {},
      llmResponse: 'hello',
      responses: [],
    };
    await runPostProcessHooks(hooks, context);
    expect(spy).toHaveBeenCalledWith('hello');

    await runPostProcessHooks(hooks, {
      ...context,
      toolConfig: { toolId: 'other', id: 'x', 'post-toolParam': {} },
    });
    await runPostProcessHooks(hooks, {
      ...context,
      toolConfig: { toolId: 'post-tool', id: 'x', enabled: false, 'post-toolParam': {} },
    });
    await runPostProcessHooks(hooks, { ...context, toolConfig: { toolId: 'post-tool', id: 'x' } });
  });

  it('executeAllMatchingToolCalls handles approval deny/pending and validation error', async () => {
    mocks.evaluateApproval.mockReturnValueOnce('deny').mockReturnValueOnce('pending');
    mocks.requestApproval.mockResolvedValueOnce('deny');

    defineTool({
      toolId: 'batch-tool',
      displayName: 'Batch Tool',
      description: 'batch',
      configSchema: z.object({}),
      llmToolSchemas: { sum: z.object({ a: z.number() }) },
      async onResponseComplete(ctx) {
        await ctx.executeAllMatchingToolCalls('sum', async () => ({ success: true, data: 'x' }));
      },
    });
    const { hooks } = await createHooksWithPlugins({
      plugins: [{ toolId: 'batch-tool', id: 'p1', 'batch-toolParam': {} }],
    });
    const content = `<parallel_tool_calls>
<tool_use name="sum">{"a":1}</tool_use>
<tool_use name="sum">{"a":"bad"}</tool_use>
</parallel_tool_calls>`;

    const p1 = makePayload(content).payload;
    p1.agentFrameworkConfig.plugins = [{ toolId: 'batch-tool', id: 'p1', 'batch-toolParam': {} }];
    await runResponseCompleteHooks(hooks, p1 as any);
    const denied = (p1.agentFrameworkContext as any).agent.messages.find(
      (m: any) => m.role === 'tool',
    );
    expect(denied.content).toContain('denied by approval policy');

    const p2 = makePayload(content).payload;
    p2.agentFrameworkConfig.plugins = [{ toolId: 'batch-tool', id: 'p1', 'batch-toolParam': {} }];
    await runResponseCompleteHooks(hooks, p2 as any);
    const denied2 = (p2.agentFrameworkContext as any).agent.messages.find(
      (m: any) => m.role === 'tool',
    );
    expect(denied2.content).toContain('denied by user');
  });

  it('addToolResult truncates long result and fails closed on persistence errors', async () => {
    defineTool({
      toolId: 'trunc-tool',
      displayName: 'Trunc Tool',
      description: 'trunc',
      configSchema: z.object({}),
      llmToolSchemas: { echo: z.object({ q: z.string() }) },
      async onResponseComplete(ctx) {
        await ctx.executeToolCall('echo', async () => ({
          success: true,
          data: 'x'.repeat(40_000),
        }));
      },
    });
    const { hooks } = await createHooksWithPlugins({
      plugins: [{ toolId: 'trunc-tool', id: 'p1', 'trunc-toolParam': {} }],
    });
    const p = makePayload(`<tool_use name="echo">{"q":"x"}</tool_use>`).payload as any;
    p.agentFrameworkConfig.plugins = [{ toolId: 'trunc-tool', id: 'p1', 'trunc-toolParam': {} }];
    p.agentFrameworkContext.storage.appendLocalEvent = vi
      .fn()
      .mockRejectedValue(new Error('persist-fail'));
    await runResponseCompleteHooks(hooks, p);
    await Promise.resolve();
    const toolMsg = p.agentFrameworkContext.agent.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg).toBeUndefined();
  });

  it('executeToolCall handles missing schema and executor throw paths', async () => {
    defineTool({
      toolId: 'err-tool',
      displayName: 'Err Tool',
      description: 'err',
      configSchema: z.object({}),
      llmToolSchemas: { ok: z.object({ q: z.string() }) },
      async onResponseComplete(ctx) {
        await ctx.executeToolCall('missing' as any, async () => ({ success: true, data: 'x' }));
        await ctx.executeToolCall('ok', async () => {
          throw new Error('exec-failed');
        });
      },
    });
    const { hooks } = await createHooksWithPlugins({
      plugins: [{ toolId: 'err-tool', id: 'p1', 'err-toolParam': {} }],
    });
    const p = makePayload(`<tool_use name="ok">{"q":"x"}</tool_use>`);
    p.payload.agentFrameworkConfig.plugins = [
      { toolId: 'err-tool', id: 'p1', 'err-toolParam': {} },
    ];
    await runResponseCompleteHooks(hooks, p.payload as any);
    const toolMsgs = (p.payload.agentFrameworkContext as any).agent.messages.filter(
      (m: any) => m.role === 'tool',
    );
    expect(toolMsgs.some((m: any) => String(m.content).includes('exec-failed'))).toBe(true);
  });

  it('executeAllMatchingToolCalls maps timeout/rejected/failed statuses', async () => {
    mocks.executeToolCallsParallel.mockResolvedValueOnce([
      {
        call: { toolId: 'echo', parameters: { q: 'a' }, originalText: 'a', found: true },
        status: 'timeout',
        error: 't',
      },
      {
        call: { toolId: 'echo', parameters: { q: 'b' }, originalText: 'b', found: true },
        status: 'rejected',
        error: 'r',
      },
      {
        call: { toolId: 'echo', parameters: { q: 'c' }, originalText: 'c', found: true },
        status: 'fulfilled',
        result: { success: false, error: 'e' },
      },
    ]);
    defineTool({
      toolId: 'status-tool',
      displayName: 'Status Tool',
      description: 'status',
      configSchema: z.object({}),
      llmToolSchemas: { echo: z.object({ q: z.string() }) },
      async onResponseComplete(ctx) {
        await ctx.executeAllMatchingToolCalls('echo', async () => ({ success: true, data: 'ok' }));
      },
    });
    const { hooks } = await createHooksWithPlugins({
      plugins: [{ toolId: 'status-tool', id: 'p1', 'status-toolParam': {} }],
    });
    const content = `<parallel_tool_calls>
<tool_use name="echo">{"q":"a"}</tool_use>
<tool_use name="echo">{"q":"b"}</tool_use>
<tool_use name="echo">{"q":"c"}</tool_use>
</parallel_tool_calls>`;
    const p = makePayload(content).payload as any;
    p.agentFrameworkConfig.plugins = [{ toolId: 'status-tool', id: 'p1', 'status-toolParam': {} }];
    await runResponseCompleteHooks(hooks, p);
    const text = (
      p.agentFrameworkContext.agent.messages as Array<{ role: string; content: string }>
    )
      .filter((message) => message.role === 'tool')
      .map((message) => message.content)
      .join('\n');
    expect(text).toContain('t');
    expect(text).toContain('r');
    expect(text).toContain('e');
  });

  it('handles config parse error and executeToolCall mismatch/absent toolCall', async () => {
    const configSchema = z.object({ n: z.number() });
    defineTool({
      toolId: 'cfg-tool',
      displayName: 'Cfg Tool',
      description: 'cfg',
      configSchema,
      llmToolSchemas: { echo: z.object({ q: z.string() }) },
      async onResponseComplete(ctx) {
        expect(ctx.config).toBeUndefined();
        const miss = await ctx.executeToolCall('echo', async () => ({ success: true, data: 'ok' }));
        expect(miss).toBe(false);
      },
    });
    const { hooks } = await createHooksWithPlugins({
      plugins: [{ toolId: 'cfg-tool', id: 'p1', enabled: true, 'cfg-toolParam': { n: 'bad' } }],
    });
    const p = makePayload('no tool call here').payload as any;
    p.agentFrameworkConfig.plugins = [
      { toolId: 'cfg-tool', id: 'p1', enabled: true, 'cfg-toolParam': { n: 'bad' } },
    ];
    await runResponseCompleteHooks(hooks, p);
    const toolMessages = (p.agentFrameworkContext.agent.messages as Array<{ role: string }>).filter(
      (message) => message.role === 'tool',
    );
    expect(toolMessages.length).toBe(0);
  });
});
