import { describe, expect, it, vi } from 'vitest';

import { createTestStorage } from '../../__tests__/testStorage.js';
import { type AgentDefinition } from '../../agent/types.js';
import type { ChatMessage, ConversationCompactionEvent } from '../../conversation/index.js';
import { ProviderRegistry } from '../../llm/providerRegistry.js';
import type { PortableLlmRequest } from '../../llm/request.js';
import type { CompactionCandidatePage, ConversationReadCallOptions, GetCompactionCandidatePageOptions } from '../../storage/ports.js';
import type { AgentFrameworkContext, ILLMProvider } from '../../types.js';
import { loadAgentExecutionModelContext, prepareAgentExecutionModelRequest } from '../agent-tool-loop/executionModelContext.js';

const CONVERSATION_ID = 'execution-context-conversation';

function message(sequence: number, role: ChatMessage['role']): ChatMessage {
  const turnSequence = role === 'user' ? sequence : sequence - 1;
  return {
    messageId: `message-${sequence}`,
    turnId: `message-${turnSequence}`,
    conversationId: CONVERSATION_ID,
    originNodeId: 'node-source',
    originSequence: sequence,
    timestamp: sequence,
    lamportClock: sequence,
    role,
    content: `content-${sequence}`,
  };
}

function definition(): AgentDefinition {
  return {
    id: 'definition-exact',
    name: 'Exact route',
    description: '',
    systemPrompt: 'Continue exactly.',
    tools: [],
    modelConfig: { providerId: 'provider-exact', modelId: 'logical-exact' },
    version: '1',
  };
}

function contextFixture(messageCount = 6) {
  const source = Array.from(
    { length: messageCount },
    (_, index) => message(index + 1, index % 2 === 0 ? 'user' : 'assistant'),
  );
  const agentDefinition = definition();
  const storage = createTestStorage({
    messages: [...source],
    conversations: new Map([[CONVERSATION_ID, {
      conversationId: CONVERSATION_ID,
      title: '',
      lastMessagePreview: source.at(-1)!.content,
      lastMessageTimestamp: 6,
      messageCount: source.length,
      originNodeId: 'node-source',
      originClock: 6,
      definitionId: agentDefinition.id,
      isUserInitiated: true,
    }]]),
  }, {
    getAgentDefinition: vi.fn(async id => id === agentDefinition.id ? agentDefinition : null),
  });
  storage.getCompactionCandidatePage = vi.fn(async (
    _conversationId: string,
    options: GetCompactionCandidatePageOptions,
    callOptions?: ConversationReadCallOptions,
  ): Promise<CompactionCandidatePage> => {
    callOptions?.signal?.throwIfAborted();
    const covered = options.afterCoveredVersion['node-source'] ?? 0;
    const before = options.beforeDisplayCursor?.timestamp ?? Number.POSITIVE_INFINITY;
    const eligible = source.filter(item => item.originSequence > covered && item.timestamp < before);
    const messages = eligible.slice(0, options.maxMessages);
    const last = messages.at(-1);
    const newlyCoveredMessageCountByOrigin: Record<string, number> = last
      ? { 'node-source': messages.length }
      : {};
    const newlyCoveredUserTurnCountByOrigin: Record<string, number> = last
      ? { 'node-source': messages.filter(item => item.role === 'user').length }
      : {};
    return {
      messages,
      nextCoveredVersion: last ? { 'node-source': last.originSequence } : { ...options.afterCoveredVersion },
      newlyCoveredMessageCountByOrigin,
      newlyCoveredUserTurnCountByOrigin,
      hasMore: eligible.length > messages.length,
    };
  });
  storage.getRetainedCompactionControls = vi.fn(async (
    _conversationId: string,
    _options: unknown,
    callOptions?: { signal?: AbortSignal },
  ) => {
    callOptions?.signal?.throwIfAborted();
    return {
      items: storage.state.events.filter(
        (event): event is ConversationCompactionEvent => event.kind === 'compaction',
      ),
      hasMore: false,
      invalidated: false,
    };
  });

  const chat = vi.fn(async function*(request: PortableLlmRequest) {
    expect(request.providerId).toBe('provider-exact');
    expect(request.logicalModelId).toBe('logical-exact');
    expect(request.wireModelId).toBe('wire-exact');
    expect(request.apiMode).toBe('responses');
    yield { type: 'text-delta' as const, id: 'summary', text: 'persistent exact route summary' };
    yield { type: 'finish' as const, finishReason: 'stop' };
  });
  const provider: ILLMProvider = { name: 'provider-exact', chat };
  const registry = new ProviderRegistry();
  registry.register({ ownerId: 'test', kind: 'host' }, provider, {
    models: [{ modelId: 'logical-exact', wireModelId: 'wire-exact', apiMode: 'responses' }],
  });
  const context = {
    storage,
    llmProvider: provider,
    modelProviderRegistry: registry,
    localNodeId: 'node-local',
    tools: {},
    syncAdapters: [],
    network: { start: vi.fn(), stop: vi.fn() },
  } as unknown as AgentFrameworkContext;
  return { context, storage, chat };
}

