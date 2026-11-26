import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { configureLoopTestContext, typedTextChat } from '../../__tests__/testLoopContext.js';
import { createTestStorage } from '../../__tests__/testStorage.js';
import type { AgentDefinition } from '../../agent/types.js';
import type { ChatMessage } from '../../conversation/index.js';
import { defineTool as defineToolForRegistry } from '../../tools/defineTool.js';
import type { ToolDefinition } from '../../tools/defineToolTypes.js';
import type { PromptConcatTool } from '../../tools/types.js';
import type { AgentFrameworkContext, ILLMProvider, IToolRegistry } from '../../types.js';
import { createAgentToolLoopRunner } from '../agent-tool-loop/loop.js';
import { HookRegistry } from '../hooks/registry.js';
import type { AgentLoopStep } from '../types.js';

const promptPlugins = new Map<string, PromptConcatTool>();
const hookRegistry = new HookRegistry();
const clearHooks = () => {
  hookRegistry.clearHooks();
};

function defineTool<
  TConfigSchema extends z.ZodType,
  TLLMToolSchemas extends Record<string, z.ZodType> = Record<string, z.ZodType>,
>(definition: ToolDefinition<TConfigSchema, TLLMToolSchemas>) {
  return defineToolForRegistry(definition, { pluginRegistry: promptPlugins });
}

function makeStorage(log: ChatMessage[]) {
  return createTestStorage({ messages: log });
}

