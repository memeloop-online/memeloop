import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MemeLoopRuntime } from "memeloop";
import { AcpSessionManager, resetSessionCounter } from "../sessionManager.js";

function mockRuntime(overrides: Partial<MemeLoopRuntime> = {}): MemeLoopRuntime {
  return {
    createAgent: vi.fn().mockResolvedValue({ conversationId: "conv-abc" }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    cancelAgent: vi.fn().mockResolvedValue(undefined),
    subscribeToUpdates: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

describe("acp/sessionManager", () => {
  beforeEach(() => {
    resetSessionCounter(1);
  });

  describe("createSession", () => {
    it("creates a session with default agent", async () => {
      const runtime = mockRuntime();
      const manager = new AcpSessionManager(runtime);

      const info = await manager.createSession();

      expect(info.sessionId).toBe("acp-1");
      expect(info.agentId).toBe("memeloop:general-assistant");
      expect(info.conversationId).toBe("conv-abc");
      expect(info.status).toBe("active");
      expect(info.messageCount).toBe(0);
      expect(runtime.createAgent).toHaveBeenCalledWith({
        definitionId: "memeloop:general-assistant",
        initialMessage: undefined,
      });
    });

    it("creates a session with custom agent ID", async () => {
      const runtime = mockRuntime();
      const manager = new AcpSessionManager(runtime);

      const info = await manager.createSession("custom-agent", "resume-checkpoint");

      expect(info.agentId).toBe("custom-agent");
      expect(runtime.createAgent).toHaveBeenCalledWith({
        definitionId: "custom-agent",
        initialMessage: undefined,
      });
    });

    it("increments session IDs", async () => {
      const runtime = mockRuntime();
      const manager = new AcpSessionManager(runtime);

      const a = await manager.createSession();
      const b = await manager.createSession();

      expect(a.sessionId).toBe("acp-1");
      expect(b.sessionId).toBe("acp-2");
    });
  });

  describe("getSession", () => {
    it("returns session info for existing session", async () => {
      const runtime = mockRuntime();
      const manager = new AcpSessionManager(runtime);
      await manager.createSession("agent-x");

      const info = manager.getSession("acp-1");
      expect(info).not.toBeNull();
      expect(info!.agentId).toBe("agent-x");
    });

    it("returns null for unknown session", () => {
      const runtime = mockRuntime();
      const manager = new AcpSessionManager(runtime);

      expect(manager.getSession("nonexistent")).toBeNull();
    });
  });

  describe("listSessions", () => {
    it("returns empty list initially", () => {
      const runtime = mockRuntime();
      const manager = new AcpSessionManager(runtime);

      expect(manager.listSessions()).toEqual([]);
    });

    it("returns all created sessions", async () => {
      const runtime = mockRuntime();
      const manager = new AcpSessionManager(runtime);
      await manager.createSession("a");
      await manager.createSession("b");

      const list = manager.listSessions();
      expect(list).toHaveLength(2);
      expect(list.map((s) => s.sessionId)).toEqual(["acp-1", "acp-2"]);
    });
  });

  describe("cancelSession", () => {
    it("cancels an active session", async () => {
      const runtime = mockRuntime();
      const manager = new AcpSessionManager(runtime);
      await manager.createSession();

      const result = await manager.cancelSession("acp-1");
      expect(result).toBe(true);
      expect(runtime.cancelAgent).toHaveBeenCalledWith("conv-abc");
    });

    it("returns false for unknown session", async () => {
      const runtime = mockRuntime();
      const manager = new AcpSessionManager(runtime);

      const result = await manager.cancelSession("nonexistent");
      expect(result).toBe(false);
      expect(runtime.cancelAgent).not.toHaveBeenCalled();
    });
  });

  describe("sendPrompt", () => {
    it("throws for unknown session", async () => {
      const runtime = mockRuntime();
      const manager = new AcpSessionManager(runtime);

      const iterator = manager.sendPrompt("nonexistent", "hello");
      await expect(iterator.next()).rejects.toThrow("Session not found");
    });

    it("throws for non-active session", async () => {
      const runtime = mockRuntime();
      const manager = new AcpSessionManager(runtime);
      await manager.createSession();
      await manager.cancelSession("acp-1");

      const iterator = manager.sendPrompt("acp-1", "hello");
      await expect(iterator.next()).rejects.toThrow("is cancelled");
    });

    it("calls sendMessage on the runtime", async () => {
      const runtime = mockRuntime();
      const manager = new AcpSessionManager(runtime);
      await manager.createSession();

      // Set up subscribeToUpdates to signal done immediately
      runtime.subscribeToUpdates = vi.fn().mockImplementation((_cid, cb: (u: unknown) => void) => {
        setImmediate(() => cb({ type: "agent-done" }));
        return () => {};
      });

      const chunks: unknown[] = [];
      for await (const chunk of manager.sendPrompt("acp-1", "hello")) {
        chunks.push(chunk);
      }

      expect(runtime.sendMessage).toHaveBeenCalledWith({
        conversationId: "conv-abc",
        message: "hello",
      });
      expect(chunks).toEqual([]);
    });

    it("yields chunks from agent-step updates", async () => {
      const runtime = mockRuntime();
      const manager = new AcpSessionManager(runtime);
      await manager.createSession();

      const steps: Array<{ type: string; data: unknown }> = [
        { type: "agent-step", step: { type: "thinking", data: "Let me think..." } },
        { type: "agent-step", step: { type: "message", data: "Hello world" } },
        { type: "agent-done" },
      ];
      let stepIndex = 0;

      runtime.subscribeToUpdates = vi.fn().mockImplementation((_cid, cb: (u: unknown) => void) => {
        const sendNext = () => {
          if (stepIndex < steps.length) {
            cb(steps[stepIndex++]);
            if (stepIndex < steps.length) {
              setImmediate(sendNext); // next tick to let the async iterator consume
            }
          }
        };
        sendNext();
        return () => {};
      });

      const chunks: unknown[] = [];
      for await (const chunk of manager.sendPrompt("acp-1", "hello")) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toMatchObject({ type: "thinking", data: "Let me think..." });
      expect(chunks[1]).toMatchObject({ type: "message", data: "Hello world" });
    });

    it("updates message count after streaming", async () => {
      const runtime = mockRuntime();
      const manager = new AcpSessionManager(runtime);
      await manager.createSession();

      runtime.subscribeToUpdates = vi.fn().mockImplementation((_cid, cb: (u: unknown) => void) => {
        setImmediate(() => cb({ type: "agent-step", step: { type: "message", data: "Hi" } }));
        setImmediate(() => cb({ type: "agent-done" }));
        return () => {};
      });

      for await (const _ of manager.sendPrompt("acp-1", "hello")) {
        // drain
      }

      const info = manager.getSession("acp-1");
      expect(info!.messageCount).toBe(1);
    });
  });

  describe("dispose", () => {
    it("clears all sessions", async () => {
      const runtime = mockRuntime();
      const manager = new AcpSessionManager(runtime);
      await manager.createSession();

      manager.dispose();
      expect(manager.listSessions()).toEqual([]);
    });
  });
});
