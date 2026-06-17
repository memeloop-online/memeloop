import { describe, expect, it } from 'vitest';

import type { AgentFrameworkContext, IToolRegistry } from '../../types.js';
import { DYNAMIC_POSITION_PLUGIN_TOOL_ID, registerBuiltinPromptPlugins } from '../builtinPromptPlugins.js';
import { promptConcatStream } from '../promptConcat.js';

describe('dynamicPosition modifier', () => {
  it('defers root prompt with dynamicPosition after second user turn', async () => {
    registerBuiltinPromptPlugins();
    const tools: IToolRegistry = {
      registerTool: () => {},
      getTool: () => undefined,
      listTools: () => [],
    };
    const context: AgentFrameworkContext = {
      storage: {} as AgentFrameworkContext['storage'],
      llmProvider: { name: 'x', chat: async () => ({}) },
      tools,
      syncAdapters: [],
      network: { start: async () => {}, stop: async () => {} },
    };

    const agentConfig = {
      agentFrameworkConfig: {
        prompts: [
          {
            id: 'tail',
            role: 'system' as const,
            text: 'B',
            dynamicPosition: 'deferToEnd' as const,
          },
          { id: 'first', role: 'system' as const, text: 'A' },
        ],
        plugins: [{ id: 'p1', toolId: DYNAMIC_POSITION_PLUGIN_TOOL_ID }],
      },
    };

    const messagesOnce = [
      {
        messageId: 'm1',
        conversationId: 'c1',
        originNodeId: 'local',
        timestamp: Date.now(),
        lamportClock: 1,
        role: 'user' as const,
        content: 'hi',
      },
    ];
    const gen1 = promptConcatStream(agentConfig, messagesOnce, context, undefined);
    let state1 = await gen1.next();
    while (!state1.done && !state1.value.isComplete) {
      state1 = await gen1.next();
    }
    const flat1 = state1.value?.flatPrompts ?? [];
    expect(flat1.map((m) => String(m.content))).toEqual(['B', 'A', 'hi']);

    const messagesTwice = [
      ...messagesOnce,
      {
        messageId: 'm2',
        conversationId: 'c1',
        originNodeId: 'local',
        timestamp: Date.now(),
        lamportClock: 2,
        role: 'assistant' as const,
        content: 'ok',
      },
      {
        messageId: 'm3',
        conversationId: 'c1',
        originNodeId: 'local',
        timestamp: Date.now(),
        lamportClock: 3,
        role: 'user' as const,
        content: 'again',
      },
    ];
    const gen2 = promptConcatStream(agentConfig, messagesTwice, context, undefined);
    let state2 = await gen2.next();
    while (!state2.done && !state2.value.isComplete) {
      state2 = await gen2.next();
    }
    const flat2 = state2.value?.flatPrompts ?? [];
    expect(flat2.map((m) => String(m.content))).toEqual(['A', 'B', 'again']);
  });
});