describe('loadAgentExecutionModelContext', () => {
  it('uses one frozen route and reuses durable compaction across repeated loads', async () => {
    const { context, storage, chat } = contextFixture();
    const signal = new AbortController().signal;
    const first = await loadAgentExecutionModelContext(context, {
      conversationId: CONVERSATION_ID,
      signal,
      recentTurnsToKeep: 1,
    });
    const second = await loadAgentExecutionModelContext(context, {
      conversationId: CONVERSATION_ID,
      signal,
      recentTurnsToKeep: 1,
    });

    expect(first.route).toMatchObject({
      providerId: 'provider-exact',
      modelId: 'logical-exact',
      wireModelId: 'wire-exact',
      apiMode: 'responses',
    });
    expect(first.messages.map(item => item.content)).toEqual([
      'persistent exact route summary',
      'content-5',
      'content-6',
    ]);
    expect(second.messages.map(item => item.content)).toEqual(first.messages.map(item => item.content));
    expect(chat).toHaveBeenCalledTimes(1);
    expect(storage.state.events.filter(event => event.kind === 'compaction')).toHaveLength(1);
  });

  it('honors cancellation before definition, route, or history work', async () => {
    const { context, chat } = contextFixture();
    const abortController = new AbortController();
    abortController.abort(new Error('closed'));

    await expect(loadAgentExecutionModelContext(context, {
      conversationId: CONVERSATION_ID,
      signal: abortController.signal,
    })).rejects.toThrow('closed');
    expect(chat).not.toHaveBeenCalled();
  });

  it('forwards pending progress to the host and permits a later bounded background slice', async () => {
    const { context, storage, chat } = contextFixture(300);
    const continuation = vi.fn();
    const signal = new AbortController().signal;

    await expect(loadAgentExecutionModelContext(context, {
      conversationId: CONVERSATION_ID,
      signal,
      recentTurnsToKeep: 1,
      onCompactionContinuationNeeded: continuation,
    })).rejects.toMatchObject({
      code: 'CONTEXT_COMPACTION_PENDING',
      progress: { processedMessages: 200, providerCalls: 4 },
    });
    await Promise.resolve();
    expect(continuation).toHaveBeenCalledOnce();
    expect(storage.state.events.filter(event => event.kind === 'compaction')).toHaveLength(4);

    const resumed = await loadAgentExecutionModelContext(context, {
      conversationId: CONVERSATION_ID,
      signal,
      recentTurnsToKeep: 1,
      workMode: 'background',
      workBudget: { maxProviderCalls: 8, maxWorkPages: 10 },
    });

    expect(resumed.messages.at(-1)?.messageId).toBe('message-300');
    expect(chat).toHaveBeenCalledTimes(6);
    expect(storage.state.events.filter(event => event.kind === 'compaction')).toHaveLength(6);
  });

  it('prepares preview input with the same loaded route and runtime view', async () => {
    const { context } = contextFixture();
    const agentDefinition = definition();
    const resolveAgentRuntimeView = vi.fn(async (_conversationId: string, messages: ChatMessage[]) => ({
      ...agentDefinition,
      id: CONVERSATION_ID,
      agentDefId: agentDefinition.id,
      messages,
      status: { state: 'working' as const },
      created: new Date(0),
    }));
    context.resolveAgentRuntimeView = resolveAgentRuntimeView;

    const result = await prepareAgentExecutionModelRequest(context, {
      conversationId: CONVERSATION_ID,
      signal: new AbortController().signal,
      recentTurnsToKeep: 1,
      stream: true,
      inputText: 'preview input',
    });

    expect(resolveAgentRuntimeView).toHaveBeenCalledWith(CONVERSATION_ID, result.messages);
    expect(result.prepared.route).toBe(result.route);
    expect(result.prepared.request).toMatchObject({
      providerId: 'provider-exact',
      logicalModelId: 'logical-exact',
      wireModelId: 'wire-exact',
      stream: true,
    });
    expect(result.prepared.request.messages.at(-1)).toEqual({
      role: 'user',
      content: 'preview input',
    });
  });
});
