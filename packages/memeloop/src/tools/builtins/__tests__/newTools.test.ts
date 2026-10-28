import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestStorage } from '../../../__tests__/testStorage.js';
import { LoopRegistryImpl } from '../../../loopAPI/registry.js';
import type { ILLMProvider, INetworkService, IToolRegistry } from '../../../types.js';
import { ASK_USER_QUESTION_TOOL_ID, askUserQuestionImpl, registerBuiltinTools, TODO_WRITE_TOOL_ID, todoWriteImpl } from '../index.js';
import { QuestionWaitBroker } from '../questionWaitRegistry.js';
import { InMemoryTodoStateStore, type TodoItem, type TodoStateStore } from '../todoWrite.js';
import type { BuiltinToolContext } from '../types.js';

// ─── mock questionWaitRegistry ──────────────────────────────────────────
const waitForQuestionAnswer = vi.fn();
vi.mock('../questionWaitRegistry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../questionWaitRegistry.js')>()),
  waitForQuestionAnswer: async (...parameters: unknown[]) => {
    const answer = await (waitForQuestionAnswer(...parameters) as Promise<unknown>);
    return answer;
  },
}));

// ─── mock global fetch for webSearch/webFetch ───────────────────────────
const globalFetch = vi.fn();
globalThis.fetch = globalFetch as unknown as typeof fetch;

// ─── mocks ─────────────────────────────────────────────────────────────
// execFile is mocked to prevent real system calls in LSP stubs.
// Must be defined inside vi.mock factory to avoid hoisting issues.

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => {
    const lastArg = args[args.length - 1];
    if (typeof lastArg === 'function') {
      setImmediate(() => {
        (lastArg as (error: Error | null, output: { stdout: string; stderr: string }) => void)(
          null,
          { stdout: '', stderr: '' },
        );
      });
    }
  },
}));

const nativeCrypto = globalThis.crypto;
vi.stubGlobal('crypto', {
  getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto),
  randomUUID: () => 'mock-uuid-123',
});

// ─── helpers ────────────────────────────────────────────────────────────

