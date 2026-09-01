import { describe, expect, it, vi } from 'vitest';

import type { ConversationMessageEvent, ConversationTombstoneEvent } from '../../conversation/index.js';
import { AgentRunFailure, createMissingApiKeyAgentRunError } from '../../runState.js';
import { AgentSessionController } from '../AgentSessionController.js';
import {
  AGENT_SESSION_CONTRACT_LIMITS,
  type AgentConversationDeleteTurnRequest,
  type AgentConversationRetryTurnRequest,
  type AgentConversationTurnDetailRequest,
} from '../conversationCommands.js';
import type {
  AgentAttachmentInput,
  AgentConversationClient,
  AgentConversationMessagePageOptions,
  AgentConversationMessagePageSuccess,
  AgentConversationMessageProjection,
  AgentConversationMessageWindowRequest,
  AgentConversationUpdate,
  AgentInstanceClient,
  AgentManagementCallOptions,
  AgentRuntimeView,
  WikiTiddlerAttachment,
} from '../types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  return { promise, resolve, reject };
}

function agent(id: string): AgentRuntimeView {
  return {
    id,
    name: `Agent ${id}`,
    agentDefId: `definition-${id}`,
    status: { state: 'idle' },
    created: new Date(0),
    closed: false,
    volatile: false,
    preview: false,
  };
}

function message(conversationId: string, sequence: number): AgentConversationMessageProjection {
  const messageId = `${conversationId}-message-${sequence}`;
  const role = sequence % 2 === 0 ? 'assistant' : 'user';
  return {
    messageId,
    turnId: role === 'user' ? messageId : `${conversationId}-turn-${sequence}`,
    conversationId,
    originNodeId: `node-${conversationId}`,
    originSequence: sequence,
    timestamp: sequence,
    lamportClock: sequence,
    role,
    content: `${conversationId} message ${sequence}`,
  };
}

function page(
  items: AgentConversationMessageProjection[],
  hasMoreBefore = false,
  hasMoreAfter = false,
  conversationId = items[0]?.conversationId ?? 'empty-conversation',
  revision = `revision-${conversationId}`,
): AgentConversationMessagePageSuccess {
  return {
    reset: false,
    conversationId,
    revision,
    items,
    hasMoreBefore,
    hasMoreAfter,
    ...(hasMoreBefore ? { previousCursor: `previous-${items[0]?.messageId}` } : {}),
    ...(hasMoreAfter ? { nextCursor: `next-${items.at(-1)?.messageId}` } : {}),
  };
}

function target(agentId: string, conversationId = agentId) {
  return { agentId, conversationId };
}

function projectionUpdate(
  value: AgentConversationMessageProjection,
  revision = `revision-${value.conversationId}`,
): Extract<AgentConversationUpdate, { kind: 'projection' }> {
  return {
    kind: 'projection',
    conversationId: value.conversationId,
    revision,
    streaming: false,
    message: value,
  };
}

function instanceClient(
  overrides: Partial<AgentInstanceClient> = {},
): AgentInstanceClient {
  return {
    createAgent: async id => ({ id }),
    fetchAgent: async id => agent(id),
    updateAgent: async id => agent(id),
    cancelAgent: async () => {},
    deleteAgent: async () => {},
    subscribeToUpdates: () => () => {},
    getAgentFrameworkId: async () => 'framework',
    getFrameworkConfigSchema: async () => ({}),
    ...overrides,
  };
}

function tombstone(request: AgentConversationDeleteTurnRequest): ConversationTombstoneEvent {
  return {
    eventId: `tombstone-${request.requestId}`,
    conversationId: request.conversationId,
    originNodeId: 'node-local',
    originSequence: 1,
    lamportClock: 1,
    timestamp: 1,
    kind: 'tombstone',
    targetTurnId: request.turnId,
    ...(request.reason === undefined ? {} : { reason: request.reason }),
  };
}

function userEvent(request: AgentConversationRetryTurnRequest): ConversationMessageEvent {
  return {
    eventId: request.newTurnId,
    conversationId: request.conversationId,
    originNodeId: 'node-local',
    originSequence: 2,
    lamportClock: 2,
    timestamp: 2,
    kind: 'message',
    message: {
      messageId: request.newTurnId,
      turnId: request.newTurnId,
      role: 'user',
      content: 'durable original user content',
    },
  };
}

function conversationClient(
  overrides: Partial<AgentConversationClient> = {},
): AgentConversationClient {
  return {
    getMessagePage: async conversationId => page([], false, false, conversationId),
    getMessageWindowAround: async () => {
      throw new Error('not implemented in fixture');
    },
    getTurnDetail: async request => ({
      turnId: request.turnId,
      items: [],
      hasMoreBefore: false,
      hasMoreAfter: false,
    }),
    sendMessage: async () => {},
    subscribeToMessages: () => () => {},
    deleteTurn: async request => ({
      ok: true,
      conversationId: request.conversationId,
      turnId: request.turnId,
      requestId: request.requestId,
      tombstone: tombstone(request),
    }),
    retryTurn: async request => ({
      ok: true,
      runId: `run-${request.requestId}`,
      conversationId: request.conversationId,
      turnId: request.newTurnId,
      requestId: request.requestId,
      state: 'accepted',
      tombstone: tombstone(request),
      userEvent: userEvent(request),
    }),
    ...overrides,
  };
}

