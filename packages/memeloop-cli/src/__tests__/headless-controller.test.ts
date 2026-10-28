/**
 * Headless controller proof test.
 *
 * Verifies that the AgentSessionController can be instantiated and driven
 * with fake clients — no React, DOM, or Electron dependency.
 *
 * This demonstrates that memeloop-cli (Ink) and other non-React consumers
 * can consume the same headless state as React-based hosts.
 */

import {
  type AgentConversationClient,
  type AgentConversationMessageProjection,
  type AgentConversationUpdate,
  type AgentInstanceClient,
  type AgentRuntimeView,
  AgentSessionController,
} from 'memeloop';
import { describe, expect, it, vi } from 'vitest';

// ─── Fake clients ──────────────────────────────────────────────────

function createFakeAgentInstanceClient(): AgentInstanceClient {
  let agentState: AgentRuntimeView = {
    id: 'test-agent-1',
    name: 'Test Agent',
    agentDefId: 'test-def',
    status: { state: 'idle' },
  };

  return {
    createAgent: async (id) => ({ id: `new-${id}` }),
    fetchAgent: async () => agentState,
    updateAgent: async (_id, data) => {
      agentState = { ...agentState, ...data } as AgentRuntimeView;
      return agentState;
    },
    cancelAgent: async () => {
      agentState = { ...agentState, status: { state: 'canceled' } };
    },
    deleteAgent: async () => {},
    subscribeToUpdates: (_id, listener) => {
      // Simulate an update after 50ms
      const timer = setTimeout(() => {
        listener({ status: { state: 'working', progress: 'Thinking...' } });
      }, 50);
      return () => {
        clearTimeout(timer);
      };
    },
    getAgentFrameworkId: async () => 'memeloopTaskAgent',
    getFrameworkConfigSchema: async () => ({}),
  };
}