function makeContext(log: ChatMessage[], llmChat: Parameters<typeof typedTextChat>[0], tools?: Partial<IToolRegistry>) {
  const registry: IToolRegistry = {
    registerTool: vi.fn(),
    getTool: vi.fn().mockReturnValue(async () => ({ result: 'registry-ok' })),
    listTools: vi.fn().mockReturnValue(['echo']),
    ...tools,
  };
  const context: AgentFrameworkContext = {
    storage: makeStorage(log),
    llmProvider: { name: 'mock', chat: typedTextChat(llmChat) },
    tools: registry,
    syncAdapters: [],
    network: {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    },
    localNodeId: 'test-node',
    promptPlugins,
    hooks: hookRegistry,
  };
  return configureLoopTestContext(context);
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

function getRequestMessages(request: unknown): unknown[] {
  if (typeof request !== 'object' || request === null || !('messages' in request)) {
    throw new Error('expected an LLM request with messages');
  }
  const { messages } = request;
  if (!Array.isArray(messages)) throw new Error('expected request.messages to be an array');
  return messages as unknown[];
}

describe('agentToolLoop more branch cases', () => {
  afterEach(() => {
    clearHooks();
    promptPlugins.clear();
  });

  it('plugin executes tool -> pending empty but calls non-empty => continues to next LLM round', async () => {
    defineTool({
      toolId: 'plugin-echo',
      displayName: 'Plugin Echo',
      description: 'handles tool call',
      configSchema: z.object({}),
      llmToolSchemas: { echo: z.object({ text: z.string() }) },
      async onResponseComplete(ctx) {
        await ctx.executeToolCall('echo', async (p) => ({ success: true, data: `p:${p.text}` }));
      },
    });

    let round = 0;
    const log: ChatMessage[] = [];
    const context = makeContext(log, async function*() {
      round += 1;
      if (round === 1) yield '<tool_use name="echo">{"text":"hi"}</tool_use>';
      else yield 'final';
    });
    context.resolveAgentDefinition = async () =>
      makeDefinition('test:agent', {
        prompts: [],
        plugins: [{ toolId: 'plugin-echo', id: 'p1', 'plugin-echoParam': {} }],
      });
    context.agentToolLoop = { maxIterations: 4, textToolCallProtocolEnabled: true };

    for await (const _ of createAgentToolLoopRunner(context)({ conversationId: 'd1:c1', message: 'u' })) {
      /* drain */
    }
    expect(round).toBe(2);
    expect(log.some((m) => m.role === 'tool' && m.content.includes('p:hi'))).toBe(true);
  });

  it('hasPlugins + pending>0 but fallbackRegistryTools=false => continues and hits max-iterations', async () => {
    defineTool({
      toolId: 'plugin-noop',
      displayName: 'Plugin Noop',
      description: 'does not handle tool calls',
      configSchema: z.object({}),
      async onResponseComplete() {
        /* noop */
      },
    });
    const log: ChatMessage[] = [];
    const context = makeContext(log, async function*() {
      yield '<tool_use name="echo">{"x":1}</tool_use>';
    });
    context.resolveAgentDefinition = async () =>
      makeDefinition('test:agent', {
        prompts: [],
        plugins: [{ toolId: 'plugin-noop', id: 'p1', 'plugin-noopParam': {} }],
      });
    context.agentToolLoop = { maxIterations: 1, fallbackRegistryTools: false, textToolCallProtocolEnabled: true };

    const steps: AgentLoopStep[] = [];
    for await (const s of createAgentToolLoopRunner(context)({ conversationId: 'd1:c2', message: 'u' })) {
      steps.push(s);
    }
    expect(steps).toContainEqual(expect.objectContaining({
      type: 'thinking',
      data: expect.objectContaining({ status: 'max-iterations' }),
    }));
    expect(log.some((m) => m.role === 'tool')).toBe(false);
  });

  it('calls present but enableToolLoop=false => returns without executing tool', async () => {
    const log: ChatMessage[] = [];
    const context = makeContext(log, async function*() {
      yield '<tool_use name="echo">{"x":1}</tool_use>';
    });
    context.agentToolLoop = { maxIterations: 2, enableToolLoop: false, textToolCallProtocolEnabled: true };

    for await (const _ of createAgentToolLoopRunner(context)({ conversationId: 'c3', message: 'u' })) {
      /* drain */
    }
    expect(log.some((m) => m.role === 'tool')).toBe(false);
  });

  it('keeps XML-looking plain text inert when text protocol capability is disabled', async () => {
    const log: ChatMessage[] = [];
    const text = '<tool_use name="echo">{"x":1}</tool_use>';
    const context = makeContext(log, async function*() {
      yield text;
    });
    context.agentToolLoop = { maxIterations: 2, textToolCallProtocolEnabled: false };

    for await (const _ of createAgentToolLoopRunner(context)({ conversationId: 'c4', message: 'u' })) {
      /* drain */
    }
    expect(log.some((m) => m.role === 'tool')).toBe(false);
    expect(log.find((m) => m.role === 'assistant')?.content).toContain(text);
  });

  it('fails closed when a conversation has no explicit definition identity', async () => {
    const log: ChatMessage[] = [];
    const storage = createTestStorage({ messages: log }, {
      getConversationMeta: vi.fn().mockResolvedValue(null),
    });
    const llmProvider: ILLMProvider = {
      name: 'mock',
      chat: typedTextChat(async function*() {
        yield 'plain answer';
      }),
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
      promptPlugins,
      hooks: hookRegistry,
      syncAdapters: [],
      network: {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      agentToolLoop: { maxIterations: 2 },
      localNodeId: 'test-node',
    };
    const drain = async () => {
      for await (const _ of createAgentToolLoopRunner(context)({ conversationId: 'noColon', message: 'u' })) {
        /* drain */
      }
    };
    await expect(drain()).rejects.toThrow("conversation 'noColon' has no explicit definitionId");
  });

  it('preserves complete recent turns across repeated tool iterations', async () => {
    const now = Date.now();
    const history: ChatMessage[] = Array.from({ length: 6 }).map((_, i) => ({
      messageId: `m${i}`,
      turnId: i === 0 ? 'm0' : 'm0',
      conversationId: 'c',
      originNodeId: 'local',
      originSequence: i + 1,
      timestamp: now + i,
      lamportClock: i + 1,
      role: i === 0 ? 'user' : 'assistant',
      parts: [{ type: 'text', text: `t${i}` }],
      content: `t${i}`,
    }));
    // First run: replayLastUserMessage === false => just tail
    {
      const log: ChatMessage[] = [...history];
      const seen: unknown[] = [];
      const context = makeContext(log, async function*(req) {
        seen.push(req);
        yield 'done';
      });
      context.agentToolLoop = {
        maxIterations: 1,
        textToolCallProtocolEnabled: true,
        autoCompact: { recentTurnsToKeep: 32, maxTokens: 128_000 },
      };
      for await (const _ of createAgentToolLoopRunner(context)({ conversationId: 'c', message: 'u' })) {
        /* drain */
      }
      expect(getRequestMessages(seen[0])).toHaveLength(8);
    }

    // Second run: force a 2nd iteration so last message is tool/assistant and lastUser may be outside tail.
    {
      let round = 0;
      const seen2: unknown[] = [];
      const context2 = makeContext([...history], async function*(req) {
        seen2.push(req);
        round += 1;
        if (round === 1) {
          yield '<tool_use name="echo">{"x":1}</tool_use>';
        } else {
          yield 'final';
        }
      });
      context2.agentToolLoop = {
        maxIterations: 3,
        textToolCallProtocolEnabled: true,
        autoCompact: { recentTurnsToKeep: 32, maxTokens: 128_000 },
      };
      for await (const _ of createAgentToolLoopRunner(context2)({ conversationId: 'c', message: 'u' })) {
        /* drain */
      }
      expect(seen2.length).toBeGreaterThanOrEqual(2);
      expect(getRequestMessages(seen2[1])).toContainEqual(expect.objectContaining({ content: 't0' }));
    }

    // agentToolLoop always appends a user message first, so the branch with zero user messages is unreachable in the integration path.
  });
});
