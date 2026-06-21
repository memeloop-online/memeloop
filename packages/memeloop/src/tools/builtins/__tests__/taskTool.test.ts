import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAgentProfileRegistry } from '../../../agent/agentProfileRegistry.js';
import type { IAgentStorage, IChatSyncAdapter, ILLMProvider, INetworkService, IToolRegistry } from '../../../types.js';
import { MEMELOOP_STRUCTURED_TOOL_KEY } from '../../structuredToolResult.js';
import { getTaskToolId, taskToolImpl } from '../task.js';
import type { BuiltinToolContext } from '../types.js';

function createMinimalContext(overrides: Partial<BuiltinToolContext> = {}): BuiltinToolContext {
  const storage: IAgentStorage = {
    listConversations: vi.fn().mockResolvedValue([]),
    getMessages: vi.fn().mockResolvedValue([]),
    appendMessage: vi.fn().mockResolvedValue(undefined),
    upsertConversationMetadata: vi.fn().mockResolvedValue(undefined),
    insertMessagesIfAbsent: vi.fn().mockResolvedValue(undefined),
    getAttachment: vi.fn().mockResolvedValue(null),
    saveAttachment: vi.fn().mockResolvedValue(undefined),
    getAgentDefinition: vi.fn().mockResolvedValue(null),
    saveAgentInstance: vi.fn().mockResolvedValue(undefined),
    getConversationMeta: vi.fn().mockResolvedValue(null),
  };
  const llmProvider: ILLMProvider = {
    name: 'mock',
    chat: vi.fn().mockResolvedValue([]),
  };
  const tools: IToolRegistry = {
    registerTool: vi.fn(),
    getTool: vi.fn(),
    listTools: vi.fn().mockReturnValue([]),
  };
  const syncAdapters: IChatSyncAdapter[] = [];
  const network: INetworkService = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  return {
    storage,
    llmProvider,
    tools,
    syncAdapters,
    network,
    ...overrides,
  };
}

