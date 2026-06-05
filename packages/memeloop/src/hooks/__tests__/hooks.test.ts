import { describe, expect, it, beforeEach } from "vitest";

import {
  registerHook,
  unregisterHook,
  executeHooks,
  hasHooks,
  clearHooks,
  listRegisteredHookTypes,
  getHookCount,
} from "../registry.js";
import type { HookContext } from "../types.js";

function makeContext(): HookContext {
  return {
    storage: {} as never,
    llmProvider: {} as never,
    tools: {} as never,
    syncAdapters: [],
    network: {} as never,
  };
}

describe("Hook Registry", () => {
  beforeEach(() => {
    clearHooks();
  });

  describe("registerHook", () => {
    it("registers a hook handler", () => {
      registerHook("PreToolUse", async () => ({ allowed: true }));
      expect(getHookCount("PreToolUse")).toBe(1);
    });

    it("registers multiple handlers for the same type", () => {
      registerHook("PreToolUse", async () => ({ allowed: true }));
      registerHook("PreToolUse", async () => ({ allowed: true }));
      expect(getHookCount("PreToolUse")).toBe(2);
    });

    it("supports named registration", () => {
      registerHook("PreToolUse", async () => ({ allowed: true }), "my-hook");
      expect(getHookCount("PreToolUse")).toBe(1);
    });

    it("allows duplicate names (overwrites)", () => {
      const handler1 = async () => ({ allowed: true });
      const handler2 = async () => ({ allowed: false, reason: "blocked" });
      registerHook("PreToolUse", handler1, "the-same");
      registerHook("PreToolUse", handler2, "the-same");
      expect(getHookCount("PreToolUse")).toBe(1);
    });
  });

  describe("unregisterHook", () => {
    it("removes a named hook", () => {
      registerHook("PreToolUse", async () => ({ allowed: true }), "named");
      expect(unregisterHook("PreToolUse", "named")).toBe(true);
      expect(getHookCount("PreToolUse")).toBe(0);
    });

    it("returns false for non-existent hook", () => {
      expect(unregisterHook("PreToolUse", "nonexistent")).toBe(false);
    });

    it("returns false when type has no hooks", () => {
      expect(unregisterHook("PreToolUse", "any")).toBe(false);
    });
  });

  describe("executeHooks", () => {
    it("returns allowed when no hooks registered", async () => {
      const result = await executeHooks("PreToolUse", makeContext(), {});
      expect(result).toEqual({ allowed: true });
    });

    it("executes all hooks in registration order", async () => {
      const calls: string[] = [];
      registerHook("PreToolUse", async () => {
        calls.push("first");
        return { allowed: true };
      });
      registerHook("PreToolUse", async () => {
        calls.push("second");
        return { allowed: true };
      });
      await executeHooks("PreToolUse", makeContext(), {});
      expect(calls).toEqual(["first", "second"]);
    });

    it("stops at first denial", async () => {
      const calls: string[] = [];
      registerHook("PreToolUse", async () => {
        calls.push("first");
        return { allowed: false, reason: "denied" };
      });
      registerHook("PreToolUse", async () => {
        calls.push("second");
        return { allowed: true };
      });
      const result = await executeHooks("PreToolUse", makeContext(), {});
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("denied");
      expect(calls).toEqual(["first"]); // second never called
    });

    it("passes context and data to handlers", async () => {
      let receivedCtx: HookContext | null = null;
      let receivedData: Record<string, unknown> | null = null;
      const ctx = makeContext();
      const data = { toolId: "test-tool", parameters: { x: 1 } };
      registerHook("PreToolUse", async (c, d) => {
        receivedCtx = c;
        receivedData = d;
        return { allowed: true };
      });
      await executeHooks("PreToolUse", ctx, data);
      expect(receivedCtx).toBe(ctx);
      expect(receivedData).toEqual(data);
    });

    it("passes modified data to later hooks and returns the merged result", async () => {
      let receivedData: Record<string, unknown> | null = null;
      registerHook("PreToolUse", async () => ({
        allowed: true,
        modified: { parameters: { x: 2 } },
      }));
      registerHook("PreToolUse", async (_c, d) => {
        receivedData = d;
        return { allowed: true, permissionAction: "ask" };
      });

      const result = await executeHooks("PreToolUse", makeContext(), {
        toolId: "test-tool",
        parameters: { x: 1 },
      });
      expect(receivedData).toMatchObject({ parameters: { x: 2 } });
      expect(result).toMatchObject({
        allowed: true,
        modified: { parameters: { x: 2 } },
        permissionAction: "ask",
      });
    });

    it("treats thrown errors as denial", async () => {
      registerHook("PreToolUse", async () => {
        throw new Error("hook exploded");
      });
      const result = await executeHooks("PreToolUse", makeContext(), {});
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("hook exploded");
    });

    it("executes all hook types independently", async () => {
      const preCalls: string[] = [];
      const postCalls: string[] = [];
      registerHook("PreToolUse", async () => {
        preCalls.push("pre");
        return { allowed: true };
      });
      registerHook("PostToolUse", async () => {
        postCalls.push("post");
        return { allowed: true };
      });
      await executeHooks("PreToolUse", makeContext(), {});
      await executeHooks("PostToolUse", makeContext(), {});
      expect(preCalls).toEqual(["pre"]);
      expect(postCalls).toEqual(["post"]);
    });
  });

  describe("hasHooks", () => {
    it("returns false when no hooks registered", () => {
      expect(hasHooks("PreToolUse")).toBe(false);
    });

    it("returns true after registration", () => {
      registerHook("PreToolUse", async () => ({ allowed: true }));
      expect(hasHooks("PreToolUse")).toBe(true);
    });
  });

  describe("clearHooks", () => {
    it("removes all hooks of all types", () => {
      registerHook("PreToolUse", async () => ({ allowed: true }));
      registerHook("PostToolUse", async () => ({ allowed: true }));
      registerHook("UserPromptSubmit", async () => ({ allowed: true }));
      clearHooks();
      expect(getHookCount("PreToolUse")).toBe(0);
      expect(getHookCount("PostToolUse")).toBe(0);
      expect(getHookCount("UserPromptSubmit")).toBe(0);
    });
  });

  describe("listRegisteredHookTypes", () => {
    it("returns empty when no hooks", () => {
      expect(listRegisteredHookTypes()).toEqual([]);
    });

    it("returns types with registered hooks", () => {
      registerHook("PreToolUse", async () => ({ allowed: true }));
      registerHook("PostToolUse", async () => ({ allowed: true }));
      const types = listRegisteredHookTypes();
      expect(types).toContain("PreToolUse");
      expect(types).toContain("PostToolUse");
    });
  });

  describe("getHookCount", () => {
    it("returns 0 for types with no hooks", () => {
      expect(getHookCount("AgentStart")).toBe(0);
    });

    it("returns the correct count", () => {
      registerHook("PreToolUse", async () => ({ allowed: true }));
      registerHook("PreToolUse", async () => ({ allowed: true }));
      registerHook("PreToolUse", async () => ({ allowed: true }));
      expect(getHookCount("PreToolUse")).toBe(3);
    });
  });
});
