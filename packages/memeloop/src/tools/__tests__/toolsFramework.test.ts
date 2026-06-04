import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { defineTool } from '../defineTool.js';
import { createAgentFrameworkHooks, createHooksWithPlugins, pluginRegistry, runProcessPromptsHooks, runResponseCompleteHooks } from '../pluginRegistry.js';
import { getToolParameterSchema, registerToolParameterSchema } from '../schemaRegistry.js';
import type { DefineToolAgentFrameworkContext } from '../types.js';

describe('tools framework', () => {
  it('registers tool parameter schema', () => {
    registerToolParameterSchema('demo', { type: 'object' }, { displayName: 'Demo', description: 'Demo tool' });
    expect(getToolParameterSchema('demo')).toEqual({ type: 'object' });
  });

  it('allows defining and registering a tool', async () => {
    const configSchema = z.object({});
    const def = defineTool({
      toolId: 'test-tool',
      displayName: 'Test Tool',
      description: 'A test tool',
      configSchema,
      async onProcessPrompts(ctx) {
        (ctx.prompts as { id: string }[]).push({ id: 'injected' });
      },
    });

    expect(def.toolId).toBe('test-tool');
    expect(pluginRegistry.has('test-tool')).toBe(true);

    const hooks = createAgentFrameworkHooks();
    const tool = pluginRegistry.get('test-tool');
    if (tool) tool(hooks);

    const result = await runProcessPromptsHooks(hooks, {
      prompts: [],
      messages: [],
      toolConfig: {
        toolId: 'test-tool',
        id: 'plugin-1',
        'test-toolParam': {},
      },
      agentFrameworkContext: {} as DefineToolAgentFrameworkContext,
    });

    expect(result.prompts).toHaveLength(1);
  });

  it('onResponseComplete yieldToHuman mutates shared payload.actions', async () => {
    const configSchema = z.object({ flag: z.boolean().optional() });
    defineTool({
      toolId: 'yield-tool',
      displayName: 'Yield Tool',
      description: 'Sets yield',
      configSchema,
      async onResponseComplete(ctx) {
        ctx.yieldToHuman();
      },
    });

    const { hooks } = await createHooksWithPlugins({
      plugins: [
        {
          toolId: 'yield-tool',
          id: 'p1',
          enabled: true,
          'yield-toolParam': { flag: true },
        },
      ],
    });

    const persist = vi.fn().mockResolvedValue(undefined);
    const payload = {
      agentFrameworkContext: {
        persistAgentMessage: persist,
        agent: { id: 'agent-1', messages: [] },
      } as unknown as DefineToolAgentFrameworkContext,
      response: { status: 'done' as const, content: 'ok' },
      agentFrameworkConfig: {
        plugins: [
          {
            toolId: 'yield-tool',
            id: 'p1',
            enabled: true,
            'yield-toolParam': { flag: true },
          },
        ],
      },
      requestId: undefined,
      toolConfig: { id: 'yield-tool', toolId: 'yield-tool' },
      actions: {} as { yieldNextRoundTo?: 'human' | 'self' },
    };

    await runResponseCompleteHooks(hooks, payload);
    expect(payload.actions.yieldNextRoundTo).toBe('human');
  });
});