describe('taskToolImpl', () => {
  beforeEach(() => {
    resetAgentProfileRegistry();
  });

  it('returns error when required args are missing', async () => {
    const context = createMinimalContext();
    const result = (await taskToolImpl({}, context)) as { error?: string };
    expect(result.error).toContain("requires 'agent'");
  });

  it('returns error when prompt is empty', async () => {
    const context = createMinimalContext();
    const result = (await taskToolImpl({ agent: 'memeloop:build', prompt: '' }, context)) as {
      error?: string;
    };
    expect(result.error).toContain('non-empty string');
  });

  it('returns error for unknown agent', async () => {
    const context = createMinimalContext();
    const result = (await taskToolImpl({ agent: 'nonexistent', prompt: 'test' }, context)) as {
      error?: string;
    };
    expect(result.error).toContain('not found in registry');
  });

  it('returns error when runLocalAgent not configured', async () => {
    const context = createMinimalContext();
    const result = (await taskToolImpl(
      { agent: 'memeloop:build', prompt: 'test task' },
      context,
    )) as { error?: string };
    expect(result.error).toContain('Local agent runner not configured');
  });

  it('sync: returns structured result with agent-run detailRef on success', async () => {
    async function* runLocal(): AsyncIterable<{ type: 'message'; data: string }> {
      yield { type: 'message', data: 'task completed' };
    }
    const context = createMinimalContext({
      runLocalAgent: runLocal,
      localNodeId: 'node-x',
    });
    const result = (await taskToolImpl(
      { agent: 'memeloop:build', prompt: 'build something' },
      context,
    )) as Record<string, unknown>;

    expect(result.result).toBe('task completed');
    expect(typeof result.conversationId).toBe('string');
    expect(result.conversationId).toMatch(/^memeloop:build:/);
    expect(result.agentId).toBe('memeloop:build');

    const structured = result[MEMELOOP_STRUCTURED_TOOL_KEY] as {
      summary: string;
      detailRef: { type: string; conversationId: string; nodeId: string };
    };
    expect(structured.summary).toBe('task completed');
    expect(structured.detailRef.type).toBe('agent-run');
    expect(structured.detailRef.nodeId).toBe('node-x');
    expect(structured.detailRef.conversationId).toBe(result.conversationId);
  });

  it('sync: handles object message chunks (content field)', async () => {
    async function* runLocalObj(): AsyncGenerator<import('../../types.js').AgentLoopStep, void, unknown> {
      yield { type: 'message', data: { content: 'object output' } };
    }
    const context = createMinimalContext({ runLocalAgent: runLocalObj });
    const result = (await taskToolImpl(
      { agent: 'memeloop:build', prompt: 'test' },
      context,
    )) as Record<string, unknown>;
    expect(result.result).toBe('object output');
  });

  it('sync: returns (no text output) when no message steps are yielded', async () => {
    async function* runLocalNoMsg(): AsyncGenerator<import('../../types.js').AgentLoopStep, void, unknown> {
      yield { type: 'thinking', data: 'processing...' };
    }
    const context = createMinimalContext({
      runLocalAgent: runLocalNoMsg as BuiltinToolContext['runLocalAgent'],
    });
    const result = (await taskToolImpl(
      { agent: 'memeloop:build', prompt: 'test' },
      context,
    )) as Record<string, unknown>;
    expect(result.result).toBe('(no text output)');
  });

  it('sync: returns error on runner exception', async () => {
    const throwingRunner: NonNullable<BuiltinToolContext['runLocalAgent']> = () => {
      throw new Error('agent crash');
    };
    const context = createMinimalContext({ runLocalAgent: throwingRunner });
    const result = (await taskToolImpl({ agent: 'memeloop:build', prompt: 'test' }, context)) as {
      error?: string;
      conversationId?: string;
      agentId?: string;
    };
    expect(result.error).toContain('Task execution failed');
    expect(result.error).toContain('agent crash');
    expect(result.agentId).toBe('memeloop:build');
  });

  it('background: returns taskId immediately with fire-and-forget', async () => {
    let _runCount = 0;
    async function* runLocalBg(): AsyncGenerator<import('../../types.js').AgentLoopStep, void, unknown> {
      _runCount++;
      yield { type: 'message', data: 'bg task running' };
    }
    const context = createMinimalContext({
      runLocalAgent: runLocalBg,
      localNodeId: 'node-bg',
    });
    const result = (await taskToolImpl(
      { agent: 'memeloop:build', prompt: 'background job', background: true },
      context,
    )) as Record<string, unknown>;

    expect(result.background).toBe(true);
    expect(typeof result.taskId).toBe('string');
    expect(result.agentId).toBe('memeloop:build');

    const structured = result[MEMELOOP_STRUCTURED_TOOL_KEY] as {
      summary: string;
      detailRef: { type: string; conversationId: string; nodeId: string };
    };
    expect(structured.detailRef.type).toBe('agent-run');
  });

  it('applies per-agent tool permissions to the context', async () => {
    async function* runLocal(): AsyncIterable<{ type: 'message'; data: string }> {
      yield { type: 'message', data: 'done' };
    }
    const context = createMinimalContext({ runLocalAgent: runLocal });
    // Change the plan agent to have deny-write permissions
    // The task tool should apply these to the context
    await taskToolImpl({ agent: 'memeloop:plan', prompt: 'plan something' }, context);

    // Verify per-agent permissions were set
    const perAgent = (context.agentToolLoop?.toolPermissions as { perAgent?: Record<string, unknown> })?.perAgent ??
      {};
    expect(perAgent['memeloop:plan']).toBeDefined();
    expect((perAgent['memeloop:plan'] as { default: string }).default).toBe('deny');
    expect((perAgent['memeloop:plan'] as { rules: Array<{ pattern: string }> }).rules).toEqual(
      expect.arrayContaining([expect.objectContaining({ pattern: 'file.read', action: 'allow' })]),
    );
  });

  it('blocks excessive nesting depth', async () => {
    const context = createMinimalContext({
      activeToolConversationId: 'agent:sub:sub:deep', // 3 colons = depth 3
    });
    const result = (await taskToolImpl(
      { agent: 'memeloop:build', prompt: 'nested task' },
      context,
    )) as { error?: string };
    expect(result.error).toContain('Maximum agent nesting depth exceeded');
  });

  it('uses correct conversation ID format for each agent type', async () => {
    async function* runLocal(): AsyncIterable<{ type: 'message'; data: string }> {
      yield { type: 'message', data: 'ok' };
    }
    const context = createMinimalContext({ runLocalAgent: runLocal });

    const buildResult = (await taskToolImpl(
      { agent: 'memeloop:build', prompt: 'x' },
      context,
    )) as Record<string, unknown>;
    expect(buildResult.conversationId).toMatch(/^memeloop:build:/);

    const planResult = (await taskToolImpl(
      { agent: 'memeloop:plan', prompt: 'y' },
      context,
    )) as Record<string, unknown>;
    expect(planResult.conversationId).toMatch(/^memeloop:plan:/);
  });

  it('truncates long output summaries', async () => {
    const longText = 'x'.repeat(3000);
    async function* runLong(): AsyncGenerator<import('../../types.js').AgentLoopStep, void, unknown> {
      yield { type: 'message', data: longText };
    }
    const context = createMinimalContext({ runLocalAgent: runLong });
    const result = (await taskToolImpl(
      { agent: 'memeloop:build', prompt: 'test' },
      context,
    )) as Record<string, unknown>;

    // Full result is preserved
    expect(result.result).toBe(longText);

    // Structured summary is truncated to 2000 chars
    const structured = result[MEMELOOP_STRUCTURED_TOOL_KEY] as { summary: string };
    expect(structured.summary.length).toBeLessThanOrEqual(2000);
    expect(structured.summary.endsWith('...')).toBe(true);
  });
});

describe('getTaskToolId', () => {
  it("returns 'task'", () => {
    expect(getTaskToolId()).toBe('task');
  });
});
