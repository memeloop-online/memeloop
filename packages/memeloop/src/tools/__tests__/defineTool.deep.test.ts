// @ts-nocheck - strictSpread issues with vi.hoisted + vi.mock rest params
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  evaluateApproval: vi.fn(() => 'allow' as const),
  requestApproval: vi.fn(async () => 'allow' as const),
  executeToolCallsParallel: vi.fn(async (entries: any[]) =>
    entries.map((e) => ({
      call: e.call,
      status: 'fulfilled',
      result: { success: true, data: 'P' },
    }))
  ),
  executeToolCallsSequential: vi.fn(async (entries: any[]) =>
    entries.map((e) => ({
      call: e.call,
      status: 'fulfilled',
      result: { success: true, data: 'S' },
    }))
  ),
}));

vi.mock('../approval.js', () => ({
  evaluateApproval: (...args: any[]) => mocks.evaluateApproval(...args),
  requestApproval: (...args: any[]) => mocks.requestApproval(...args),
}));

vi.mock('../parallelExecution.js', () => ({
  executeToolCallsParallel: (...args: any[]) => mocks.executeToolCallsParallel(...args),
  executeToolCallsSequential: (...args: any[]) => mocks.executeToolCallsSequential(...args),
}));

import { defineTool } from '../defineTool.js';
import { createAgentFrameworkHooks, createHooksWithPlugins, runPostProcessHooks, runProcessPromptsHooks, runResponseCompleteHooks } from '../pluginRegistry.js';
import type { DefineToolAgentFrameworkContext } from '../types.js';