function createMinimalContext(overrides: Partial<BuiltinToolContext> = {}): BuiltinToolContext {
  const activeToolConversationId = Object.hasOwn(overrides, 'activeToolConversationId')
    ? overrides.activeToolConversationId
    : overrides.agent?.id ?? 'conv-test-1';
  const storage = createTestStorage();
  const llmProvider: ILLMProvider = {
    name: 'mock',
    chat: vi.fn().mockResolvedValue([]),
  };
  const tools: IToolRegistry = {
    registerTool: vi.fn(),
    getTool: vi.fn(),
    listTools: vi.fn().mockReturnValue([]),
  };
  const network: INetworkService = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  const questionWaits = new QuestionWaitBroker();
  vi.spyOn(questionWaits, 'waitForQuestionAnswer').mockImplementation(
    async (questionId, timeoutMs) => waitForQuestionAnswer(questionId, timeoutMs) as Promise<string>,
  );
  return {
    storage,
    llmProvider,
    tools,
    syncAdapters: [],
    network,
    localNodeId: 'test-node-new-tools',
    loopRegistry: new LoopRegistryImpl(),
    promptPlugins: new Map(),
    todoStore: new InMemoryTodoStateStore(),
    questionWaits,
    activeToolConversationId,
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════
//  LSP Tool — moved to memeloop-cli
// ══════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
//  WebSearch Tool — moved to memeloop-cli
// ══════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
//  WebFetch Tool — moved to memeloop-cli (Node-specific: needs fetch + HTML parsing)
// ══════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
//  TodoWrite Tool
// ══════════════════════════════════════════════════════════════════════════

describe('todoWriteImpl', () => {
  let ctx: BuiltinToolContext;

  beforeEach(() => {
    ctx = createMinimalContext({
      agent: { id: 'conv-test-1', messages: [] },
    });
  });

  it('returns error for invalid args', async () => {
    const r = await todoWriteImpl({ action: 'invalid' as never }, ctx);
    expect('error' in r && typeof r.error === 'string').toBe(true);
  });

  it('lists empty todos', async () => {
    const r = await todoWriteImpl({ action: 'list' }, ctx);
    expect(r).toEqual({ result: 'Todo list (0 items):\n\n(No todos)' });
  });

  it('creates a todo', async () => {
    const r = await todoWriteImpl(
      { action: 'create', content: 'Test todo item', priority: 'high' },
      ctx,
    );
    expect(r).toHaveProperty('result');
    const result = (r as { result: string }).result;
    expect(result).toContain('Test todo item');
    expect(result).toContain('high');
  });

  it('creates todo with default priority', async () => {
    const r = await todoWriteImpl({ action: 'create', content: 'Default prio' }, ctx);
    expect(r).toHaveProperty('result');
    expect((r as { result: string }).result).toContain('medium');
  });

  it('lists todos after creation', async () => {
    await todoWriteImpl({ action: 'create', content: 'Todo 1' }, ctx);
    const r = await todoWriteImpl({ action: 'list' }, ctx);
    expect((r as { result: string }).result).toContain('Todo 1');
    expect((r as { result: string }).result).toContain('1 items');
  });

  it('creates todo with custom id', async () => {
    const r = await todoWriteImpl(
      { action: 'create', id: 'my-id', content: 'Custom ID todo' },
      ctx,
    );
    expect(r).toHaveProperty('result');
    expect((r as { result: string }).result).toContain('my-id');
  });

  it('fails to create duplicate id', async () => {
    await todoWriteImpl({ action: 'create', id: 'dup-id', content: 'First' }, ctx);
    const r = await todoWriteImpl({ action: 'create', id: 'dup-id', content: 'Second' }, ctx);
    expect(r).toEqual({ error: "Todo with id 'dup-id' already exists. Use update action." });
  });

  it('updates todo status', async () => {
    await todoWriteImpl({ action: 'create', id: 't1', content: 'Update me' }, ctx);
    const r = await todoWriteImpl({ action: 'update', id: 't1', status: 'in_progress' }, ctx);
    expect(r).toHaveProperty('result');
    expect((r as { result: string }).result).toContain('in_progress');
  });

  it('completes a todo', async () => {
    await todoWriteImpl({ action: 'create', id: 't1', content: 'Complete me' }, ctx);
    const r = await todoWriteImpl({ action: 'complete', id: 't1' }, ctx);
    expect(r).toHaveProperty('result');
    // After complete, the item still exists with completed status
    const list = await todoWriteImpl({ action: 'list' }, ctx);
    expect((list as { result: string }).result).toContain('Complete me');
    expect((list as { result: string }).result).toContain('1 items');
  });

  it('removes a todo', async () => {
    await todoWriteImpl({ action: 'create', id: 't1', content: 'Remove me' }, ctx);
    const r = await todoWriteImpl({ action: 'remove', id: 't1' }, ctx);
    expect(r).toHaveProperty('result');
    const list = await todoWriteImpl({ action: 'list' }, ctx);
    expect((list as { result: string }).result).toContain('0 items');
  });

  it('removes completed/cancelled todos when no id provided', async () => {
    await todoWriteImpl({ action: 'create', id: 't1', content: 'Pending' }, ctx);
    await todoWriteImpl({ action: 'create', id: 't2', content: 'Completed' }, ctx);
    await todoWriteImpl({ action: 'complete', id: 't2' }, ctx);
    const r = await todoWriteImpl({ action: 'remove' }, ctx);
    expect(r).toHaveProperty('result');
    const list = await todoWriteImpl({ action: 'list' }, ctx);
    expect((list as { result: string }).result).toContain('1 items');
    expect((list as { result: string }).result).toContain('Pending');
  });

  it('updates todo content', async () => {
    await todoWriteImpl({ action: 'create', id: 't1', content: 'Original' }, ctx);
    const r = await todoWriteImpl({ action: 'update', id: 't1', content: 'Updated' }, ctx);
    expect((r as { result: string }).result).toContain('Updated');
  });

  it('returns error for update without id', async () => {
    const r = await todoWriteImpl({ action: 'update', content: 'No id' }, ctx);
    expect(r).toEqual({ error: 'id is required for update action' });
  });

  it('returns error for update of non-existent todo', async () => {
    const r = await todoWriteImpl(
      { action: 'update', id: 'nonexistent', status: 'completed' },
      ctx,
    );
    expect(r).toEqual({ error: "Todo with id 'nonexistent' not found" });
  });

  it('returns error for complete without id', async () => {
    const r = await todoWriteImpl({ action: 'complete' }, ctx);
    expect(r).toEqual({ error: 'id is required for complete action' });
  });

  it('returns error for complete of non-existent todo', async () => {
    const r = await todoWriteImpl({ action: 'complete', id: 'nonexistent' }, ctx);
    expect(r).toEqual({ error: "Todo with id 'nonexistent' not found" });
  });

  it('remove non-existent todo returns not-found message', async () => {
    const r = await todoWriteImpl({ action: 'remove', id: 'nonexistent' }, ctx);
    expect((r as { result: string }).result).toContain('not found');
  });

  it('uses activeToolConversationId when agent.id is absent', async () => {
    const ctxNoAgent = createMinimalContext({ activeToolConversationId: 'tool-conv-1' });
    const r = await todoWriteImpl({ action: 'create', content: 'Agent-less todo' }, ctxNoAgent);
    expect(r).toHaveProperty('result');
    expect((r as { result: string }).result).toContain('Agent-less todo');
  });

  it('different conversations have separate todo lists', async () => {
    const ctxA = createMinimalContext({ agent: { id: 'conv-a', messages: [] } });
    const ctxB = createMinimalContext({ agent: { id: 'conv-b', messages: [] } });

    await todoWriteImpl({ action: 'create', content: 'Todo A' }, ctxA);
    await todoWriteImpl({ action: 'create', content: 'Todo B' }, ctxB);

    const listA = await todoWriteImpl({ action: 'list' }, ctxA);
    const listB = await todoWriteImpl({ action: 'list' }, ctxB);

    expect((listA as { result: string }).result).toContain('Todo A');
    expect((listA as { result: string }).result).not.toContain('Todo B');
    expect((listB as { result: string }).result).toContain('Todo B');
    expect((listB as { result: string }).result).not.toContain('Todo A');
  });

  it('fails closed when no explicit conversation identity is available', async () => {
    const context = createMinimalContext({
      agent: undefined,
      activeToolConversationId: undefined,
    });
    await expect(todoWriteImpl({ action: 'create', content: 'must not persist' }, context))
      .resolves.toEqual({ error: 'todoWrite requires an explicit conversation id' });
  });

  it('recovers persisted state through a new host store instance', async () => {
    const persisted = new Map<string, TodoItem[]>();
    const createPersistentStore = (): TodoStateStore => ({
      async transact<T>(
        conversationId: string,
        operation: (
          todos: Map<string, TodoItem>,
        ) => T | Promise<T>,
      ): Promise<T> {
        const todos = new Map(
          (persisted.get(conversationId) ?? []).map(item => [item.id, structuredClone(item)]),
        );
        const result = await operation(todos);
        persisted.set(conversationId, [...todos.values()].map(item => structuredClone(item)));
        return result;
      },
    });
    const beforeRestart = createMinimalContext({
      activeToolConversationId: 'durable-conversation',
      agent: undefined,
      todoStore: createPersistentStore(),
    });
    await todoWriteImpl({ action: 'create', id: 'durable-1', content: 'Survive restart' }, beforeRestart);

    const afterRestart = createMinimalContext({
      activeToolConversationId: 'durable-conversation',
      agent: undefined,
      todoStore: createPersistentStore(),
    });
    const recovered = await todoWriteImpl({ action: 'list' }, afterRestart);
    expect((recovered as { result: string }).result).toContain('Survive restart');
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  AskUserQuestion Tool
// ══════════════════════════════════════════════════════════════════════════

describe('askUserQuestionImpl', () => {
  beforeEach(() => {
    waitForQuestionAnswer.mockReset();
  });

  it('returns error for invalid args', async () => {
    const ctx = createMinimalContext();
    const r = await askUserQuestionImpl({}, ctx);
    expect('error' in r && typeof r.error === 'string').toBe(true);
    expect((r as { error: string }).error).toContain('invalid_askUserQuestion_args');
  });

  it('requires question field', async () => {
    const ctx = createMinimalContext();
    const r = await askUserQuestionImpl({ question: '' }, ctx);
    expect('error' in r && typeof r.error === 'string').toBe(true);
  });

  it('notifies and returns answer', async () => {
    waitForQuestionAnswer.mockResolvedValueOnce('yes, proceed');
    const notifyAskQuestion = vi.fn();
    const ctx = createMinimalContext({
      notifyAskQuestion,
      agent: { id: 'conv-1', messages: [] },
    });

    const r = await askUserQuestionImpl({ question: 'Should I continue?' }, ctx);

    expect(notifyAskQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        questionId: 'mock-uuid-123',
        question: 'Should I continue?',
        conversationId: 'conv-1',
        inputType: 'text',
      }),
    );
    expect(waitForQuestionAnswer).toHaveBeenCalledWith('mock-uuid-123', 300_000);
    expect(r).toEqual({ result: 'yes, proceed' });
  });

  it('supports single-select input type with options', async () => {
    waitForQuestionAnswer.mockResolvedValueOnce('opt-a');
    const notifyAskQuestion = vi.fn();
    const ctx = createMinimalContext({ notifyAskQuestion });

    const r = await askUserQuestionImpl(
      {
        question: 'Pick one',
        inputType: 'single-select',
        options: [
          { label: 'Option A', description: 'First option' },
          { label: 'Option B', description: 'Second option' },
        ],
        allowFreeform: false,
      },
      ctx,
    );

    expect(notifyAskQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        inputType: 'single-select',
        options: expect.arrayContaining([expect.objectContaining({ label: 'Option A' })]),
        allowFreeform: false,
      }),
    );
    expect(r).toEqual({ result: 'opt-a' });
  });

  it('returns error on timeout', async () => {
    waitForQuestionAnswer.mockRejectedValueOnce(new Error('askQuestion_timeout'));
    const ctx = createMinimalContext({ notifyAskQuestion: vi.fn() });

    const r = await askUserQuestionImpl({ question: 'Q?', timeoutMs: 1000 }, ctx);

    expect(waitForQuestionAnswer).toHaveBeenCalledWith('mock-uuid-123', 1000);
    expect(r).toEqual({ error: 'askQuestion_timeout' });
  });

  it('uses activeToolConversationId when agent is absent', async () => {
    waitForQuestionAnswer.mockResolvedValueOnce('ok');
    const notifyAskQuestion = vi.fn();
    const ctx = createMinimalContext({
      notifyAskQuestion,
      activeToolConversationId: 'tool-conv-2',
    });

    await askUserQuestionImpl({ question: 'Test' }, ctx);

    expect(notifyAskQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'tool-conv-2' }),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Registration tests
// ══════════════════════════════════════════════════════════════════════════

describe('registerBuiltinTools — new tools', () => {
  it('registers all new framework-level tools', () => {
    const registry: IToolRegistry = {
      registerTool: vi.fn(),
      getTool: vi.fn(),
      listTools: vi.fn().mockReturnValue([]),
    };
    const context = createMinimalContext();
    registerBuiltinTools(registry, context);

    const registerMock = vi.mocked(registry.registerTool);
    const toolIds = registerMock.mock.calls.map(([id]) => id);

    expect(toolIds).toContain(TODO_WRITE_TOOL_ID);
    expect(toolIds).toContain(ASK_USER_QUESTION_TOOL_ID);
  });

  it('registered tools are callable functions', () => {
    const registry: IToolRegistry = {
      registerTool: vi.fn(),
      getTool: vi.fn(),
      listTools: vi.fn().mockReturnValue([]),
    };
    const context = createMinimalContext();
    registerBuiltinTools(registry, context);

    const registerMock = vi.mocked(registry.registerTool);
    const calls = registerMock.mock.calls;

    for (const [, fn] of calls) {
      expect(typeof fn).toBe('function');
    }
  });
});