describe('AgentSessionController generation safety', () => {
  it('uses subscriptions without silently polling by default', async () => {
    vi.useFakeTimers();
    try {
      const fetchAgent = vi.fn(async id => agent(id));
      const controller = new AgentSessionController({
        agentInstanceClient: instanceClient({ fetchAgent }),
        conversationClient: conversationClient(),
      });

      await controller.start(target('subscription-only'));
      expect(fetchAgent).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchAgent).toHaveBeenCalledTimes(1);
      controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls only when explicitly requested and stops an in-flight poll', async () => {
    vi.useFakeTimers();
    try {
      let pollingSignal: AbortSignal | undefined;
      const pendingPoll = deferred<AgentRuntimeView>();
      const fetchAgent = vi.fn()
        .mockResolvedValueOnce(agent('polling'))
        .mockImplementationOnce(async (_id: string, options?: AgentManagementCallOptions) => {
          pollingSignal = options?.signal;
          return pendingPoll.promise;
        });
      const controller = new AgentSessionController({
        agentInstanceClient: instanceClient({ fetchAgent }),
        conversationClient: conversationClient(),
        pollInterval: 10,
      });

      await controller.start(target('polling'));
      await vi.advanceTimersByTimeAsync(10);
      expect(fetchAgent).toHaveBeenCalledTimes(2);
      expect(pollingSignal?.aborted).toBe(false);
      controller.stop();
      expect(pollingSignal?.aborted).toBe(true);
      pendingPoll.resolve(agent('polling'));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
      expect(fetchAgent).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an unsafe explicit polling interval', () => {
    expect(() =>
      new AgentSessionController({
        agentInstanceClient: instanceClient(),
        conversationClient: conversationClient(),
        pollInterval: 0,
      })
    ).toThrow('invalid_poll_interval');
  });

  it('never aliases the runtime agent ID to a different durable conversation ID', async () => {
    const fetchAgent = vi.fn(async id => agent(id));
    const subscribeToUpdates = vi.fn(() => () => {});
    const getMessagePage = vi.fn(async conversationId => page([message(conversationId, 1)]));
    const subscribeToMessages = vi.fn(() => () => {});
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient({ fetchAgent, subscribeToUpdates }),
      conversationClient: conversationClient({ getMessagePage, subscribeToMessages }),
    });

    await controller.start(target('runtime-agent-7', 'conversation-42'));

    expect(fetchAgent).toHaveBeenCalledWith('runtime-agent-7', {
      signal: expect.any(AbortSignal),
    });
    expect(subscribeToUpdates).toHaveBeenCalledWith(
      'runtime-agent-7',
      expect.any(Function),
    );
    expect(getMessagePage.mock.calls[0]?.[0]).toBe('conversation-42');
    expect(subscribeToMessages).toHaveBeenCalledWith(
      'conversation-42',
      expect.any(Function),
    );
    expect(controller.getSnapshot().agent?.id).toBe('runtime-agent-7');
    expect(controller.getSnapshot().messages[0]?.conversationId).toBe('conversation-42');
    controller.stop();
  });

  it('lets B win when A ignores abort and resolves later, with one live subscription', async () => {
    const fetches = new Map(['A', 'B'].map(id => [id, deferred<AgentRuntimeView>()]));
    const pages = new Map(['A', 'B'].map(id => [id, deferred<AgentConversationMessagePageSuccess>()]));
    const fetchSignals = new Map<string, AbortSignal>();
    const pageSignals = new Map<string, AbortSignal>();
    const agentSubscriptions = new Map<string, Set<(update: Partial<AgentRuntimeView>) => void>>();
    const messageSubscriptions = new Map<string, Set<(value: AgentConversationUpdate) => void>>();
    const subscribeAgent = vi.fn((id: string, listener: (update: Partial<AgentRuntimeView>) => void) => {
      const listeners = agentSubscriptions.get(id) ?? new Set();
      listeners.add(listener);
      agentSubscriptions.set(id, listeners);
      return () => listeners.delete(listener);
    });
    const subscribeMessage = vi.fn((id: string, listener: (value: AgentConversationUpdate) => void) => {
      const listeners = messageSubscriptions.get(id) ?? new Set();
      listeners.add(listener);
      messageSubscriptions.set(id, listeners);
      return () => listeners.delete(listener);
    });
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient({
        fetchAgent: async (id, options) => {
          fetchSignals.set(id, options!.signal!);
          return fetches.get(id)!.promise;
        },
        subscribeToUpdates: subscribeAgent,
      }),
      conversationClient: conversationClient({
        getMessagePage: async (id, _options, callOptions) => {
          pageSignals.set(id, callOptions!.signal!);
          return pages.get(id)!.promise;
        },
        subscribeToMessages: subscribeMessage,
      }),
    });

    const startA = controller.start(target('A'));
    const startB = controller.start(target('B'));
    expect(fetchSignals.get('A')?.aborted).toBe(true);
    expect(pageSignals.get('A')?.aborted).toBe(true);

    fetches.get('B')!.resolve(agent('B'));
    pages.get('B')!.resolve(page([message('B', 1)]));
    await startB;
    fetches.get('A')!.resolve(agent('A'));
    pages.get('A')!.resolve(page([message('A', 1)]));
    await startA;

    expect(controller.getSnapshot().agent?.id).toBe('B');
    expect(controller.getSnapshot().messages.map(item => item.conversationId)).toEqual(['B']);
    expect(agentSubscriptions.get('A')?.size ?? 0).toBe(0);
    expect(messageSubscriptions.get('A')?.size ?? 0).toBe(0);
    expect(agentSubscriptions.get('B')?.size).toBe(1);
    expect(messageSubscriptions.get('B')?.size).toBe(1);

    await controller.start(target('B'));
    expect(agentSubscriptions.get('B')?.size).toBe(1);
    expect(messageSubscriptions.get('B')?.size).toBe(1);
    controller.stop();
  });

  it('fences saved callbacks and a pending page after switching conversations', async () => {
    let staleAgentListener: ((update: Partial<AgentRuntimeView>) => void) | undefined;
    let staleMessageListener: ((value: AgentConversationUpdate) => void) | undefined;
    const pendingOlder = deferred<AgentConversationMessagePageSuccess>();
    const getMessagePage = vi.fn(async (id: string, options: AgentConversationMessagePageOptions) => {
      if (id === 'A' && options.cursor) return pendingOlder.promise;
      return id === 'A'
        ? page([message('A', 2)], true, false)
        : page([message('B', 1)], false, false);
    });
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient({
        subscribeToUpdates: (id, listener) => {
          if (id === 'A') staleAgentListener = listener;
          return () => {};
        },
      }),
      conversationClient: conversationClient({
        getMessagePage,
        subscribeToMessages: (id, listener) => {
          if (id === 'A') staleMessageListener = listener;
          return () => {};
        },
      }),
    });

    await controller.start(target('A'));
    const loadOlder = controller.loadMoreBefore();
    await controller.start(target('B'));
    staleAgentListener?.({ name: 'stale A' });
    staleMessageListener?.(projectionUpdate(message('A', 3)));
    pendingOlder.resolve(page([message('A', 1)], false, true));
    await loadOlder;

    expect(controller.getSnapshot().agent?.id).toBe('B');
    expect(controller.getSnapshot().agent?.name).not.toBe('stale A');
    expect(controller.getSnapshot().messages.map(item => item.conversationId)).toEqual(['B']);
    controller.stop();
  });

  it('aborts pending start on stop and ignores its late completion', async () => {
    const pendingAgent = deferred<AgentRuntimeView>();
    const pendingPage = deferred<AgentConversationMessagePageSuccess>();
    let signal: AbortSignal | undefined;
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient({
        fetchAgent: async (_id, options) => {
          signal = options?.signal;
          return pendingAgent.promise;
        },
      }),
      conversationClient: conversationClient({
        getMessagePage: async () => pendingPage.promise,
      }),
    });

    const starting = controller.start(target('A'));
    controller.stop();
    expect(signal?.aborted).toBe(true);
    pendingAgent.resolve(agent('A'));
    pendingPage.resolve(page([message('A', 1)]));
    await starting;
    expect(controller.getSnapshot()).toMatchObject({ agent: null, loading: false, messages: [] });
  });

  it('subscribes first and merges/deduplicates messages delivered during the snapshot read', async () => {
    const pendingPage = deferred<AgentConversationMessagePageSuccess>();
    const order: string[] = [];
    let liveListener: ((value: AgentConversationUpdate) => void) | undefined;
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        subscribeToMessages: (_id, listener) => {
          order.push('subscribe');
          liveListener = listener;
          return () => {};
        },
        getMessagePage: async () => {
          order.push('page');
          return pendingPage.promise;
        },
      }),
    });

    const starting = controller.start(target('race'));
    expect(order).toEqual(['subscribe', 'page']);
    liveListener?.(projectionUpdate({ ...message('race', 3), content: 'live projection wins' }));
    pendingPage.resolve(page([message('race', 1), message('race', 2), message('race', 3)]));
    await starting;

    expect(controller.getSnapshot().orderedMessageIds).toEqual([
      'race-message-1',
      'race-message-2',
      'race-message-3',
    ]);
    expect(controller.getSnapshot().messages.at(-1)?.content).toBe('live projection wins');
    controller.stop();
  });

  it('keeps the subscribe-first race buffer within the resident budget', async () => {
    const pendingPage = deferred<AgentConversationMessagePageSuccess>();
    let liveListener: ((value: AgentConversationUpdate) => void) | undefined;
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        getMessagePage: async () => pendingPage.promise,
        subscribeToMessages: (_id, listener) => {
          liveListener = listener;
          return () => {};
        },
      }),
      maxResidentMessages: 3,
    });

    const starting = controller.start(target('buffered'));
    for (let sequence = 1; sequence <= 10; sequence += 1) {
      liveListener?.(projectionUpdate(message('buffered', sequence)));
    }
    pendingPage.resolve(page([message('buffered', 8), message('buffered', 9)]));
    await starting;

    expect(controller.getSnapshot().messages.map(item => item.originSequence)).toEqual([8, 9, 10]);
    expect(controller.getSnapshot().hasMoreBefore).toBe(true);
    controller.stop();
  });

  it('does not emit a stale initial page after a subscribe-first invalidation', async () => {
    const initial = deferred<AgentConversationMessagePageSuccess>();
    let updateListener: ((update: AgentConversationUpdate) => void) | undefined;
    const getMessagePage = vi.fn()
      .mockImplementationOnce(async () => initial.promise)
      .mockResolvedValueOnce(page(
        [message('initial-reset', 2)],
        false,
        false,
        'initial-reset',
        'revision-2',
      ));
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        getMessagePage,
        subscribeToMessages: (_conversationId, listener) => {
          updateListener = listener;
          return () => {};
        },
      }),
    });
    const observed: number[][] = [];
    controller.subscribe(snapshot => {
      if (!snapshot.loading) observed.push(snapshot.messages.map(item => item.originSequence));
    });
    const starting = controller.start(target('initial-reset'));
    updateListener?.({
      kind: 'invalidated',
      conversationId: 'initial-reset',
      previousRevision: 'revision-1',
      revision: 'revision-2',
      reason: 'tombstone',
    });
    initial.resolve(page(
      [message('initial-reset', 1)],
      false,
      false,
      'initial-reset',
      'revision-1',
    ));
    await starting;

    expect(observed).not.toContainEqual([1]);
    expect(controller.getSnapshot().messages.map(item => item.originSequence)).toEqual([2]);
    controller.stop();
  });

  it('rejects an in-flight mutation as interrupted after a generation switch', async () => {
    const pendingSend = deferred<undefined>();
    const sendMessage = vi.fn(async (_conversationId: string) => pendingSend.promise);
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({ sendMessage }),
    });
    await controller.start(target('agent-A', 'conversation-A'));

    const sending = controller.sendMessage('do not report stale success');
    await controller.start(target('agent-B', 'conversation-B'));
    pendingSend.resolve(undefined);

    await expect(sending).rejects.toMatchObject({
      name: 'AgentRunFailure',
      agentRunError: { code: 'INTERRUPTED' },
    });
    expect(sendMessage.mock.calls[0]?.[0]).toBe('conversation-A');
    expect(controller.getSnapshot().agent?.id).toBe('agent-B');
    expect(controller.getSnapshot().error).toBeNull();
    controller.stop();
  });
});