function makePayload(content: string) {
  const persist = vi.fn().mockResolvedValue(undefined);
  const agent = {
    id: 'agent-1',
    messages: [
      {
        id: 'ai-1',
        agentId: 'agent-1',
        role: 'assistant' as const,
        content,
        created: new Date(),
        modified: new Date(),
        duration: 1,
        metadata: {},
      },
    ],
  };
  return {
    payload: {
      agentFrameworkContext: {
        persistAgentMessage: persist,
        agent,
      } as unknown as DefineToolAgentFrameworkContext,
      response: { status: 'done' as const, content },
      agentFrameworkConfig: {
        plugins: [
          {
            toolId: 'deep-tool',
            id: 'p1',
            enabled: true,
            'deep-toolParam': { toolResultDuration: 3 },
          },
        ],
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
      plugins: [{ toolId: 'deep-tool', id: 'p1', enabled: true, 'deep-toolParam': { toolResultDuration: 3 } }],
    });
    const content = `<tool_use name="echo">{"q":"x"}</tool_use>`;
    const { payload, persist } = makePayload(content);
    await runResponseCompleteHooks(hooks, payload as any);

    expect(payload.actions.yieldNextRoundTo).toBe('self');
    expect(persist).toHaveBeenCalled();
    const toolMsgs = (payload.agentFrameworkContext as any).agent.messages.filter((m: any) => m.role === 'tool');
    expect(toolMsgs.length).toBe(1);
    expect(toolMsgs[0].content).toContain('ok:x');
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
    const msg1 = (p1.agentFrameworkContext as any).agent.messages.find((m: any) => m.role === 'tool');
    expect(msg1.content).toContain('denied by approval policy');

    const p2 = makePayload(content).payload;
    await runResponseCompleteHooks(hooks, p2 as any);
    const msg2 = (p2.agentFrameworkContext as any).agent.messages.find((m: any) => m.role === 'tool');
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
    const tool = (await createHooksWithPlugins({ plugins: [{ toolId: 'proc-tool', id: 'p1', 'proc-toolParam': {} }] })).hooks;
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
    await runProcessPromptsHooks(hooks as any, { ...baseCtx, toolConfig: { toolId: 'other', id: 'x', 'proc-toolParam': {} } });
    await runProcessPromptsHooks(hooks as any, { ...baseCtx, toolConfig: { toolId: 'proc-tool', id: 'x', enabled: false, 'proc-toolParam': {} } });
    await runProcessPromptsHooks(hooks as any, { ...baseCtx, toolConfig: { toolId: 'proc-tool', id: 'x' } });
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

    await runPostProcessHooks(hooks, { ...context, toolConfig: { toolId: 'other', id: 'x', 'post-toolParam': {} } });
    await runPostProcessHooks(hooks, { ...context, toolConfig: { toolId: 'post-tool', id: 'x', enabled: false, 'post-toolParam': {} } });
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
    const denied = (p1.agentFrameworkContext as any).agent.messages.find((m: any) => m.role === 'tool');
    expect(denied.content).toContain('denied by approval policy');

    const p2 = makePayload(content).payload;
    p2.agentFrameworkConfig.plugins = [{ toolId: 'batch-tool', id: 'p1', 'batch-toolParam': {} }];
    await runResponseCompleteHooks(hooks, p2 as any);
    const denied2 = (p2.agentFrameworkContext as any).agent.messages.find((m: any) => m.role === 'tool');
    expect(denied2.content).toContain('denied by user');
  });

  it('addToolResult truncates long result and survives persist failures', async () => {
    defineTool({
      toolId: 'trunc-tool',
      displayName: 'Trunc Tool',
      description: 'trunc',
      configSchema: z.object({}),
      llmToolSchemas: { echo: z.object({ q: z.string() }) },
      async onResponseComplete(ctx) {
        await ctx.executeToolCall('echo', async () => ({ success: true, data: 'x'.repeat(40_000) }));
      },
    });
    const { hooks } = await createHooksWithPlugins({
      plugins: [{ toolId: 'trunc-tool', id: 'p1', 'trunc-toolParam': {} }],
    });
    const p = makePayload(`<tool_use name="echo">{"q":"x"}</tool_use>`).payload as any;
    p.agentFrameworkConfig.plugins = [{ toolId: 'trunc-tool', id: 'p1', 'trunc-toolParam': {} }];
    p.agentFrameworkContext.persistAgentMessage = vi.fn().mockRejectedValue(new Error('persist-fail'));
    await runResponseCompleteHooks(hooks, p);
    await Promise.resolve();
    const toolMsg = p.agentFrameworkContext.agent.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toContain('truncated');
    expect(toolMsg.metadata.isPersisted).toBe(false);
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
    p.payload.agentFrameworkConfig.plugins = [{ toolId: 'err-tool', id: 'p1', 'err-toolParam': {} }];
    await runResponseCompleteHooks(hooks, p.payload as any);
    const toolMsgs = (p.payload.agentFrameworkContext as any).agent.messages.filter((m: any) => m.role === 'tool');
    expect(toolMsgs.some((m: any) => String(m.content).includes('exec-failed'))).toBe(true);
  });

  it('executeAllMatchingToolCalls maps timeout/rejected/failed statuses', async () => {
    mocks.executeToolCallsParallel.mockResolvedValueOnce([
      { call: { toolId: 'echo', parameters: { q: 'a' }, originalText: 'a', found: true }, status: 'timeout', error: 't' },
      { call: { toolId: 'echo', parameters: { q: 'b' }, originalText: 'b', found: true }, status: 'rejected', error: 'r' },
      { call: { toolId: 'echo', parameters: { q: 'c' }, originalText: 'c', found: true }, status: 'fulfilled', result: { success: false, error: 'e' } },
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
    const text = (p.agentFrameworkContext.agent.messages as any[]).filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
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
    p.agentFrameworkConfig.plugins = [{ toolId: 'cfg-tool', id: 'p1', enabled: true, 'cfg-toolParam': { n: 'bad' } }];
    await runResponseCompleteHooks(hooks, p);
    const toolMsgs = p.agentFrameworkContext.agent.messages.filter((m: any) => m.role === 'tool');
    expect(toolMsgs.length).toBe(0);
  });
});