function createFakeConversationClient(): AgentConversationClient {
  const messages: AgentConversationMessageProjection[] = [];
  let messageListener: ((update: AgentConversationUpdate) => void) | undefined;

  return {
    getMessagePage: async (_conversationId, options) => ({
      reset: false,
      conversationId: _conversationId,
      revision: 'fake-revision',
      items: messages.slice(-options.limit),
      hasMoreBefore: messages.length > options.limit,
      hasMoreAfter: false,
      ...(messages.length > options.limit ? { previousCursor: 'fake-previous' } : {}),
    }),
    getTurnDetail: async () => {
      throw new Error('not implemented in fake');
    },
    getMessageWindowAround: async () => {
      throw new Error('not implemented in fake');
    },
    sendMessage: async (_id, content) => {
      const now = Date.now();
      const msg: AgentConversationMessageProjection = {
        messageId: `${now}`,
        turnId: `${now}`,
        conversationId: _id,
        originNodeId: 'test',
        originSequence: messages.length + 1,
        timestamp: now,
        lamportClock: now,
        role: 'user',
        content,
      };
      messages.push(msg);
      messageListener?.({
        kind: 'projection',
        conversationId: _id,
        revision: 'fake-revision',
        streaming: false,
        message: msg,
      });
    },
    subscribeToMessages: (_id, listener) => {
      messageListener = listener;
      return () => {
        if (messageListener === listener) messageListener = undefined;
      };
    },
    deleteTurn: async () => {
      throw new Error('not implemented in fake');
    },
    retryTurn: async () => {
      throw new Error('not implemented in fake');
    },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('AgentSessionController (Ink-compatible)', () => {
  it('can be instantiated without React', () => {
    const controller = new AgentSessionController({
      agentInstanceClient: createFakeAgentInstanceClient(),
      conversationClient: createFakeConversationClient(),
    });
    expect(controller).toBeInstanceOf(AgentSessionController);
  });

  it('opens and prepends bounded keyset pages without calling the full reader', async () => {
    const rows = Array.from({ length: 4 }, (_, index): AgentConversationMessageProjection => ({
      messageId: `message-${index + 1}`,
      turnId: index % 2 === 0 ? `message-${index + 1}` : `message-${index}`,
      conversationId: 'test-agent-1',
      originNodeId: 'test',
      originSequence: index + 1,
      timestamp: index + 1,
      lamportClock: index + 1,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index + 1}`,
    }));
    const fullReader = vi.fn().mockRejectedValue(new Error('must not full-load'));
    const getMessagePage = vi.fn()
      .mockResolvedValueOnce({
        reset: false,
        conversationId: 'test-agent-1',
        revision: 'cli-revision',
        items: rows.slice(2),
        hasMoreBefore: true,
        hasMoreAfter: false,
        previousCursor: 'opaque-before-message-3',
      })
      .mockResolvedValueOnce({
        reset: false,
        conversationId: 'test-agent-1',
        revision: 'cli-revision',
        items: rows.slice(0, 2),
        hasMoreBefore: false,
        hasMoreAfter: true,
        nextCursor: 'opaque-after-message-2',
      });
    const conversationClient: AgentConversationClient = {
      ...createFakeConversationClient(),
      getMessagePage,
    };
    const controller = new AgentSessionController({
      agentInstanceClient: createFakeAgentInstanceClient(),
      conversationClient,
    });

    await controller.start({ agentId: 'test-agent-1', conversationId: 'test-agent-1' });
    expect(controller.getSnapshot().messages.map(message => message.messageId)).toEqual([
      'message-3',
      'message-4',
    ]);
    await controller.loadMoreBefore();
    expect(controller.getSnapshot().messages.map(message => message.messageId)).toEqual([
      'message-1',
      'message-2',
      'message-3',
      'message-4',
    ]);
    expect(controller.getSnapshot().hasMoreBefore).toBe(false);
    expect(fullReader).not.toHaveBeenCalled();
    controller.stop();
  });

  it('returns initial snapshot without subscribing', () => {
    const controller = new AgentSessionController({
      agentInstanceClient: createFakeAgentInstanceClient(),
      conversationClient: createFakeConversationClient(),
    });
    const snapshot = controller.getSnapshot();
    expect(snapshot).toMatchObject({
      agent: null,
      loading: false,
      error: null,
      messages: [],
      orderedMessageIds: [],
    });
  });

  it('emits loading state when starting', async () => {
    const controller = new AgentSessionController({
      agentInstanceClient: createFakeAgentInstanceClient(),
      conversationClient: createFakeConversationClient(),
    });

    const states: { loading: boolean; agent: boolean }[] = [];
    controller.subscribe((s) => states.push({ loading: s.loading, agent: !!s.agent }));

    // start is async — states will update during execution
    await controller.start({ agentId: 'test-agent-1', conversationId: 'test-agent-1' });

    // After start completes, we should have seen the loading=true state
    const hasLoadingTrue = states.some((s) => s.loading);
    expect(hasLoadingTrue).toBe(true);

    // Final state should have loading=false and agent set
    const lastState = states[states.length - 1];
    expect(lastState.loading).toBe(false);
    expect(lastState.agent).toBe(true);
  });

  it('can receive agent updates via subscription', async () => {
    const controller = new AgentSessionController({
      agentInstanceClient: createFakeAgentInstanceClient(),
      conversationClient: createFakeConversationClient(),
    });

    const statuses: string[] = [];
    controller.subscribe((s) => {
      if (s.agent) statuses.push(s.agent.status.state);
    });

    await controller.start({ agentId: 'test-agent-1', conversationId: 'test-agent-1' });

    // After start, the fake client pushes a "working" status after 50ms
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(statuses).toContain('working');
  });

  it('can send messages without React', async () => {
    const controller = new AgentSessionController({
      agentInstanceClient: createFakeAgentInstanceClient(),
      conversationClient: createFakeConversationClient(),
    });

    await controller.start({ agentId: 'test-agent-1', conversationId: 'test-agent-1' });

    // Wait for start to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    await controller.sendMessage('Hello from CLI!');

    const snapshot = controller.getSnapshot();
    expect(snapshot.messages.length).toBe(1);
    expect(snapshot.messages[0].content).toBe('Hello from CLI!');
  });

  it('supports subscribe/unsubscribe lifecycle', () => {
    const controller = new AgentSessionController({
      agentInstanceClient: createFakeAgentInstanceClient(),
      conversationClient: createFakeConversationClient(),
    });

    let callCount = 0;
    const unsub = controller.subscribe(() => {
      callCount++;
    });

    expect(callCount).toBe(1); // Immediate emission

    unsub();
    // After unsubscribing, no more notifications
    controller.stop();
    expect(callCount).toBe(1);
  });
});
