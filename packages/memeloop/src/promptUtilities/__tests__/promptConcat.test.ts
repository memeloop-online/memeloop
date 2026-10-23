import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createTestStorage } from '../../__tests__/testStorage.js';
import type { AgentDefinition } from '../../agent/types.js';
import { buildLlmMessages } from '../../loopAPI/agent-tool-loop/modelMessages.js';
import { LoopRegistryImpl } from '../../loopAPI/registry.js';
import { defineTool } from '../../tools/defineTool.js';
import type { PromptConcatTool } from '../../tools/types.js';
import type { AgentFrameworkContext } from '../../types.js';
import { collectPromptSourcePaths, findPromptById, flattenPrompts, promptConcatStream } from '../promptConcat.js';

describe('promptConcat', () => {
  it('collectPromptSourcePaths and findPromptById handle nested prompts', () => {
    const prompts: any[] = [{ id: 'a', children: [{ id: 'b' }] }, { id: 'c' }];
    const paths = collectPromptSourcePaths(prompts);
    expect(paths.a).toBe('agentFrameworkConfig.prompts.0');
    expect(paths.b).toBe('agentFrameworkConfig.prompts.0.children.0');
    expect(findPromptById(prompts, 'b')?.prompt.id).toBe('b');
    expect(findPromptById(prompts, 'missing')).toBeUndefined();
  });

  it('flattenPrompts skips disabled and merges roleless children', () => {
    const flat = flattenPrompts([
      { role: 'system', text: 'S', children: [{ text: '1' }, { role: 'assistant', text: 'A1' }] },
      { role: 'user', text: 'U', enabled: false },
    ] as any);
    expect(flat).toEqual([
      { role: 'system', content: 'S1' },
      { role: 'system', content: '1' },
      { role: 'assistant', content: 'A1' },
    ]);
  });

  it('promptConcatStream appends user text and attachment variants', async () => {
    const baseConfig: any = {
      agentFrameworkConfig: { prompts: [{ role: 'system', text: 'sys' }], plugins: [] },
    };
    const ctx: any = { tools: { getPromptPlugins: () => new Map() } };

    const run1 = promptConcatStream(baseConfig, [{ role: 'user', content: 'hello' } as any], ctx);
    const s1 = (await run1.next()).value;
    expect(s1.flatPrompts.at(-1)).toEqual({ role: 'user', content: 'hello' });

    const msgWithPath = [
      { role: 'user', content: 'img', metadata: { file: { path: '/tmp/a.png' } } },
    ] as any;
    const run2 = promptConcatStream(baseConfig, msgWithPath, ctx);
    const s2 = (await run2.next()).value;
    expect(String(s2.flatPrompts.at(-1)?.content)).toContain('[attached path: /tmp/a.png]');

    const run3 = promptConcatStream(baseConfig, msgWithPath, ctx, {
      readAttachmentFile: async () => new Uint8Array([1, 2, 3]),
    });
    const s3 = (await run3.next()).value;
    expect(Array.isArray(s3.flatPrompts.at(-1)?.content)).toBe(true);
    expect((s3.flatPrompts.at(-1) as any).content[0].type).toBe('image');

    const run4 = promptConcatStream(baseConfig, msgWithPath, ctx, {
      readAttachmentFile: async () => {
        throw new Error('read-failed');
      },
    });
    const s4 = (await run4.next()).value;
    // readAttachmentFile failed => should not append attachment payload branch
    expect((s4.flatPrompts.at(-1) as any).content).not.toEqual(expect.any(Array));
  });

  it('gives ToolDefinition injection a mutable copy of a frozen profile prompt tree', async () => {
    const registry = new LoopRegistryImpl();
    registry.registerProfile({
      id: 'profile:frozen-prompts',
      name: 'Frozen prompts',
      description: '',
      systemPrompt: '',
      tools: [],
      version: '1',
      agentFrameworkConfig: {
        prompts: [{ id: 'frozen-target', role: 'system', text: 'base:' }],
        plugins: [{
          id: 'injector-config',
          toolId: 'test-injector',
          'test-injectorParam': {},
        }],
      },
    });
    const profile = registry.getProfile('profile:frozen-prompts')!;
    expect(Object.isFrozen(profile.agentFrameworkConfig?.prompts)).toBe(true);
    expect(Object.isFrozen(profile.agentFrameworkConfig?.prompts[0])).toBe(true);

    const promptPlugins = new Map<string, PromptConcatTool>();
    defineTool({
      toolId: 'test-injector',
      displayName: 'Test injector',
      description: 'Injects a prompt child',
      configSchema: z.object({}),
      async onProcessPrompts(context) {
        context.injectContent({
          targetId: 'frozen-target',
          position: 'child',
          content: 'injected',
        });
      },
    }, { pluginRegistry: promptPlugins });
    const context: AgentFrameworkContext = {
      storage: createTestStorage(),
      llmProvider: {
        name: 'unused',
        chat: async () => ({ type: 'finish', finishReason: 'stop' }),
      },
      tools: { registerTool: () => {}, getTool: () => undefined, listTools: () => [] },
      promptPlugins,
      syncAdapters: [],
      network: { start: async () => undefined, stop: async () => undefined },
    };

    const messages = await buildLlmMessages(
      context,
      profile as unknown as AgentDefinition,
      [],
    );

    expect(messages.map(message => message.content)).toEqual(['base:injected', 'injected']);
    expect(profile.agentFrameworkConfig?.prompts[0]?.children).toBeUndefined();
  });
});
