import { describe, expect, it, vi } from 'vitest';

import { createAgentToolLoopRunner } from '../loopAPI/agent-tool-loop/loop.js';
import { registerBuiltinLoops } from '../loopAPI/plugins/builtinLoopsPlugin.js';
import { getLoopRegistry, resetLoopRegistry } from '../loopAPI/registry.js';
import { BUILTIN_AGENT_AGENT_LOOP_QUALITY_GATE_SCRIPT_ID } from '../loops/agent-agent-loop/builtinLoopSources.js';
import { BUILTIN_AGENT_TOOL_LOOP_DEFAULT_SCRIPT_ID } from '../loops/agent-tool-loop/builtinLoopSources.js';
import { createMemeLoopRuntime } from '../runtime.js';
import type { AgentFrameworkContext, IAgentStorage, ILLMProvider, IToolRegistry } from '../types.js';

/**
 * Ensures MemeLoopRuntime + createAgentToolLoopRunner (AgentToolLoop) runs LLM rounds and registry tools,
 * not only persisting user messages.
 */
describe('createMemeLoopRuntime + createAgentToolLoopRunner pipeline', () => {
  function buildContextWithEchoTool(): {
    context: AgentFrameworkContext;
    storage: IAgentStorage;
    llmRounds: { value: number };
  } {
    const messageLog: import('../conversation/index.js').ChatMessage[] = [];
    const llmRounds = { value: 0 };
    const llmProvider: ILLMProvider = {
      name: 'scripted',
      async *chat() {
        llmRounds.value += 1;
        if (llmRounds.value === 1) {
          yield '<tool_use name="e2eEcho">{"text":"pipeline"}</tool_use>';
        } else {
          yield 'assistant-final-after-tool';
        }
      },
    };
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
    const tools: IToolRegistry = {
      registerTool: vi.fn(),
      getTool: vi.fn().mockImplementation((id: string) => {
        if (id === 'e2eEcho') {
          return async (args: Record<string, unknown>) => ({ result: `echo:${String(args.text)}` });
        }
        return undefined;
      }),
      listTools: vi.fn().mockReturnValue(['e2eEcho']),
    };
    const conversationCancellation = new Set<string>();
    const context: AgentFrameworkContext = {
      storage,
      llmProvider,
      tools,
      syncAdapters: [],
      network: { start: vi.fn(), stop: vi.fn() },
      agentToolLoop: {
        maxIterations: 8,
        isCancelled: (cid) => conversationCancellation.has(cid),
      },
      conversationCancellation,
    };
    const runLocal = createAgentToolLoopRunner(context);
    context.runAgentToolLoop = runLocal;
    return { context, storage, llmRounds };
  }

  it('sendMessage runs AgentToolLoop tool loop and persists user, tool, and assistant messages', async () => {
    const { context, storage, llmRounds } = buildContextWithEchoTool();
    const runtime = createMemeLoopRuntime(context);
    const { conversationId } = await runtime.createAgent({
      definitionId: 'memeloop:general-assistant',
    });

    const settled = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error('agent-done timeout'));
      }, 15_000);
      const off = runtime.subscribeToUpdates(conversationId, (u) => {
        if ((u as { type?: string }).type === 'agent-done') {
          clearTimeout(t);
          off();
          resolve();
        }
        if ((u as { type?: string }).type === 'agent-error') {
          clearTimeout(t);
          off();
          reject(new Error((u as { error?: string }).error ?? 'agent-error'));
        }
      });
      void runtime.sendMessage({ conversationId, message: 'please use echo' });
    });

    await settled;

    expect(llmRounds.value).toBe(2);
    const calls = (storage.appendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as import('../conversation/index.js').ChatMessage).role,
    );
    expect(calls).toContain('user');
    expect(calls).toContain('tool');
    expect(calls).toContain('assistant');
    const contents = (storage.appendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as import('../conversation/index.js').ChatMessage).content,
    );
    expect(contents.some((c) => c.includes('assistant-final-after-tool'))).toBe(true);
    expect(contents.some((c) => c.includes('echo:pipeline') || c.includes('e2eEcho'))).toBe(true);
  });

  it('createAgent with initialMessage runs AgentToolLoop when runAgentToolLoop is set', async () => {
    const { context, storage, llmRounds } = buildContextWithEchoTool();
    const runtime = createMemeLoopRuntime(context);
    const { conversationId } = await runtime.createAgent({
      definitionId: 'memeloop:general-assistant',
      initialMessage: 'start',
    });

    for (let i = 0; i < 300; i += 1) {
      const msgs = await storage.getMessages(conversationId, { mode: 'full-content' });
      if (msgs.some((m) => m.role === 'assistant')) {
        break;
      }
      if (i === 299) {
        throw new Error('expected assistant message after initialMessage createAgent');
      }

      await new Promise((r) => setTimeout(r, 50));
    }

    expect(llmRounds.value).toBeGreaterThanOrEqual(1);
  });

  it('runs a profile-selected loop and installs profile plugins when no runAgentToolLoop is injected', async () => {
    resetLoopRegistry();
    const messageLog: import('../conversation/index.js').ChatMessage[] = [];
    const conversationMeta = new Map<string, import('../sync/protocol.js').ConversationMeta>();
    const toolsById = new Map<string, unknown>();
    const llmRounds = { value: 0 };
    const llmProvider: ILLMProvider = {
      name: 'scripted',
      async *chat() {
        llmRounds.value += 1;
        if (llmRounds.value === 1) {
          yield '<tool_use name="profileEcho">{"text":"profile"}</tool_use>';
        } else {
          yield 'profile-final-after-tool';
        }
      },
    };
    const storage: IAgentStorage = {
      listConversations: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockImplementation(async () => [...messageLog]),
      appendMessage: vi.fn().mockImplementation(async (message) => {
        messageLog.push(message);
      }),
      upsertConversationMetadata: vi.fn().mockImplementation(async (meta) => {
        conversationMeta.set(meta.conversationId, meta);
      }),
      insertMessagesIfAbsent: vi.fn().mockResolvedValue(undefined),
      getAttachment: vi.fn().mockResolvedValue(null),
      saveAttachment: vi.fn().mockResolvedValue(undefined),
      getAgentDefinition: vi.fn().mockImplementation(async (id: string) => ({
        id,
        name: 'Profile Runtime',
        description: 'Profile runtime test',
        systemPrompt: 'Use profile tools when needed.',
        tools: ['profileEcho'],
        loopId: 'agent-tool-loop',
        plugins: [{ id: 'test:profile-echo' }],
        agentFrameworkConfig: {
          prompts: [{ id: 'system', role: 'system', text: 'Use profile tools when needed.' }],
          plugins: [],
          response: [],
        },
        version: '1.0.0',
      })),
      saveAgentInstance: vi.fn().mockResolvedValue(undefined),
      getConversationMeta: vi.fn().mockImplementation(async (conversationId: string) => conversationMeta.get(conversationId) ?? null),
    };
    const tools: IToolRegistry = {
      registerTool: vi.fn().mockImplementation((id: string, implementation: unknown) => {
        toolsById.set(id, implementation);
      }),
      getTool: vi.fn().mockImplementation((id: string) => toolsById.get(id)),
      listTools: vi.fn().mockImplementation(() => [...toolsById.keys()]),
    };
    const context: AgentFrameworkContext = {
      storage,
      llmProvider,
      tools,
      syncAdapters: [],
      network: { start: vi.fn(), stop: vi.fn() },
      agentToolLoop: { maxIterations: 8 },
    };
    getLoopRegistry().registerPlugin({
      id: 'test:profile-echo',
      targetLoopId: 'agent-tool-loop',
      install: target => {
        const registry = target.toolRegistry as IToolRegistry;
        registry.registerTool('profileEcho', async (args: Record<string, unknown>) => ({
          result: `profile:${String(args.text)}`,
        }));
      },
    });

    const runtime = createMemeLoopRuntime(context);
    const { conversationId } = await runtime.createAgent({ definitionId: 'profile:runtime' });

    const settled = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('agent-done timeout'));
      }, 15_000);
      const off = runtime.subscribeToUpdates(conversationId, update => {
        if ((update as { type?: string }).type === 'agent-done') {
          clearTimeout(timeout);
          off();
          resolve();
        }
        if ((update as { type?: string }).type === 'agent-error') {
          clearTimeout(timeout);
          off();
          reject(new Error((update as { error?: string }).error ?? 'agent-error'));
        }
      });
      void runtime.sendMessage({ conversationId, message: 'please use profile echo' });
    });

    await settled;

    expect(tools.registerTool).toHaveBeenCalledWith('profileEcho', expect.any(Function));
    expect(llmRounds.value).toBe(2);
    expect(messageLog.map(message => message.role)).toEqual(expect.arrayContaining(['user', 'tool', 'assistant']));
    expect(messageLog.some(message => message.content.includes('profile-final-after-tool')))
      .toBe(true);
  });

  it('runs a builtin AGENT_TOOL_LOOP .mjs script through createMemeLoopRuntime', async () => {
    resetLoopRegistry();
    registerBuiltinLoops();
    const conversationMeta = new Map<string, import('../sync/protocol.js').ConversationMeta>();
    const messageLog: import('../conversation/index.js').ChatMessage[] = [];
    const llmProvider: ILLMProvider = {
      name: 'scripted-agent-tool-loop-script',
      async *chat() {
        yield 'agent-tool-loop-script-final';
      },
    };
    const storage: IAgentStorage = {
      listConversations: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockImplementation(async () => [...messageLog]),
      appendMessage: vi.fn().mockImplementation(async (message: import('../conversation/index.js').ChatMessage) => {
        messageLog.push(message);
      }),
      upsertConversationMetadata: vi.fn().mockImplementation(async (meta: import('../sync/protocol.js').ConversationMeta) => {
        conversationMeta.set(meta.conversationId, meta);
      }),
      insertMessagesIfAbsent: vi.fn().mockResolvedValue(undefined),
      getAttachment: vi.fn().mockResolvedValue(null),
      saveAttachment: vi.fn().mockResolvedValue(undefined),
      getAgentDefinition: vi.fn().mockImplementation(async (definitionId: string) => ({
        id: definitionId,
        name: 'LLM IO Script',
        description: 'LLM IO Script',
        loopId: 'agent-tool-loop',
        scriptReference: { kind: 'builtin', id: BUILTIN_AGENT_TOOL_LOOP_DEFAULT_SCRIPT_ID },
        systemPrompt: 'scripted',
        tools: [],
        version: '1.0.0',
      })),
      saveAgentInstance: vi.fn().mockResolvedValue(undefined),
      getConversationMeta: vi.fn().mockImplementation(async (conversationId: string) => conversationMeta.get(conversationId) ?? null),
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
      syncAdapters: [],
      network: { start: vi.fn(), stop: vi.fn() },
      agentToolLoop: { maxIterations: 2 },
    };

    const runtime = createMemeLoopRuntime(context);
    const { conversationId } = await runtime.createAgent({ definitionId: 'profile:agent-tool-loop-script' });
    const settled = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('agent-tool-loop script timeout'));
      }, 15_000);
      const off = runtime.subscribeToUpdates(conversationId, update => {
        if ((update as { type?: string }).type === 'agent-done') {
          clearTimeout(timeout);
          off();
          resolve();
        }
        if ((update as { type?: string }).type === 'agent-error') {
          clearTimeout(timeout);
          off();
          reject(new Error((update as { error?: string }).error ?? 'agent-error'));
        }
      });
      void runtime.sendMessage({ conversationId, message: 'run scripted llm io' });
    });

    await settled;

    expect(messageLog.some(message => message.content.includes('agent-tool-loop-script-final'))).toBe(true);
  });

  it('runs a agent-agent-loop profile script through createMemeLoopRuntime child-agent support', async () => {
    resetLoopRegistry();
    registerBuiltinLoops();
    const conversationMeta = new Map<string, import('../sync/protocol.js').ConversationMeta>();
    const messageLog: import('../conversation/index.js').ChatMessage[] = [];
    const llmProvider: ILLMProvider = {
      name: 'scripted-child',
      async *chat() {
        yield 'child-result';
      },
    };
    const source = `
      export default async function run(ctx) {
        const result = await ctx.runAgent({ profile: 'profile:child', prompt: ctx.input.message, conversationId: 'child-conversation' });
        ctx.finish('parent:' + result.text);
      }
    `;
    const storage: IAgentStorage = {
      listConversations: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue([]),
      appendMessage: vi.fn().mockImplementation(async (message: import('../conversation/index.js').ChatMessage) => {
        messageLog.push(message);
      }),
      upsertConversationMetadata: vi.fn().mockImplementation(async (meta: import('../sync/protocol.js').ConversationMeta) => {
        conversationMeta.set(meta.conversationId, meta);
      }),
      insertMessagesIfAbsent: vi.fn().mockResolvedValue(undefined),
      getAttachment: vi.fn().mockResolvedValue(null),
      saveAttachment: vi.fn().mockResolvedValue(undefined),
      getAgentDefinition: vi.fn().mockImplementation(async (definitionId: string) => {
        if (definitionId === 'profile:parent') {
          return {
            id: 'profile:parent',
            name: 'Parent',
            description: 'Parent',
            loopId: 'agent-agent-loop',
            scriptReference: { kind: 'source', source, name: 'runtime-parent.mjs' },
            systemPrompt: 'parent',
            tools: [],
            version: '1.0.0',
          };
        }
        if (definitionId === 'profile:child') {
          return {
            id: 'profile:child',
            name: 'Child',
            description: 'Child',
            loopId: 'agent-tool-loop',
            systemPrompt: 'child',
            tools: [],
            version: '1.0.0',
          };
        }
        return null;
      }),
      saveAgentInstance: vi.fn().mockResolvedValue(undefined),
      getConversationMeta: vi.fn().mockImplementation(async (conversationId: string) => conversationMeta.get(conversationId) ?? null),
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
      syncAdapters: [],
      network: { start: vi.fn(), stop: vi.fn() },
      agentToolLoop: { maxIterations: 2 },
      loopScriptPolicy: { allowSource: true },
    };

    const runtime = createMemeLoopRuntime(context);
    const { conversationId } = await runtime.createAgent({ definitionId: 'profile:parent' });
    const settled = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('agent-agent-loop timeout'));
      }, 15_000);
      const off = runtime.subscribeToUpdates(conversationId, update => {
        if ((update as { type?: string }).type === 'agent-done') {
          clearTimeout(timeout);
          off();
          resolve();
        }
        if ((update as { type?: string }).type === 'agent-error') {
          clearTimeout(timeout);
          off();
          reject(new Error((update as { error?: string }).error ?? 'agent-error'));
        }
      });
      void runtime.sendMessage({ conversationId, message: 'delegate' });
    });

    await settled;

    expect(messageLog.some(message => message.content.includes('child-result'))).toBe(true);
  });

  it('runs the bundled quality-gate agent-agent-loop script through createMemeLoopRuntime', async () => {
    resetLoopRegistry();
    registerBuiltinLoops();
    const conversationMeta = new Map<string, import('../sync/protocol.js').ConversationMeta>();
    const messageLog: import('../conversation/index.js').ChatMessage[] = [];
    const llmProvider: ILLMProvider = {
      name: 'scripted-bundled-child',
      async *chat(request) {
        const requestRecord = request as { conversationId?: string };
        const conversationId = typeof requestRecord.conversationId === 'string' ? requestRecord.conversationId : '';
        if (conversationId.includes(':review:')) {
          yield 'APPROVED\nready';
          return;
        }
        yield `child-result:${conversationId}`;
      },
    };
    const storage: IAgentStorage = {
      listConversations: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue([]),
      appendMessage: vi.fn().mockImplementation(async (message: import('../conversation/index.js').ChatMessage) => {
        messageLog.push(message);
      }),
      upsertConversationMetadata: vi.fn().mockImplementation(async (meta: import('../sync/protocol.js').ConversationMeta) => {
        conversationMeta.set(meta.conversationId, meta);
      }),
      insertMessagesIfAbsent: vi.fn().mockResolvedValue(undefined),
      getAttachment: vi.fn().mockResolvedValue(null),
      saveAttachment: vi.fn().mockResolvedValue(undefined),
      getAgentDefinition: vi.fn().mockImplementation(async (definitionId: string) => {
        if (definitionId === 'profile:parent-bundled') {
          return {
            id: 'profile:parent-bundled',
            name: 'Parent Bundled',
            description: 'Parent bundled',
            loopId: 'agent-agent-loop',
            scriptReference: { kind: 'builtin', id: BUILTIN_AGENT_AGENT_LOOP_QUALITY_GATE_SCRIPT_ID },
            metadata: { workers: ['profile:child-a'], reviewers: ['profile:child-b'] },
            systemPrompt: 'parent',
            tools: [],
            version: '1.0.0',
          };
        }
        if (definitionId === 'profile:child-a' || definitionId === 'profile:child-b') {
          return {
            id: definitionId,
            name: definitionId,
            description: definitionId,
            loopId: 'agent-tool-loop',
            systemPrompt: 'child',
            tools: [],
            version: '1.0.0',
          };
        }
        return null;
      }),
      saveAgentInstance: vi.fn().mockResolvedValue(undefined),
      getConversationMeta: vi.fn().mockImplementation(async (conversationId: string) => conversationMeta.get(conversationId) ?? null),
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
      syncAdapters: [],
      network: { start: vi.fn(), stop: vi.fn() },
      agentToolLoop: { maxIterations: 2 },
    };

    const runtime = createMemeLoopRuntime(context);
    const { conversationId } = await runtime.createAgent({ definitionId: 'profile:parent-bundled' });
    const settled = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('bundled agent-agent-loop timeout'));
      }, 15_000);
      const off = runtime.subscribeToUpdates(conversationId, update => {
        if ((update as { type?: string }).type === 'agent-done') {
          clearTimeout(timeout);
          off();
          resolve();
        }
        if ((update as { type?: string }).type === 'agent-error') {
          clearTimeout(timeout);
          off();
          reject(new Error((update as { error?: string }).error ?? 'agent-error'));
        }
      });
      void runtime.sendMessage({ conversationId, message: 'delegate bundled' });
    });

    await settled;

    expect(messageLog.some(message => message.content.includes('child-result:profile:parent-bundled:') && message.content.includes(':work:1:0'))).toBe(true);
    expect(messageLog.some(message => message.content.includes('APPROVED'))).toBe(true);
  });
});