describe('AgentSessionController bounded paging', () => {
  it('requests the interactive defaults at 50 projections and 256 KiB', async () => {
    const getMessagePage = vi.fn(async (conversationId: string) => page([], false, false, conversationId));
    const getTurnDetail = vi.fn(async (request: AgentConversationTurnDetailRequest) => ({
      turnId: request.turnId,
      items: [],
      hasMoreBefore: false,
      hasMoreAfter: false,
    }));
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({ getMessagePage, getTurnDetail }),
    });
    await controller.start(target('interactive-defaults'));
    expect(getMessagePage).toHaveBeenCalledWith(
      'interactive-defaults',
      expect.objectContaining({ limit: 50, maxBytes: 256 * 1024 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await controller.getTurnDetail({
      turnId: 'turn-1',
      limit: 80,
      maxBytes: 4 * 1024 * 1024,
    });
    expect(getTurnDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'interactive-defaults',
        turnId: 'turn-1',
        limit: 50,
        maxBytes: 256 * 1024,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    controller.stop();
  });

  it('opens a logical 100k conversation without any full-history reader', async () => {
    const totalMessages = 100_000;
    const getMessagePage = vi.fn(async (
      conversationId: string,
      options: AgentConversationMessagePageOptions,
    ) => {
      const start = totalMessages - options.limit + 1;
      return page(
        Array.from({ length: options.limit }, (_, index) => message(conversationId, start + index)),
        true,
        false,
      );
    });
    const client = conversationClient({ getMessagePage });
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: client,
    });

    await controller.start(target('huge'));
    expect('getMessages' in client).toBe(false);
    expect(getMessagePage).toHaveBeenCalledWith(
      'huge',
      {
        limit: 50,
        direction: 'backward',
        maxBytes: 256 * 1024,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(controller.getSnapshot().messages).toHaveLength(50);
    expect(controller.getSnapshot().messages[0]?.originSequence).toBe(99_951);
    controller.stop();
  });

  it('opens and seeks within a logical million-message conversation using only bounded pages', async () => {
    const conversationId = 'million-message-conversation';
    const totalMessages = 1_000_000;
    const targetSequence = 500_001;
    const targetTurnId = `${conversationId}-message-${targetSequence}`;
    const getMessagePage = vi.fn(async (
      id: string,
      options: AgentConversationMessagePageOptions,
    ) => {
      const start = totalMessages - options.limit + 1;
      return page(
        Array.from({ length: options.limit }, (_, index) => message(id, start + index)),
        true,
        false,
        id,
        'revision-million',
      );
    });
    const getMessageWindowAround = vi.fn(async (
      request: AgentConversationMessageWindowRequest,
    ) => {
      const start = targetSequence - 24;
      const items = Array.from(
        { length: request.maxMessages },
        (_, index) => message(request.conversationId, start + index),
      );
      return {
        reset: false as const,
        conversationId: request.conversationId,
        revision: request.expectedRevision,
        focus: { kind: 'message' as const, messageId: targetTurnId, turnId: targetTurnId },
        recenterAnchor: { messageId: targetTurnId, turnId: targetTurnId },
        items,
        hasMoreBefore: true,
        hasMoreAfter: true,
        previousCursor: `before-${targetSequence}`,
        nextCursor: `after-${targetSequence}`,
      };
    });
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({ getMessagePage, getMessageWindowAround }),
    });

    await controller.start(target(conversationId));
    await controller.seekToMessage(targetTurnId, targetTurnId, undefined, {
      expectedRevision: 'revision-million',
    });

    expect(getMessagePage).toHaveBeenCalledTimes(1);
    expect(getMessageWindowAround).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId,
        focus: { kind: 'message', messageId: targetTurnId, turnId: targetTurnId },
        expectedRevision: 'revision-million',
        maxMessages: 50,
        maxBytes: 256 * 1024,
      }),
      { signal: expect.any(AbortSignal) },
    );
    expect(controller.getSnapshot().messages).toHaveLength(50);
    expect(controller.getSnapshot()).toMatchObject({
      revision: 'revision-million',
      windowAnchorTurnId: targetTurnId,
      hasMoreBefore: true,
      hasMoreAfter: true,
    });
    expect(new TextEncoder().encode(JSON.stringify(controller.getSnapshot().messages)).byteLength)
      .toBeLessThanOrEqual(256 * 1024);
    controller.stop();
  });

  it('uses opaque revisioned keysets and never retains more than 50 messages by default', async () => {
    const totalMessages = 800;
    const getMessagePage = vi.fn(async (
      conversationId: string,
      options: AgentConversationMessagePageOptions,
    ) => {
      const anchor = options.cursor === undefined
        ? undefined
        : Number(options.cursor.match(/-(\d+)$/u)?.[1]);
      const end = options.direction === 'forward' && anchor !== undefined
        ? Math.min(totalMessages, anchor + options.limit)
        : anchor !== undefined
        ? anchor - 1
        : totalMessages;
      const start = options.direction === 'forward' && anchor !== undefined
        ? anchor + 1
        : Math.max(1, end - options.limit + 1);
      const items = start <= end
        ? Array.from({ length: end - start + 1 }, (_, index) => message(conversationId, start + index))
        : [];
      return page(items, start > 1, end < totalMessages);
    });
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({ getMessagePage }),
    });

    await controller.start(target('bounded'));
    for (let index = 0; index < 5; index += 1) await controller.loadMoreBefore(80);
    expect(controller.getSnapshot().messages).toHaveLength(50);
    expect(controller.getSnapshot().messages[0]?.originSequence).toBe(501);
    expect(controller.getSnapshot().messages.at(-1)?.originSequence).toBe(550);
    expect(controller.getSnapshot()).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true });

    await controller.loadMoreAfter(80);
    expect(controller.getSnapshot().messages).toHaveLength(50);
    expect(controller.getSnapshot().messages[0]?.originSequence).toBe(551);
    expect(controller.getSnapshot().messages.at(-1)?.originSequence).toBe(600);
    expect(controller.getSnapshot()).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true });
    expect(getMessagePage.mock.calls.some(call => call[1].direction === 'backward' && call[1].cursor !== undefined)).toBe(true);
    expect(getMessagePage.mock.calls.some(call => call[1].direction === 'forward' && call[1].cursor !== undefined)).toBe(true);
    expect(getMessagePage.mock.calls.slice(1).every(call => call[1].expectedRevision === 'revision-bounded')).toBe(true);
    expect(getMessagePage.mock.calls.every(call => call[1].limit <= 50 && call[1].maxBytes === 256 * 1024)).toBe(true);
    controller.stop();
  });

  it('re-seeks a captured live-tail anchor before retrying a reset backward page', async () => {
    const conversationId = 'page-reset-before';
    const initial = message(conversationId, 10);
    const getMessagePage = vi.fn(async (
      _conversationId: string,
      options: AgentConversationMessagePageOptions,
    ) => {
      if (options.cursor === undefined) {
        return page([initial], true, false, conversationId, 'revision-1');
      }
      if (options.expectedRevision === 'revision-1') {
        return { reset: true as const, conversationId, revision: 'revision-2' };
      }
      return page(
        [message(conversationId, 8), message(conversationId, 9)],
        true,
        true,
        conversationId,
        'revision-2',
      );
    });
    const getMessageWindowAround = vi.fn(async (
      request: AgentConversationMessageWindowRequest,
    ) => ({
      reset: false as const,
      conversationId,
      revision: request.expectedRevision,
      focus: { kind: 'message' as const, messageId: initial.messageId, turnId: initial.turnId },
      recenterAnchor: { messageId: initial.messageId, turnId: initial.turnId },
      items: [initial],
      hasMoreBefore: true,
      hasMoreAfter: false,
      previousCursor: 'before-reseek-revision-2',
    }));
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({ getMessagePage, getMessageWindowAround }),
    });

    await controller.start(target(conversationId));
    await controller.loadMoreBefore();

    expect(getMessageWindowAround).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 'revision-2',
        focus: { kind: 'message', messageId: initial.messageId, turnId: initial.turnId },
      }),
      { signal: expect.any(AbortSignal) },
    );
    expect(getMessagePage).toHaveBeenCalledTimes(3);
    expect(getMessagePage.mock.calls.slice(1).every(call => call[1].cursor !== undefined)).toBe(true);
    expect(getMessagePage.mock.calls[2]?.[1]).toMatchObject({
      cursor: 'before-reseek-revision-2',
      expectedRevision: 'revision-2',
      direction: 'backward',
    });
    expect(controller.getSnapshot()).toMatchObject({
      revision: 'revision-2',
      loadingMoreBefore: false,
      error: null,
    });
    expect(controller.getSnapshot().messages.map(item => item.originSequence)).toEqual([8, 9, 10]);
    controller.stop();
  });

  it('re-seeks a historical anchor and fulfils the original forward page after reset', async () => {
    const conversationId = 'page-reset-after';
    const anchored = { ...message(conversationId, 50), messageId: 'anchor-50', turnId: 'turn-50' };
    const getMessagePage = vi.fn(async (
      _conversationId: string,
      options: AgentConversationMessagePageOptions,
    ) => {
      if (options.cursor === undefined) {
        return page([message(conversationId, 100)], true, false, conversationId, 'revision-1');
      }
      if (options.expectedRevision === 'revision-1') {
        return { reset: true as const, conversationId, revision: 'revision-2' };
      }
      return page([message(conversationId, 51)], true, true, conversationId, 'revision-2');
    });
    const getMessageWindowAround = vi.fn(async (
      request: AgentConversationMessageWindowRequest,
    ) => ({
      reset: false as const,
      conversationId,
      revision: request.expectedRevision,
      focus: { kind: 'message' as const, messageId: 'anchor-50', turnId: 'turn-50' },
      recenterAnchor: { messageId: 'anchor-50', turnId: 'turn-50' },
      items: [anchored],
      hasMoreBefore: true,
      hasMoreAfter: true,
      previousCursor: `before-${request.expectedRevision}`,
      nextCursor: `after-${request.expectedRevision}`,
    }));
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({ getMessagePage, getMessageWindowAround }),
    });

    await controller.start(target(conversationId));
    await controller.seekToMessage('anchor-50', 'turn-50', undefined, { expectedRevision: 'revision-1' });
    await controller.loadMoreAfter();

    expect(getMessageWindowAround).toHaveBeenCalledTimes(2);
    expect(getMessagePage.mock.calls.at(-1)?.[1]).toMatchObject({
      cursor: 'after-revision-2',
      expectedRevision: 'revision-2',
      direction: 'forward',
    });
    expect(controller.getSnapshot()).toMatchObject({
      revision: 'revision-2',
      loadingMoreAfter: false,
      error: null,
    });
    expect(controller.getSnapshot().messages.map(item => item.originSequence)).toEqual([50, 51]);
    controller.stop();
  });

  it('keeps the re-seek window resident when the one-shot page retry also resets', async () => {
    const conversationId = 'page-reset-exhausted';
    const initial = message(conversationId, 10);
    const getMessagePage = vi.fn(async (
      _conversationId: string,
      options: AgentConversationMessagePageOptions,
    ) =>
      options.cursor === undefined
        ? page([initial], true, false, conversationId, 'revision-1')
        : {
          reset: true as const,
          conversationId,
          revision: options.expectedRevision === 'revision-1' ? 'revision-2' : 'revision-3',
        }
    );
    const replacement = { ...initial, content: 'replacement after reset' };
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        getMessagePage,
        getMessageWindowAround: async request => ({
          reset: false,
          conversationId,
          revision: request.expectedRevision,
          focus: { kind: 'message', messageId: initial.messageId, turnId: initial.turnId },
          recenterAnchor: { messageId: initial.messageId, turnId: initial.turnId },
          items: [replacement],
          hasMoreBefore: true,
          hasMoreAfter: false,
          previousCursor: 'before-replacement',
        }),
      }),
    });

    await controller.start(target(conversationId));
    await controller.loadMoreBefore();

    expect(controller.getSnapshot().messages.map(item => item.content)).toEqual(['replacement after reset']);
    expect(controller.getSnapshot().revision).toBe('revision-2');
    expect(controller.getSnapshot().error?.message).toBe('conversation_paging_reset_exhausted');
    expect(controller.getSnapshot().loadingMoreBefore).toBe(false);
    controller.stop();
  });

  it('bounds live tail updates and ignores messages from another conversation', async () => {
    let listener: ((value: AgentConversationUpdate) => void) | undefined;
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        subscribeToMessages: (_id, callback) => {
          listener = callback;
          return () => {};
        },
      }),
    });
    await controller.start(target('live'));
    listener?.(projectionUpdate(message('foreign', 1)));
    for (let sequence = 1; sequence <= 500; sequence += 1) {
      listener?.(projectionUpdate(message('live', sequence)));
    }

    expect(controller.getSnapshot().messages).toHaveLength(50);
    expect(controller.getSnapshot().messages[0]?.originSequence).toBe(451);
    expect(controller.getSnapshot().messages.every(item => item.conversationId === 'live')).toBe(true);
    expect(controller.getSnapshot().hasMoreBefore).toBe(true);
    controller.stop();
  });

  it('honors custom resident message and shared UTF-8 byte budgets', async () => {
    let listener: ((value: AgentConversationUpdate) => void) | undefined;
    const maxResidentBytes = AGENT_SESSION_CONTRACT_LIMITS.projectionPageMinBytes;
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        getMessagePage: async (id, options) =>
          page(
            Array.from(
              { length: options.limit },
              (_, index) => message(id, 6 - options.limit + index + 1),
            ),
          ),
        subscribeToMessages: (_id, callback) => {
          listener = callback;
          return () => {};
        },
      }),
      maxResidentMessages: 3,
      maxResidentBytes,
    });

    await controller.start(target('custom'));
    expect(controller.getSnapshot().messages.map(item => item.originSequence)).toEqual([4, 5, 6]);
    for (let sequence = 7; sequence <= 20; sequence += 1) {
      listener?.(projectionUpdate(message('custom', sequence)));
    }
    expect(controller.getSnapshot().messages).toHaveLength(3);
    expect(new TextEncoder().encode(JSON.stringify(controller.getSnapshot().messages)).byteLength)
      .toBeLessThanOrEqual(maxResidentBytes);
    controller.stop();
  });

  it('rejects byte budgets that cannot hold a minimum legal projection page', () => {
    const create = (maxResidentBytes: number) =>
      new AgentSessionController({
        agentInstanceClient: instanceClient(),
        conversationClient: conversationClient(),
        maxResidentBytes,
      });

    expect(() => create(1)).toThrow('invalid_max_resident_bytes');
    expect(() => create(AGENT_SESSION_CONTRACT_LIMITS.projectionPageMinBytes - 1))
      .toThrow('invalid_max_resident_bytes');
    expect(() => create(AGENT_SESSION_CONTRACT_LIMITS.projectionPageMinBytes)).not.toThrow();
    expect(() => create(256 * 1024 + 1)).toThrow('invalid_max_resident_bytes');
    expect(() =>
      new AgentSessionController({
        agentInstanceClient: instanceClient(),
        conversationClient: conversationClient(),
        maxResidentMessages: 51,
      })
    ).toThrow('invalid_max_resident_messages');
  });

  it('fails closed when a page returns more than the requested interactive limit', async () => {
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        getMessagePage: async id =>
          page(
            Array.from({ length: 51 }, (_, index) => message(id, index + 1)),
          ),
      }),
    });

    await controller.start(target('lying-count'));
    expect(controller.getSnapshot().messages).toEqual([]);
    expect(controller.getSnapshot().error?.message).toBe('invalid_conversation_message_page');
    controller.stop();
  });

  it('fails closed instead of slicing oversized turn-detail responses', async () => {
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        getTurnDetail: async request => ({
          turnId: request.turnId,
          items: Array.from({ length: 10 }, (_, index) => ({
            ...message(request.conversationId, index + 1),
            turnId: request.turnId,
            content: 'x'.repeat(30_000),
          })),
          hasMoreBefore: false,
          hasMoreAfter: false,
        }),
      }),
    });
    await controller.start(target('oversized-detail'));

    await expect(controller.getTurnDetail({ turnId: 'turn-1' })).resolves.toBeUndefined();
    expect(controller.getSnapshot().messages).toEqual([]);
    expect(controller.getSnapshot().error).not.toBeNull();
    controller.stop();
  });

  it('rejects a page whose actual JSON exceeds its requested byte budget', async () => {
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        getMessagePage: async id =>
          page([
            { ...message(id, 1), content: 'a'.repeat(40_000) },
            { ...message(id, 2), content: 'b'.repeat(40_000) },
          ]),
      }),
      maxResidentBytes: AGENT_SESSION_CONTRACT_LIMITS.projectionPageMinBytes,
    });

    await controller.start(target('lying-page'));
    expect(controller.getSnapshot().messages).toEqual([]);
    expect(controller.getSnapshot().error?.message).toBe('conversation_message_page_exceeds_byte_budget');
    controller.stop();
  });

  it('rejects heavy live tool payloads and never invokes accessors while sizing', async () => {
    let listener: ((value: AgentConversationUpdate) => void) | undefined;
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        subscribeToMessages: (_id, callback) => {
          listener = callback;
          return () => {};
        },
      }),
    });
    await controller.start(target('live-heavy'));

    listener?.(projectionUpdate({
      ...message('live-heavy', 1),
      parts: [{ type: 'tool-result', toolName: 'huge', result: 'x'.repeat(200_000) }],
    } as never));
    expect(controller.getSnapshot().messages).toEqual([]);
    expect(controller.getSnapshot().error?.message).toBe('unbounded_conversation_message_projection');

    let getterCalls = 0;
    const accessorMessage = message('live-heavy', 2);
    Object.defineProperty(accessorMessage, 'metadata', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return { dangerous: true };
      },
    });
    listener?.(projectionUpdate(accessorMessage));
    expect(getterCalls).toBe(0);
    expect(controller.getSnapshot().error?.message).toBe('invalid_conversation_message_projection_json');

    listener?.(projectionUpdate({
      ...message('live-heavy', 3),
      metadata: { unsupported: 1n },
    } as never));
    expect(controller.getSnapshot().error?.message).toBe('invalid_conversation_message_projection_json');
    controller.stop();
  });

  it('sanitizes hostile and secret-bearing transport failures before snapshot persistence', async () => {
    const messageGetter = vi.fn(() => 'must not be read');
    const toString = vi.fn(() => 'must not be stringified');
    const hostile = Object.defineProperty(new Error(), 'message', {
      get: messageGetter,
    });
    hostile.toString = toString;
    const hostileController = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        getMessagePage: async () => {
          throw hostile;
        },
      }),
    });

    await hostileController.start(target('hostile-error'));
    expect(messageGetter).not.toHaveBeenCalled();
    expect(toString).not.toHaveBeenCalled();
    expect(hostileController.getSnapshot().error?.message)
      .toBe('Conversation session start failed');
    expect(hostileController.getSnapshot().error).not.toHaveProperty('cause');
    hostileController.stop();

    const secretController = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        getMessagePage: async () => {
          throw new Error('Authorization: Bearer abcdef123456789');
        },
      }),
    });
    await secretController.start(target('secret-error'));
    expect(secretController.getSnapshot().error?.message)
      .toBe('Authorization: Bearer [REDACTED]');
    expect(secretController.getSnapshot().error).not.toHaveProperty('cause');
    secretController.stop();
  });

  it('rejects every non-canonical projection shape under finite traversal limits', async () => {
    let listener: ((value: AgentConversationUpdate) => void) | undefined;
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        subscribeToMessages: (_id, callback) => {
          listener = callback;
          return () => {};
        },
      }),
    });
    await controller.start(target('strict'));

    const hostile: AgentConversationMessageProjection[] = [
      { ...message('strict', 1), metadata: { missing: undefined } } as never,
      { ...message('strict', 2), metadata: [undefined] } as never,
      { ...message('strict', 3), metadata: { invalid: Number.NaN } } as never,
      { ...message('strict', 4), metadata: { invalid: Number.POSITIVE_INFINITY } } as never,
    ];
    let deep: Record<string, unknown> = {};
    for (let depth = 0; depth < 40; depth += 1) deep = { nested: deep };
    hostile.push({ ...message('strict', 5), metadata: deep } as never);
    hostile.push({
      ...message('strict', 6),
      metadata: Array.from({ length: 10_001 }, () => null),
    } as never);

    for (const projection of hostile) {
      listener?.(projectionUpdate(projection));
      expect(controller.getSnapshot().messages).toEqual([]);
      expect(controller.getSnapshot().error?.message)
        .toBe('invalid_conversation_message_projection_json');
    }
    controller.stop();
  });

  it('rejects a page accessor without invoking it', async () => {
    let getterCalls = 0;
    const hostilePage = {
      hasMoreBefore: false,
      hasMoreAfter: false,
      get items() {
        getterCalls += 1;
        return [];
      },
    } as never;
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({ getMessagePage: async () => hostilePage }),
    });

    await controller.start(target('page-accessor'));

    expect(getterCalls).toBe(0);
    expect(controller.getSnapshot().error?.message)
      .toBe('invalid_conversation_message_projection_json');
    controller.stop();
  });
});

