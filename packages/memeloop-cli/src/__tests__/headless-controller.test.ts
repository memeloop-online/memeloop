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
  AgentSessionController,
  type AgentConversationClient,
  type AgentInstanceClient,
  type AgentRuntimeView,
  type ChatMessage,
} from "memeloop";
import { describe, expect, it } from "vitest";

// ─── Fake clients ──────────────────────────────────────────────────

function createFakeAgentInstanceClient(): AgentInstanceClient {
  let agentState: AgentRuntimeView = {
    id: "test-agent-1",
    name: "Test Agent",
    agentDefId: "test-def",
    status: { state: "idle" },
  };

  return {
    createAgent: async (id) => ({ id: `new-${id}` }),
    fetchAgent: async () => agentState,
    updateAgent: async (_id, data) => {
      agentState = { ...agentState, ...data } as AgentRuntimeView;
      return agentState;
    },
    cancelAgent: async () => {
      agentState = { ...agentState, status: { state: "canceled" } };
    },
    deleteAgent: async () => {},
    subscribeToUpdates: (_id, listener) => {
      // Simulate an update after 50ms
      const timer = setTimeout(() => {
        listener({ status: { state: "working", progress: "Thinking..." } });
      }, 50);
      return () => clearTimeout(timer);
    },
    getAgentFrameworkId: async () => "memeloopTaskAgent",
    getFrameworkConfigSchema: async () => ({}),
  };
}

function createFakeConversationClient(): AgentConversationClient {
  const messages: ChatMessage[] = [];

  return {
    getMessages: async () => messages,
    sendMessage: async (_id, content) => {
      const now = Date.now();
      const msg: ChatMessage = {
        messageId: `${now}`,
        conversationId: _id,
        originNodeId: "test",
        timestamp: now,
        lamportClock: now,
        role: "user",
        content,
      };
      messages.push(msg);
    },
    subscribeToMessages: (_id, listener) => {
      return () => {};
    },
    deleteTurn: async (userMessageId) => {
      const idx = messages.findIndex((m) => m.messageId === userMessageId);
      if (idx >= 0) {
        const content = messages[idx].content;
        messages.splice(idx);
        return content;
      }
      return undefined;
    },
    retryTurn: async (userMessageId) => {
      const msg = messages.find((m) => m.messageId === userMessageId);
      if (msg) {
        messages.push({ ...msg, messageId: `${Date.now()}`, timestamp: Date.now(), lamportClock: Date.now() });
      }
    },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("AgentSessionController (Ink-compatible)", () => {
  it("can be instantiated without React", () => {
    const controller = new AgentSessionController({
      agentInstanceClient: createFakeAgentInstanceClient(),
      conversationClient: createFakeConversationClient(),
    });
    expect(controller).toBeInstanceOf(AgentSessionController);
  });

  it("returns initial snapshot without subscribing", () => {
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

  it("emits loading state when starting", async () => {
    const controller = new AgentSessionController({
      agentInstanceClient: createFakeAgentInstanceClient(),
      conversationClient: createFakeConversationClient(),
    });

    const states: { loading: boolean; agent: boolean }[] = [];
    controller.subscribe((s) => states.push({ loading: s.loading, agent: !!s.agent }));

    // start is async — states will update during execution
    await controller.start("test-agent-1");

    // After start completes, we should have seen the loading=true state
    const hasLoadingTrue = states.some((s) => s.loading === true);
    expect(hasLoadingTrue).toBe(true);

    // Final state should have loading=false and agent set
    const lastState = states[states.length - 1];
    expect(lastState.loading).toBe(false);
    expect(lastState.agent).toBe(true);
  });

  it("can receive agent updates via subscription", async () => {
    const controller = new AgentSessionController({
      agentInstanceClient: createFakeAgentInstanceClient(),
      conversationClient: createFakeConversationClient(),
    });

    const statuses: string[] = [];
    controller.subscribe((s) => {
      if (s.agent) statuses.push(s.agent.status.state);
    });

    await controller.start("test-agent-1");

    // After start, the fake client pushes a "working" status after 50ms
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(statuses).toContain("working");
  });

  it("can send messages without React", async () => {
    const controller = new AgentSessionController({
      agentInstanceClient: createFakeAgentInstanceClient(),
      conversationClient: createFakeConversationClient(),
    });

    await controller.start("test-agent-1");

    // Wait for start to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    await controller.sendMessage("Hello from CLI!");

    const snapshot = controller.getSnapshot();
    expect(snapshot.messages.length).toBe(1);
    expect(snapshot.messages[0].content).toBe("Hello from CLI!");
  });

  it("supports subscribe/unsubscribe lifecycle", () => {
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