describe('AgentSessionController listeners', () => {
  it('supports independent subscriptions, unsubscribe, and listener throw isolation', async () => {
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient(),
    });
    let firstCalls = 0;
    let secondCalls = 0;
    const unsubscribeThrowing = controller.subscribe(() => {
      throw new Error('renderer failed');
    });
    const unsubscribeFirst = controller.subscribe(() => {
      firstCalls += 1;
    });
    const unsubscribeSecond = controller.subscribe(() => {
      secondCalls += 1;
    });

    unsubscribeFirst();
    const firstCallsAfterUnsubscribe = firstCalls;
    await controller.start(target('listeners'));
    expect(firstCalls).toBe(firstCallsAfterUnsubscribe);
    expect(secondCalls).toBeGreaterThan(1);

    unsubscribeSecond();
    const secondCallsAfterUnsubscribe = secondCalls;
    controller.stop();
    expect(secondCalls).toBe(secondCallsAfterUnsubscribe);
    unsubscribeThrowing();
  });

  it('returns a stable immutable snapshot that hostile consumers cannot corrupt', async () => {
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient({
        fetchAgent: async id => ({
          ...agent(id),
          status: { state: 'idle', progress: 'safe' },
        }),
      }),
      conversationClient: conversationClient({
        getMessagePage: async conversationId =>
          page([{
            ...message(conversationId, 1),
            metadata: { nested: { value: 'safe' } },
          }]),
        getTurnDetail: async () => {
          throw new Error('detail failed');
        },
      }),
    });
    let listenerCalls = 0;
    controller.subscribe(() => {
      listenerCalls += 1;
    });
    await controller.start(target('immutable'));
    const snapshot = controller.getSnapshot();
    const callsBeforeMutation = listenerCalls;
    const nested = snapshot.messages[0]?.metadata?.nested as Record<string, unknown>;

    expect(controller.getSnapshot()).toBe(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.agent)).toBe(true);
    expect(Object.isFrozen(snapshot.agent?.status)).toBe(true);
    expect(Object.isFrozen(snapshot.messages)).toBe(true);
    expect(Object.isFrozen(snapshot.messages[0])).toBe(true);
    expect(Object.isFrozen(snapshot.messages[0]?.metadata)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(snapshot.orderedMessageIds)).toBe(true);
    expect(Object.isFrozen(snapshot.streamingMessageIds)).toBe(true);
    expect(Object.isFrozen(snapshot.startCursor)).toBe(true);

    expect(Reflect.set(snapshot, 'loading', true)).toBe(false);
    expect(Reflect.set(snapshot.agent!, 'name', 'poisoned')).toBe(false);
    expect(Reflect.set(snapshot.agent!.status, 'state', 'failed')).toBe(false);
    expect(Reflect.set(snapshot.messages, '0', message('foreign', 99))).toBe(false);
    expect(Reflect.set(snapshot.messages[0], 'content', 'poisoned')).toBe(false);
    expect(Reflect.set(nested, 'value', 'poisoned')).toBe(false);
    expect(Reflect.set(snapshot.orderedMessageIds, '0', 'poisoned')).toBe(false);
    expect(Reflect.set(snapshot.startCursor!, 'timestamp', 999)).toBe(false);
    expect(() => {
      (snapshot.streamingMessageIds as unknown as Set<string>).add('poisoned');
    }).toThrow(TypeError);

    expect(controller.getSnapshot()).toBe(snapshot);
    expect(controller.getSnapshot()).toMatchObject({
      loading: false,
      agent: { name: 'Agent immutable', status: { state: 'idle', progress: 'safe' } },
      orderedMessageIds: ['immutable-message-1'],
      messages: [{ content: 'immutable message 1', metadata: { nested: { value: 'safe' } } }],
      startCursor: { timestamp: 1 },
    });
    expect(controller.getSnapshot().streamingMessageIds.has('poisoned')).toBe(false);
    expect(listenerCalls).toBe(callsBeforeMutation);

    const messages = snapshot.messages;
    await expect(controller.getTurnDetail({ turnId: 'turn-1' })).resolves.toBeUndefined();
    expect(controller.getSnapshot()).not.toBe(snapshot);
    expect(controller.getSnapshot().messages).toBe(messages);
    controller.stop();
  });
});

describe('AgentSessionController typed scoped operations', () => {
  it('links an external turn-detail cancellation without publishing an error', async () => {
    let detailSignal: AbortSignal | undefined;
    const getTurnDetail = vi.fn((_request, options?: AgentManagementCallOptions) =>
      new Promise<never>((_resolve, reject) => {
        detailSignal = options?.signal;
        const rejectAbort = () => {
          const error = new Error('detail aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (options?.signal?.aborted) rejectAbort();
        else options?.signal?.addEventListener('abort', rejectAbort, { once: true });
      })
    );
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({ getTurnDetail }),
    });
    await controller.start(target('detail-cancel'));
    const external = new AbortController();
    const reading = controller.getTurnDetail({ turnId: 'turn-1' }, { signal: external.signal });
    await vi.waitFor(() => {
      expect(detailSignal).toBeInstanceOf(AbortSignal);
    });
    external.abort(new Error('view collapsed'));

    await expect(reading).resolves.toBeUndefined();
    expect(detailSignal?.aborted).toBe(true);
    expect(controller.getSnapshot().error).toBeNull();
    controller.stop();
  });

  it('removes external turn-detail abort listeners after completion', async () => {
    let detailSignal: AbortSignal | undefined;
    const getTurnDetail = vi.fn(async (request, options?: AgentManagementCallOptions) => {
      detailSignal = options?.signal;
      return {
        turnId: request.turnId,
        items: [],
        hasMoreBefore: false,
        hasMoreAfter: false,
      };
    });
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({ getTurnDetail }),
    });
    await controller.start(target('detail-cleanup'));
    const external = new AbortController();

    await expect(controller.getTurnDetail(
      { turnId: 'turn-1' },
      { signal: external.signal },
    )).resolves.toMatchObject({ turnId: 'turn-1' });
    external.abort(new Error('late abort'));
    expect(detailSignal?.aborted).toBe(false);
    expect(controller.getSnapshot().error).toBeNull();
    controller.stop();
  });

  it('preserves a typed missing-key failure so the host cannot mistake send for success', async () => {
    const missingKeyFailure = new AgentRunFailure(createMissingApiKeyAgentRunError({
      providerId: 'openai',
      modelId: 'gpt-example',
      diagnosticId: 'diag-session-missing-key',
    }));
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        sendMessage: async () => {
          throw missingKeyFailure;
        },
      }),
    });
    await controller.start(target('agent-send', 'conversation-send'));

    await expect(controller.sendMessage('keep composer state')).rejects.toBe(missingKeyFailure);
    expect(controller.getSnapshot().error).not.toBe(missingKeyFailure);
    expect(controller.getSnapshot().error).toMatchObject({
      name: 'AgentRunFailure',
      agentRunError: missingKeyFailure.agentRunError,
    });
    expect(missingKeyFailure.agentRunError).toMatchObject({
      code: 'PROVIDER_AUTH_MISSING',
      settingTarget: { kind: 'provider', providerId: 'openai', field: 'apiKey' },
    });
    controller.stop();
  });

  it('updates the snapshot and rejects typed failures for cancel, delete, and retry', async () => {
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient({
        cancelAgent: async () => {
          throw new Error('private cancel transport detail');
        },
      }),
      conversationClient: conversationClient({
        deleteTurn: async () => {
          throw new Error('private delete transport detail');
        },
        retryTurn: async () => {
          throw new Error('private retry transport detail');
        },
      }),
    });
    await controller.start(target('agent-write', 'conversation-write'));

    await expect(controller.cancel()).rejects.toMatchObject({
      name: 'AgentRunFailure',
      agentRunError: { code: 'INTERNAL' },
    });
    expect(controller.getSnapshot().error).toBeInstanceOf(AgentRunFailure);
    await expect(controller.deleteTurn({
      turnId: 'turn-1',
      requestId: 'delete-failure',
    })).rejects.toMatchObject({
      name: 'AgentRunFailure',
      agentRunError: { code: 'INTERNAL' },
    });
    expect(controller.getSnapshot().error).toBeInstanceOf(AgentRunFailure);
    await expect(controller.retryTurn({
      turnId: 'turn-1',
      newTurnId: 'turn-2',
      requestId: 'retry-failure',
    })).rejects.toMatchObject({
      name: 'AgentRunFailure',
      agentRunError: { code: 'INTERNAL' },
    });
    expect(controller.getSnapshot().error).toBeInstanceOf(AgentRunFailure);
    expect(controller.getSnapshot().error?.message)
      .not.toContain('private retry transport detail');
    controller.stop();
  });

  it('rejects an invalid precomputed attachment digest before starting an upload', async () => {
    const sendMessage = vi.fn(async () => {});
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({ sendMessage }),
    });
    await controller.start(target('attachment'));

    await expect(controller.sendMessage('with attachment', {
      kind: 'source',
      filename: 'note.txt',
      mimeType: 'text/plain',
      totalBytes: 4,
      sha256: 'not-a-digest',
      readChunk: async () => new Uint8Array([1, 2, 3, 4]),
    })).rejects.toMatchObject({
      name: 'AgentRunFailure',
      agentRunError: { code: 'INTERNAL' },
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(controller.getSnapshot().error).toMatchObject({
      name: 'AgentRunFailure',
      agentRunError: { code: 'INTERNAL' },
    });
    controller.stop();
  });

  it('scopes detail/absolute seek and every write to the active generation signal', async () => {
    const getTurnDetail = vi.fn(async (
      request: AgentConversationTurnDetailRequest,
      _options?: AgentManagementCallOptions,
    ) => ({
      turnId: request.turnId,
      items: [{ ...message(request.conversationId, 2), turnId: request.turnId }],
      hasMoreBefore: false,
      hasMoreAfter: false,
    }));
    const getMessageWindowAround = vi.fn(async (
      request: AgentConversationMessageWindowRequest,
      _options?: AgentManagementCallOptions,
    ) => {
      if (request.focus.kind !== 'message') throw new Error('expected message focus');
      return {
        reset: false as const,
        conversationId: request.conversationId,
        revision: request.expectedRevision,
        focus: {
          kind: 'message' as const,
          messageId: request.focus.messageId,
          turnId: request.focus.turnId,
        },
        recenterAnchor: {
          messageId: request.focus.messageId,
          turnId: request.focus.turnId,
        },
        items: [{
          ...message(request.conversationId, 2),
          messageId: request.focus.messageId,
          turnId: request.focus.turnId,
        }],
        hasMoreBefore: false,
        hasMoreAfter: false,
      };
    });
    const sendMessage = vi.fn(async (
      _agentId: string,
      _content: string,
      _attachment?: AgentAttachmentInput,
      _wikiTiddlers?: WikiTiddlerAttachment[],
      _options?: AgentManagementCallOptions,
    ) => {});
    const deleteTurn = vi.fn(async (
      request: AgentConversationDeleteTurnRequest,
      _options?: AgentManagementCallOptions,
    ) => ({
      ok: true as const,
      conversationId: request.conversationId,
      turnId: request.turnId,
      requestId: request.requestId,
      tombstone: tombstone(request),
    }));
    const retryTurn = vi.fn(async (
      request: AgentConversationRetryTurnRequest,
      _options?: AgentManagementCallOptions,
    ) => ({
      ok: true as const,
      runId: 'run-retry',
      conversationId: request.conversationId,
      turnId: request.newTurnId,
      requestId: request.requestId,
      state: 'accepted' as const,
      tombstone: tombstone(request),
      userEvent: userEvent(request),
    }));
    const cancelAgent = vi.fn(async (
      _agentId: string,
      _options?: AgentManagementCallOptions,
    ) => {});
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient({ cancelAgent }),
      conversationClient: conversationClient({
        getTurnDetail,
        getMessageWindowAround,
        sendMessage,
        deleteTurn,
        retryTurn,
      }),
    });
    await controller.start(target('agent-scoped', 'conversation-scoped'));

    await expect(controller.getTurnDetail({ turnId: 'turn-1', limit: 10 })).resolves.toMatchObject({
      turnId: 'turn-1',
    });
    await expect(controller.seekToMessage('turn-1', 'turn-1', undefined, {
      expectedRevision: 'revision-conversation-scoped',
    })).resolves.toMatchObject({
      focus: { kind: 'message', messageId: 'turn-1', turnId: 'turn-1' },
    });
    await controller.sendMessage('hello');
    await controller.cancel();
    await expect(controller.deleteTurn({
      turnId: 'turn-1',
      requestId: 'delete-1',
      reason: 'user-delete',
    })).resolves.toMatchObject({ conversationId: 'conversation-scoped', turnId: 'turn-1' });
    await expect(controller.retryTurn({
      turnId: 'turn-1',
      newTurnId: 'turn-2',
      requestId: 'retry-1',
    })).resolves.toMatchObject({ conversationId: 'conversation-scoped', turnId: 'turn-2' });

    const calls: Array<[unknown, AgentManagementCallOptions | undefined]> = [
      [getTurnDetail.mock.calls[0]?.[0], getTurnDetail.mock.calls[0]?.[1]],
      [getMessageWindowAround.mock.calls[0]?.[0], getMessageWindowAround.mock.calls[0]?.[1]],
      [deleteTurn.mock.calls[0]?.[0], deleteTurn.mock.calls[0]?.[1]],
      [retryTurn.mock.calls[0]?.[0], retryTurn.mock.calls[0]?.[1]],
    ];
    for (const [request, options] of calls) {
      expect(request).toMatchObject({ conversationId: 'conversation-scoped' });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(options?.signal?.aborted).toBe(false);
    }
    expect(retryTurn.mock.calls[0]?.[0]).not.toHaveProperty('message');
    expect(sendMessage.mock.calls[0]?.[0]).toBe('conversation-scoped');
    expect(sendMessage.mock.calls[0]?.[4]?.signal).toBeInstanceOf(AbortSignal);
    expect(cancelAgent.mock.calls[0]?.[0]).toBe('agent-scoped');
    expect(cancelAgent.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    controller.stop();
  });

  it('rejects turn responses correlated to another conversation or focus turn', async () => {
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        getTurnDetail: async request => ({
          turnId: request.turnId,
          items: [message('foreign', 1)],
          hasMoreBefore: false,
          hasMoreAfter: false,
        }),
        getMessageWindowAround: async request => ({
          reset: false,
          conversationId: request.conversationId,
          revision: request.expectedRevision,
          focus: { kind: 'message', messageId: 'another-turn', turnId: 'another-turn' },
          recenterAnchor: { messageId: 'another-turn', turnId: 'another-turn' },
          items: [{ ...message(request.conversationId, 1), turnId: 'another-turn' }],
          hasMoreBefore: false,
          hasMoreAfter: false,
        }),
      }),
    });
    await controller.start(target('scoped'));

    await expect(controller.getTurnDetail({ turnId: 'turn-1' })).resolves.toBeUndefined();
    expect(controller.getSnapshot().error).not.toBeNull();
    await expect(controller.seekToMessage('turn-1', 'turn-1', undefined, {
      expectedRevision: 'revision-scoped',
    })).resolves.toBeUndefined();
    expect(controller.getSnapshot().error).not.toBeNull();
    controller.stop();
  });

  it('fails closed instead of slicing an oversized atomic window response', async () => {
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        getMessagePage: async conversationId => page([message(conversationId, 1)]),
        getMessageWindowAround: async request => ({
          reset: false,
          conversationId: request.conversationId,
          revision: request.expectedRevision,
          focus: { kind: 'message', messageId: 'turn-oversized', turnId: 'turn-oversized' },
          recenterAnchor: { messageId: 'turn-oversized', turnId: 'turn-oversized' },
          items: Array.from({ length: 51 }, (_, index) => ({
            ...message(request.conversationId, index + 2),
            turnId: index === 0 ? 'turn-oversized' : `turn-${index}`,
          })),
          hasMoreBefore: true,
          hasMoreAfter: true,
          previousCursor: 'before-oversized',
          nextCursor: 'after-oversized',
        }),
      }),
    });
    await controller.start(target('oversized-window'));
    const beforeMessages = controller.getSnapshot().messages;

    await expect(controller.seekToMessage('turn-oversized', 'turn-oversized', undefined, {
      expectedRevision: 'revision-oversized-window',
    })).resolves.toBeUndefined();

    expect(controller.getSnapshot().messages).toBe(beforeMessages);
    expect(controller.getSnapshot().error?.message).toBe('invalid_conversation_message_window');
    controller.stop();
  });

  it('jumps directly into a logical 100k conversation with one atomic window read', async () => {
    const getMessagePage = vi.fn(async (conversationId: string) => page([message(conversationId, 100_000)], true, false));
    const getMessageWindowAround = vi.fn(async (request: AgentConversationMessageWindowRequest) => ({
      reset: false as const,
      conversationId: request.conversationId,
      revision: request.expectedRevision,
      focus: { kind: 'message' as const, messageId: 'jump-turn', turnId: 'jump-turn' },
      recenterAnchor: { messageId: 'jump-turn', turnId: 'jump-turn' },
      items: Array.from({ length: 5 }, (_, index) => ({
        ...message(request.conversationId, 50_000 + index),
        role: 'assistant' as const,
        messageId: index === 2 ? 'jump-turn' : `nearby-message-${index}`,
        turnId: index === 2 ? 'jump-turn' : `nearby-${index}`,
      })),
      hasMoreBefore: true,
      hasMoreAfter: true,
      previousCursor: 'opaque-before-jump',
      nextCursor: 'opaque-after-jump',
    }));
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({ getMessagePage, getMessageWindowAround }),
    });
    await controller.start(target('jump'));
    let emissions = 0;
    const unsubscribe = controller.subscribe(() => {
      emissions += 1;
    });
    emissions = 0;

    await expect(controller.seekToMessage('jump-turn', 'jump-turn', undefined, {
      expectedRevision: 'revision-jump',
    })).resolves.toMatchObject({
      focus: { kind: 'message', messageId: 'jump-turn', turnId: 'jump-turn' },
    });

    expect(getMessageWindowAround).toHaveBeenCalledTimes(1);
    expect(getMessagePage).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().messages.map(item => item.originSequence)).toEqual([
      50_000,
      50_001,
      50_002,
      50_003,
      50_004,
    ]);
    expect(controller.getSnapshot()).toMatchObject({
      previousCursor: 'opaque-before-jump',
      nextCursor: 'opaque-after-jump',
      revision: 'revision-jump',
    });
    expect(emissions).toBe(1);
    unsubscribe();
    controller.stop();
  });

  it('jumps from an older window to the latest tail with one bounded read and one emission', async () => {
    const getMessagePage = vi.fn(async (conversationId: string) => {
      const sequence = getMessagePage.mock.calls.length === 1 ? 100_000 : 100_050;
      return page(
        Array.from({ length: 50 }, (_, index) => message(conversationId, sequence - 49 + index)),
        true,
        false,
      );
    });
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        getMessagePage,
        getMessageWindowAround: async request => ({
          reset: false,
          conversationId: request.conversationId,
          revision: request.expectedRevision,
          focus: { kind: 'message', messageId: 'old-turn', turnId: 'old-turn' },
          recenterAnchor: { messageId: 'old-turn', turnId: 'old-turn' },
          items: [{ ...message(request.conversationId, 50_000), turnId: 'old-turn' }],
          hasMoreBefore: true,
          hasMoreAfter: true,
          previousCursor: 'before-old',
          nextCursor: 'after-old',
        }),
      }),
    });
    await controller.start(target('jump-latest'));
    await controller.seekToMessage('old-turn', 'old-turn', undefined, {
      expectedRevision: 'revision-jump-latest',
    });
    let emissions = 0;
    const unsubscribe = controller.subscribe(() => {
      emissions += 1;
    });
    emissions = 0;

    await controller.jumpToLatest();

    expect(getMessagePage).toHaveBeenCalledTimes(2);
    expect(getMessagePage.mock.calls[1]).toEqual([
      'jump-latest',
      {
        limit: 50,
        direction: 'backward',
        maxBytes: 256 * 1024,
      },
      { signal: expect.any(AbortSignal) },
    ]);
    expect(controller.getSnapshot().messages).toHaveLength(50);
    expect(controller.getSnapshot().messages.at(-1)?.originSequence).toBe(100_050);
    expect(controller.getSnapshot()).toMatchObject({ hasMoreAfter: false });
    expect(emissions).toBe(1);
    unsubscribe();
    controller.stop();
  });

  it('fences an externally aborted jump-to-latest without snapshot mutation', async () => {
    const latest = deferred<AgentConversationMessagePageSuccess>();
    let jumpSignal: AbortSignal | undefined;
    const getMessagePage = vi.fn(async (
      conversationId: string,
      _options: AgentConversationMessagePageOptions,
      callOptions?: AgentManagementCallOptions,
    ) => {
      if (getMessagePage.mock.calls.length === 1) {
        return page([message(conversationId, 1)], false, false);
      }
      jumpSignal = callOptions?.signal;
      return latest.promise;
    });
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({ getMessagePage }),
    });
    await controller.start(target('jump-abort'));
    const before = controller.getSnapshot();
    const abort = new AbortController();
    const jumping = controller.jumpToLatest({ signal: abort.signal });
    abort.abort('caller canceled');
    expect(jumpSignal?.aborted).toBe(true);
    latest.resolve(page([message('jump-abort', 2)], false, false));
    await jumping;

    expect(controller.getSnapshot()).toBe(before);
    expect(controller.getSnapshot().error).toBeNull();
    controller.stop();
  });

  it('lets an invalidation racing jump-to-latest own one coalesced refresh', async () => {
    const staleJump = deferred<AgentConversationMessagePageSuccess>();
    let updateListener: ((update: AgentConversationUpdate) => void) | undefined;
    const getMessagePage = vi.fn(async (conversationId: string) => {
      if (getMessagePage.mock.calls.length === 1) {
        return page(
          [message(conversationId, 1)],
          false,
          false,
          conversationId,
          'revision-1',
        );
      }
      if (getMessagePage.mock.calls.length === 2) return staleJump.promise;
      return page(
        [message(conversationId, 3)],
        false,
        false,
        conversationId,
        'revision-3',
      );
    });
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        getMessagePage,
        subscribeToMessages: (_conversationId, listener) => {
          updateListener = listener;
          return () => {};
        },
      }),
    });
    await controller.start(target('jump-invalidation'));
    const jumping = controller.jumpToLatest();
    updateListener?.({
      kind: 'invalidated',
      conversationId: 'jump-invalidation',
      previousRevision: 'revision-1',
      revision: 'revision-3',
      reason: 'append',
      appendedMessageCount: 1,
    });
    staleJump.resolve(page(
      [message('jump-invalidation', 2)],
      false,
      false,
      'jump-invalidation',
      'revision-2',
    ));
    await jumping;
    await vi.waitFor(() => {
      expect(controller.getSnapshot().revision).toBe('revision-3');
    });

    expect(getMessagePage).toHaveBeenCalledTimes(3);
    expect(controller.getSnapshot().messages.map(item => item.originSequence)).toEqual([3]);
    expect(controller.getSnapshot().error).toBeNull();
    controller.stop();
  });

  it('atomically re-seeks a historical anchor across revisions and counts pending appends', async () => {
    let updateListener: ((update: AgentConversationUpdate) => void) | undefined;
    const getMessagePage = vi.fn(async (conversationId: string) =>
      page(
        [message(conversationId, getMessagePage.mock.calls.length === 1 ? 100_000 : 100_010)],
        true,
        false,
        conversationId,
        getMessagePage.mock.calls.length === 1 ? 'revision-1' : 'revision-6',
      )
    );
    const getMessageWindowAround = vi.fn(async (
      request: AgentConversationMessageWindowRequest,
    ) => ({
      reset: false as const,
      conversationId: request.conversationId,
      revision: request.expectedRevision,
      focus: {
        kind: 'message' as const,
        messageId: 'history-anchor-message',
        turnId: 'history-anchor',
      },
      recenterAnchor: { messageId: 'history-anchor-message', turnId: 'history-anchor' },
      items: [{
        ...message(request.conversationId, 50_000),
        messageId: 'history-anchor-message',
        turnId: 'history-anchor',
      }],
      hasMoreBefore: true,
      hasMoreAfter: true,
      previousCursor: `before-${request.expectedRevision}`,
      nextCursor: `after-${request.expectedRevision}`,
    }));
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        getMessagePage,
        getMessageWindowAround,
        subscribeToMessages: (_conversationId, listener) => {
          updateListener = listener;
          return () => {};
        },
      }),
    });
    await controller.start(target('anchored-history'));
    await controller.seekToMessage('history-anchor-message', 'history-anchor', undefined, {
      expectedRevision: 'revision-1',
    });
    expect(controller.getSnapshot()).toMatchObject({
      revision: 'revision-1',
      windowAnchorTurnId: 'history-anchor',
      windowAnchorMessageId: 'history-anchor-message',
      pendingNewMessageCount: 0,
      hasMoreAfter: true,
    });

    const invalidate = (
      previousRevision: string,
      revision: string,
      reason: Extract<AgentConversationUpdate, { kind: 'invalidated' }>['reason'],
      appendedMessageCount = 0,
    ) => {
      updateListener?.(
        reason === 'append'
          ? {
            kind: 'invalidated',
            conversationId: 'anchored-history',
            previousRevision,
            revision,
            reason,
            appendedMessageCount,
          }
          : {
            kind: 'invalidated',
            conversationId: 'anchored-history',
            previousRevision,
            revision,
            reason,
          },
      );
    };
    invalidate('revision-1', 'revision-2', 'append', 3);
    await vi.waitFor(() => {
      expect(controller.getSnapshot().revision).toBe('revision-2');
    });
    invalidate('revision-2', 'revision-3', 'append', 4);
    await vi.waitFor(() => {
      expect(controller.getSnapshot().revision).toBe('revision-3');
    });
    invalidate('revision-3', 'revision-4', 'tombstone');
    await vi.waitFor(() => {
      expect(controller.getSnapshot().revision).toBe('revision-4');
    });
    invalidate('revision-4', 'revision-5', 'compaction');
    await vi.waitFor(() => {
      expect(controller.getSnapshot().revision).toBe('revision-5');
    });

    expect(getMessagePage).toHaveBeenCalledTimes(1);
    expect(getMessageWindowAround).toHaveBeenCalledTimes(5);
    expect(
      getMessageWindowAround.mock.calls.slice(1).every(call =>
        call[0].focus.kind === 'message' &&
        call[0].focus.messageId === 'history-anchor-message' &&
        call[0].focus.turnId === 'history-anchor'
      ),
    ).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      revision: 'revision-5',
      windowAnchorTurnId: 'history-anchor',
      windowAnchorMessageId: 'history-anchor-message',
      pendingNewMessageCount: 7,
      hasMoreAfter: true,
    });

    await controller.jumpToLatest();
    expect(controller.getSnapshot()).toMatchObject({
      revision: 'revision-6',
      windowAnchorMessageId: 'anchored-history-message-100010',
      pendingNewMessageCount: 0,
      hasMoreAfter: false,
    });
    controller.stop();
  });

  it('reconciles provisional projection counts with exact append invalidations exactly once', async () => {
    const conversationId = 'append-count-dedup';
    let updateListener: ((update: AgentConversationUpdate) => void) | undefined;
    const anchored = {
      ...message(conversationId, 50),
      messageId: 'dedup-anchor',
      turnId: 'dedup-anchor',
    };
    const getMessageWindowAround = vi.fn(async (
      request: AgentConversationMessageWindowRequest,
    ) => ({
      reset: false as const,
      conversationId,
      revision: request.expectedRevision,
      focus: { kind: 'message' as const, messageId: 'dedup-anchor', turnId: 'dedup-anchor' },
      recenterAnchor: { messageId: 'dedup-anchor', turnId: 'dedup-anchor' },
      items: [anchored],
      hasMoreBefore: true,
      hasMoreAfter: true,
      previousCursor: `before-${request.expectedRevision}`,
      nextCursor: `after-${request.expectedRevision}`,
    }));
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        getMessagePage: async () =>
          page(
            [message(conversationId, 100)],
            true,
            false,
            conversationId,
            'revision-1',
          ),
        getMessageWindowAround,
        subscribeToMessages: (_conversationId, listener) => {
          updateListener = listener;
          return () => {};
        },
      }),
    });
    await controller.start(target(conversationId));
    await controller.seekToMessage('dedup-anchor', 'dedup-anchor', undefined, { expectedRevision: 'revision-1' });

    updateListener?.(projectionUpdate(message(conversationId, 101), 'revision-2'));
    await vi.waitFor(() => {
      expect(controller.getSnapshot()).toMatchObject({
        revision: 'revision-2',
        pendingNewMessageCount: 1,
      });
    });
    const exact = {
      kind: 'invalidated' as const,
      conversationId,
      previousRevision: 'revision-1',
      revision: 'revision-2',
      reason: 'append' as const,
      appendedMessageCount: 5,
    };
    updateListener?.(exact);
    await vi.waitFor(() => {
      expect(controller.getSnapshot().pendingNewMessageCount).toBe(5);
    });
    updateListener?.(exact);
    await vi.waitFor(() => {
      expect(controller.getSnapshot().pendingNewMessageCount).toBe(5);
    });

    expect(controller.getSnapshot().revision).toBe('revision-2');
    expect(controller.getSnapshot().error).toBeNull();
    controller.stop();
  });

  it('does not regress or count a late overlapping invalidation edge', async () => {
    const conversationId = 'append-chain-overlap';
    let updateListener: ((update: AgentConversationUpdate) => void) | undefined;
    const anchored = {
      ...message(conversationId, 50),
      messageId: 'overlap-anchor',
      turnId: 'overlap-anchor',
    };
    const requestedRevisions: string[] = [];
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        getMessagePage: async () =>
          page(
            [message(conversationId, 100)],
            true,
            false,
            conversationId,
            'revision-1',
          ),
        getMessageWindowAround: async request => {
          requestedRevisions.push(request.expectedRevision ?? 'missing');
          return {
            reset: false,
            conversationId,
            revision: request.expectedRevision,
            focus: { kind: 'message', messageId: 'overlap-anchor', turnId: 'overlap-anchor' },
            recenterAnchor: { messageId: 'overlap-anchor', turnId: 'overlap-anchor' },
            items: [anchored],
            hasMoreBefore: true,
            hasMoreAfter: true,
            previousCursor: 'before-overlap',
            nextCursor: 'after-overlap',
          };
        },
        subscribeToMessages: (_conversationId, listener) => {
          updateListener = listener;
          return () => {};
        },
      }),
    });
    await controller.start(target(conversationId));
    await controller.seekToMessage('overlap-anchor', 'overlap-anchor', undefined, { expectedRevision: 'revision-1' });

    updateListener?.({
      kind: 'invalidated',
      conversationId,
      previousRevision: 'revision-2',
      revision: 'revision-3',
      reason: 'append',
      appendedMessageCount: 9,
    });
    await vi.waitFor(() => {
      expect(controller.getSnapshot().revision).toBe('revision-3');
    });
    updateListener?.({
      kind: 'invalidated',
      conversationId,
      previousRevision: 'revision-1',
      revision: 'revision-2',
      reason: 'append',
      appendedMessageCount: 4,
    });
    await vi.waitFor(() => {
      expect(requestedRevisions.length).toBeGreaterThanOrEqual(3);
    });

    expect(requestedRevisions.slice(-2)).toEqual(['revision-3', 'revision-3']);
    expect(controller.getSnapshot()).toMatchObject({
      revision: 'revision-3',
      pendingNewMessageCount: 0,
      error: null,
    });
    controller.stop();
  });

  it('rejects non-positive, non-finite, and oversized append counts before refresh', async () => {
    const conversationId = 'append-count-hostile';
    let updateListener: ((update: AgentConversationUpdate) => void) | undefined;
    const getMessageWindowAround = vi.fn();
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        getMessagePage: async () =>
          page(
            [message(conversationId, 1)],
            false,
            false,
            conversationId,
            'revision-1',
          ),
        getMessageWindowAround,
        subscribeToMessages: (_conversationId, listener) => {
          updateListener = listener;
          return () => {};
        },
      }),
    });
    await controller.start(target(conversationId));

    for (const [index, appendedMessageCount] of [0, Number.NaN, 1_000_001].entries()) {
      updateListener?.({
        kind: 'invalidated',
        conversationId,
        previousRevision: 'revision-1',
        revision: `hostile-revision-${index}`,
        reason: 'append',
        appendedMessageCount,
      });
      expect(controller.getSnapshot().error?.message).toBe(
        Number.isNaN(appendedMessageCount)
          ? 'invalid_conversation_message_projection_json'
          : 'invalid_conversation_update_append_count',
      );
    }
    expect(getMessageWindowAround).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      revision: 'revision-1',
      pendingNewMessageCount: 0,
    });
    controller.stop();
  });

  it('retries a historical reset revision without ever replacing the window with the tail', async () => {
    let updateListener: ((update: AgentConversationUpdate) => void) | undefined;
    const anchored = { ...message('reset-history', 4), messageId: 'anchor-turn', turnId: 'anchor-turn' };
    const getMessagePage = vi.fn(async () =>
      page(
        [message('reset-history', 10)],
        true,
        false,
        'reset-history',
        'revision-1',
      )
    );
    const getMessageWindowAround = vi.fn()
      .mockResolvedValueOnce({
        reset: false,
        conversationId: 'reset-history',
        revision: 'revision-1',
        focus: { kind: 'message', messageId: 'anchor-turn', turnId: 'anchor-turn' },
        recenterAnchor: { messageId: 'anchor-turn', turnId: 'anchor-turn' },
        items: [anchored],
        hasMoreBefore: true,
        hasMoreAfter: true,
        previousCursor: 'before-anchor',
        nextCursor: 'after-anchor',
      })
      .mockResolvedValueOnce({
        reset: true,
        conversationId: 'reset-history',
        revision: 'revision-3',
      })
      .mockResolvedValueOnce({
        reset: false,
        conversationId: 'reset-history',
        revision: 'revision-3',
        focus: { kind: 'message', messageId: 'anchor-turn', turnId: 'anchor-turn' },
        recenterAnchor: { messageId: 'anchor-turn', turnId: 'anchor-turn' },
        items: [anchored],
        hasMoreBefore: true,
        hasMoreAfter: true,
        previousCursor: 'before-anchor',
        nextCursor: 'after-anchor',
      });
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        getMessagePage,
        getMessageWindowAround,
        subscribeToMessages: (_conversationId, listener) => {
          updateListener = listener;
          return () => {};
        },
      }),
    });
    await controller.start(target('reset-history'));
    await controller.seekToMessage('anchor-turn', 'anchor-turn', undefined, { expectedRevision: 'revision-1' });
    updateListener?.({
      kind: 'invalidated',
      conversationId: 'reset-history',
      previousRevision: 'revision-1',
      revision: 'revision-2',
      reason: 'append',
      appendedMessageCount: 2,
    });
    await vi.waitFor(() => {
      expect(getMessageWindowAround).toHaveBeenCalledTimes(3);
    });
    await vi.waitFor(() => {
      expect(controller.getSnapshot().revision).toBe('revision-3');
    });
    expect(controller.getSnapshot()).toMatchObject({
      windowAnchorTurnId: 'anchor-turn',
      windowAnchorMessageId: 'anchor-turn',
      pendingNewMessageCount: 2,
    });
    expect(getMessagePage).toHaveBeenCalledTimes(1);
    expect(getMessageWindowAround.mock.calls[2]?.[0]).toMatchObject({
      expectedRevision: 'revision-3',
      focus: { kind: 'message', messageId: 'anchor-turn', turnId: 'anchor-turn' },
    });
    controller.stop();
  });

  it('tracks streaming ids immutably and ignores disjoint historical streams', async () => {
    let listener: ((update: AgentConversationUpdate) => void) | undefined;
    const getMessageWindowAround = vi.fn(async () => ({
      reset: false as const,
      conversationId: 'stream-state',
      revision: 'revision-stream-state',
      focus: { kind: 'message' as const, messageId: 'history-turn', turnId: 'history-turn' },
      recenterAnchor: { messageId: 'history-turn', turnId: 'history-turn' },
      items: [{ ...message('stream-state', 1), messageId: 'history-turn', turnId: 'history-turn' }],
      hasMoreBefore: false,
      hasMoreAfter: true,
      nextCursor: 'after-history',
    }));
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        getMessageWindowAround,
        subscribeToMessages: (_conversationId, next) => {
          listener = next;
          return () => {};
        },
      }),
    });
    await controller.start(target('stream-state'));
    const streamingMessage: AgentConversationMessageProjection = {
      ...message('stream-state', 2),
      content: '',
      reasoning: { text: 'inspect', totalBytes: 7, hasMore: false },
    };
    listener?.({ ...projectionUpdate(streamingMessage), streaming: true });
    expect([...controller.getSnapshot().streamingMessageIds]).toEqual([streamingMessage.messageId]);
    expect(controller.getSnapshot().messages.at(-1)).toMatchObject({
      content: '',
      reasoning: { text: 'inspect', totalBytes: 7, hasMore: false },
    });
    listener?.({
      ...projectionUpdate({
        ...streamingMessage,
        content: 'next chunk',
        reasoning: { text: 'inspect more', totalBytes: 12, hasMore: false },
      }),
      streaming: true,
    });
    expect([...controller.getSnapshot().streamingMessageIds]).toEqual([streamingMessage.messageId]);
    expect(controller.getSnapshot().messages.at(-1)).toMatchObject({
      content: 'next chunk',
      reasoning: { text: 'inspect more', totalBytes: 12, hasMore: false },
    });
    listener?.(projectionUpdate({ ...streamingMessage, content: 'final' }));
    expect([...controller.getSnapshot().streamingMessageIds]).toEqual([]);

    await controller.seekToMessage('history-turn', 'history-turn', undefined, {
      expectedRevision: 'revision-stream-state',
    });
    listener?.({ ...projectionUpdate(message('stream-state', 99)), streaming: true });
    expect(controller.getSnapshot().messages.map(item => item.messageId)).toEqual(['history-turn']);
    expect([...controller.getSnapshot().streamingMessageIds]).toEqual([]);
    await controller.start(target('stream-next'));
    expect([...controller.getSnapshot().streamingMessageIds]).toEqual([]);
    controller.stop();
  });

  it('preserves a real compaction focus without synthetic message or turn identities', async () => {
    const getMessageWindowAround = vi.fn(async (request: AgentConversationMessageWindowRequest) => ({
      reset: false as const,
      conversationId: request.conversationId,
      revision: request.expectedRevision,
      focus: {
        kind: 'compaction' as const,
        entry: {
          kind: 'compaction' as const,
          entryId: 'summary-1',
          conversationId: request.conversationId,
          timestamp: 10,
          lamportClock: 10,
          originNodeId: 'node-summary',
          cursor: 'summary-cursor',
          entryIndex: 7,
          turnIndex: 6,
          summaryPreview: 'Earlier work',
          compactedMessageCount: 40,
          compactedTurnCount: 20,
        },
        nearestPosition: 'after' as const,
        nearestMessageId: 'real-message',
        nearestTurnId: 'real-turn',
      },
      recenterAnchor: { messageId: 'real-message', turnId: 'real-turn' },
      items: [{
        ...message(request.conversationId, 20),
        messageId: 'real-message',
        turnId: 'real-turn',
      }],
      hasMoreBefore: true,
      hasMoreAfter: false,
      previousCursor: 'opaque-before-summary',
    }));
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({ getMessageWindowAround }),
    });
    await controller.start(target('compaction'));

    const result = await controller.seekToTimelineEntry(
      'summary-1',
      'summary-cursor',
      { expectedRevision: 'revision-compaction' },
    );

    expect(result).toMatchObject({
      focus: {
        kind: 'compaction',
        entry: { entryId: 'summary-1', kind: 'compaction' },
        nearestTurnId: 'real-turn',
      },
    });
    const focus = result && !result.reset ? result.focus : undefined;
    expect(focus && focus.kind === 'compaction' && 'turnId' in focus.entry).toBe(false);
    expect(focus && focus.kind === 'compaction' && 'messageId' in focus.entry).toBe(false);
    controller.stop();
  });

  it('preserves the resident window and returns a typed stale-seek reset', async () => {
    const getMessagePage = vi.fn()
      .mockResolvedValueOnce(page([message('reset-seek', 1)], false, false))
      .mockResolvedValueOnce(page(
        [message('reset-seek', 99), message('reset-seek', 100)],
        true,
        false,
        'reset-seek',
        'revision-reset-seek',
      ));
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        getMessagePage,
        getMessageWindowAround: async request => ({
          reset: true,
          conversationId: request.conversationId,
          revision: request.expectedRevision,
        }),
      }),
    });
    await controller.start(target('reset-seek'));
    const observed: number[][] = [];
    const unsubscribe = controller.subscribe(snapshot => {
      observed.push(snapshot.messages.map(item => item.originSequence));
    });
    observed.length = 0;

    await expect(controller.seekToMessage('missing-turn', 'missing-turn', undefined, {
      expectedRevision: 'revision-reset-seek',
    })).resolves.toEqual({
      reset: true,
      conversationId: 'reset-seek',
      revision: 'revision-reset-seek',
    });

    expect(observed).toEqual([]);
    expect(controller.getSnapshot().messages.map(item => item.originSequence)).toEqual([1]);
    expect(getMessagePage).toHaveBeenCalledTimes(1);
    unsubscribe();
    controller.stop();
  });

  it('fences stale and externally aborted absolute seeks without snapshot mutation', async () => {
    const first = deferred<Awaited<ReturnType<AgentConversationClient['getMessageWindowAround']>>>();
    const second = deferred<Awaited<ReturnType<AgentConversationClient['getMessageWindowAround']>>>();
    const signals: AbortSignal[] = [];
    const getMessageWindowAround = vi.fn(async (
      _request: AgentConversationMessageWindowRequest,
      options?: AgentManagementCallOptions,
    ) => {
      signals.push(options!.signal!);
      return signals.length === 1 ? first.promise : second.promise;
    });
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({ getMessageWindowAround }),
    });
    await controller.start(target('seek-race'));
    const seekA = controller.seekToMessage('turn-a', 'turn-a', undefined, {
      expectedRevision: 'revision-seek-race',
    });
    const seekB = controller.seekToMessage('turn-b', 'turn-b', undefined, {
      expectedRevision: 'revision-seek-race',
    });
    expect(signals[0]?.aborted).toBe(true);
    second.resolve({
      reset: false,
      conversationId: 'seek-race',
      revision: 'revision-seek-race',
      focus: { kind: 'message', messageId: 'turn-b', turnId: 'turn-b' },
      recenterAnchor: { messageId: 'turn-b', turnId: 'turn-b' },
      items: [{ ...message('seek-race', 2), messageId: 'turn-b', turnId: 'turn-b' }],
      hasMoreBefore: false,
      hasMoreAfter: false,
    });
    await seekB;
    first.resolve({
      reset: false,
      conversationId: 'seek-race',
      revision: 'revision-seek-race',
      focus: { kind: 'message', messageId: 'turn-a', turnId: 'turn-a' },
      recenterAnchor: { messageId: 'turn-a', turnId: 'turn-a' },
      items: [{ ...message('seek-race', 1), messageId: 'turn-a', turnId: 'turn-a' }],
      hasMoreBefore: false,
      hasMoreAfter: false,
    });
    await seekA;
    expect(controller.getSnapshot().messages[0]?.turnId).toBe('turn-b');

    const abort = new AbortController();
    const seekC = controller.seekToMessage('turn-c', 'turn-c', undefined, {
      expectedRevision: 'revision-seek-race',
      signal: abort.signal,
    });
    abort.abort();
    expect(signals[2]?.aborted).toBe(true);
    second.resolve({ reset: true, conversationId: 'seek-race', revision: 'revision-new' });
    await seekC;
    expect(controller.getSnapshot().messages[0]?.turnId).toBe('turn-b');
    expect(controller.getSnapshot().error).toBeNull();
    controller.stop();
  });

  it('propagates an external paging abort without changing the snapshot or error', async () => {
    const older = deferred<AgentConversationMessagePageSuccess>();
    let transportSignal: AbortSignal | undefined;
    const getMessagePage = vi.fn(async (
      conversationId: string,
      options: AgentConversationMessagePageOptions,
      callOptions?: AgentManagementCallOptions,
    ) => {
      if (options.cursor) {
        transportSignal = callOptions?.signal;
        return older.promise;
      }
      return page([message(conversationId, 80)], true, false);
    });
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({ getMessagePage }),
    });
    await controller.start(target('page-abort'));
    const before = controller.getSnapshot();
    const abort = new AbortController();
    const loading = controller.loadMoreBefore(80, { signal: abort.signal });
    expect(controller.getSnapshot()).toMatchObject({
      loadingMoreBefore: true,
      loadingMoreAfter: false,
    });
    abort.abort('caller canceled');
    expect(transportSignal?.aborted).toBe(true);
    older.resolve(page(
      [message('page-abort', 1)],
      false,
      true,
      'page-abort',
      'revision-page-abort',
    ));
    await loading;

    expect(controller.getSnapshot()).toStrictEqual(before);
    expect(controller.getSnapshot().error).toBeNull();
    controller.stop();
  });

  it('forwards an external abort through forward paging without snapshot mutation', async () => {
    const newer = deferred<AgentConversationMessagePageSuccess>();
    let transportSignal: AbortSignal | undefined;
    const getMessagePage = vi.fn(async (
      conversationId: string,
      options: AgentConversationMessagePageOptions,
      callOptions?: AgentManagementCallOptions,
    ) => {
      if (options.cursor) {
        transportSignal = callOptions?.signal;
        return newer.promise;
      }
      return page([message(conversationId, 50)], false, true);
    });
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({ getMessagePage }),
    });
    await controller.start(target('page-after-abort'));
    const before = controller.getSnapshot();
    const abort = new AbortController();
    const loading = controller.loadMoreAfter(80, { signal: abort.signal });
    expect(controller.getSnapshot()).toMatchObject({
      loadingMoreBefore: false,
      loadingMoreAfter: true,
    });
    abort.abort('caller canceled');
    expect(transportSignal?.aborted).toBe(true);
    newer.resolve(page(
      [message('page-after-abort', 51)],
      false,
      false,
      'page-after-abort',
      'revision-page-after-abort',
    ));
    await loading;

    expect(controller.getSnapshot()).toStrictEqual(before);
    expect(controller.getSnapshot().error).toBeNull();
    controller.stop();
  });

  it('clears tombstoned rows immediately and coalesces invalidations into bounded refreshes', async () => {
    const firstRefresh = deferred<AgentConversationMessagePageSuccess>();
    let updateListener: ((update: AgentConversationUpdate) => void) | undefined;
    const getMessagePage = vi.fn()
      .mockResolvedValueOnce(page(
        [message('invalidate', 1), message('invalidate', 2)],
        false,
        false,
        'invalidate',
        'revision-1',
      ))
      .mockImplementationOnce(async () => firstRefresh.promise)
      .mockResolvedValueOnce(page(
        [message('invalidate', 9)],
        false,
        false,
        'invalidate',
        'revision-4',
      ));
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient({
        getMessagePage,
        subscribeToMessages: (_conversationId, listener) => {
          updateListener = listener;
          return () => {};
        },
      }),
    });
    await controller.start(target('invalidate'));

    updateListener?.({
      kind: 'invalidated',
      conversationId: 'invalidate',
      previousRevision: 'revision-1',
      revision: 'revision-2',
      reason: 'tombstone',
    });
    expect(controller.getSnapshot().messages).toEqual([]);
    updateListener?.({
      kind: 'invalidated',
      conversationId: 'invalidate',
      previousRevision: 'revision-2',
      revision: 'revision-3',
      reason: 'compaction',
    });
    updateListener?.({
      kind: 'invalidated',
      conversationId: 'invalidate',
      previousRevision: 'revision-3',
      revision: 'revision-4',
      reason: 'reset',
    });
    expect(getMessagePage).toHaveBeenCalledTimes(2);
    firstRefresh.resolve(page(
      [message('invalidate', 3)],
      false,
      false,
      'invalidate',
      'revision-2',
    ));
    await new Promise(resolve => setTimeout(resolve, 25));

    expect(getMessagePage).toHaveBeenCalledTimes(3);
    expect(controller.getSnapshot().messages.map(item => item.originSequence)).toEqual([9]);
    expect(controller.getSnapshot().revision).toBe('revision-4');
    expect(controller.getSnapshot().error).toBeNull();
    controller.stop();
  });

  it('implements ES2025 readonly-set algebra without exposing the snapshot backing set', () => {
    const controller = new AgentSessionController({
      agentInstanceClient: instanceClient(),
      conversationClient: conversationClient(),
    });
    const values = controller.getSnapshot().streamingMessageIds as ReadonlySet<string> & {
      union<U>(other: ReadonlySet<U>): Set<string | U>;
      intersection<U>(other: ReadonlySet<U>): Set<string & U>;
      difference<U>(other: ReadonlySet<U>): Set<string>;
      symmetricDifference<U>(other: ReadonlySet<U>): Set<string | U>;
      isSubsetOf(other: ReadonlySet<unknown>): boolean;
      isSupersetOf(other: ReadonlySet<unknown>): boolean;
      isDisjointFrom(other: ReadonlySet<unknown>): boolean;
    };
    const union = values.union(new Set(['one', 'two']));
    expect([...union]).toEqual(['one', 'two']);
    expect([...values.intersection(new Set(['one']))]).toEqual([]);
    expect([...values.difference(new Set(['one']))]).toEqual([]);
    expect([...values.symmetricDifference(new Set(['one']))]).toEqual(['one']);
    expect(values.isSubsetOf(new Set(['one']))).toBe(true);
    expect(values.isSupersetOf(new Set())).toBe(true);
    expect(values.isDisjointFrom(new Set(['one']))).toBe(true);
    union.add('mutated-result');
    expect(values.has('mutated-result')).toBe(false);
  });
});
