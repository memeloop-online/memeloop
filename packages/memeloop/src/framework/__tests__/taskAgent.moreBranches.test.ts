import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { clearHooks, registerHook } from "../../hooks/registry.js";
import { defineTool } from "../../tools/defineTool.js";
import type {
  AgentFrameworkContext,
  IAgentStorage,
  ILLMProvider,
  IToolRegistry,
} from "../../types.js";
import { createTaskAgent } from "../taskAgent.js";

function makeStorage(log: any[]) {
  const storage: IAgentStorage = {
    listConversations: vi.fn().mockResolvedValue([]),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    getMessages: vi.fn().mockImplementation(async () => [...log]),
    appendMessage: vi.fn().mockImplementation(async (m) => {
      log.push(m);
    }),
    upsertConversationMetadata: vi.fn().mockResolvedValue(undefined),
    insertMessagesIfAbsent: vi.fn().mockResolvedValue(undefined),
    getAttachment: vi.fn().mockResolvedValue(null),
    saveAttachment: vi.fn().mockResolvedValue(undefined),
    getAgentDefinition: vi.fn().mockResolvedValue(null),
    saveAgentInstance: vi.fn().mockResolvedValue(undefined),
    getConversationMeta: vi.fn().mockResolvedValue(null),
  };
  return storage;
}

function makeContext(log: any[], llmChat: ILLMProvider["chat"], tools?: Partial<IToolRegistry>) {
  const context: AgentFrameworkContext = {
    storage: makeStorage(log),
    llmProvider: { name: "mock", chat: llmChat },
    tools: {
      registerTool: vi.fn(),
      getTool: vi.fn().mockReturnValue(async () => ({ result: "registry-ok" })),
      listTools: vi.fn().mockReturnValue(["echo"]),
      ...tools,
    } as any,
    syncAdapters: [],
    network: {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    },
  };
  return context;
}

describe("taskAgent more branch cases", () => {
  afterEach(() => {
    clearHooks();
  });

  it("plugin executes tool -> pending empty but calls non-empty => continues to next LLM round", async () => {
    defineTool({
      toolId: "plugin-echo",
      displayName: "Plugin Echo",
      description: "handles tool call",
      configSchema: z.object({}),
      llmToolSchemas: { echo: z.object({ text: z.string() }) },
      async onResponseComplete(ctx) {
        await ctx.executeToolCall("echo", async (p) => ({ success: true, data: `p:${p.text}` }));
      },
    });

    let round = 0;
    const log: any[] = [];
    const context = makeContext(log, async function* () {
      round += 1;
      if (round === 1) yield '<tool_use name="echo">{"text":"hi"}</tool_use>';
      else yield "final";
    });
    context.resolveAgentDefinition = () =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      Promise.resolve({
        id: "d1",
        agentFrameworkConfig: {
          prompts: [],
          plugins: [{ toolId: "plugin-echo", id: "p1", "plugin-echoParam": {} }],
        },
      }) as any;
    context.taskAgent = { maxIterations: 4 };

    for await (const _ of createTaskAgent(context)({ conversationId: "d1:c1", message: "u" })) {
      /* drain */
    }
    expect(round).toBe(2);
    expect(log.some((m) => m.role === "tool" && String(m.content).includes("p:hi"))).toBe(true);
  });

  it("hasPlugins + pending>0 but fallbackRegistryTools=false => continues and hits max-iterations", async () => {
    defineTool({
      toolId: "plugin-noop",
      displayName: "Plugin Noop",
      description: "does not handle tool calls",
      configSchema: z.object({}),
      async onResponseComplete() {
        /* noop */
      },
    });
    const log: any[] = [];
    const context = makeContext(log, async function* () {
      yield '<tool_use name="echo">{"x":1}</tool_use>';
    });
    context.resolveAgentDefinition = () =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      Promise.resolve({
        id: "d1",
        agentFrameworkConfig: {
          prompts: [],
          plugins: [{ toolId: "plugin-noop", id: "p1", "plugin-noopParam": {} }],
        },
      }) as any;
    context.taskAgent = { maxIterations: 1, fallbackRegistryTools: false };

    const steps: any[] = [];
    for await (const s of createTaskAgent(context)({ conversationId: "d1:c2", message: "u" }))
      steps.push(s);
    expect(steps.some((s) => s.type === "thinking" && s.data?.status === "max-iterations")).toBe(
      true,
    );
    expect(log.some((m) => m.role === "tool")).toBe(false);
  });

  it("calls present but enableToolLoop=false => returns without executing tool", async () => {
    const log: any[] = [];
    const context = makeContext(log, async function* () {
      yield '<tool_use name="echo">{"x":1}</tool_use>';
    });
    context.taskAgent = { maxIterations: 2, enableToolLoop: false };

    for await (const _ of createTaskAgent(context)({ conversationId: "c3", message: "u" })) {
      /* drain */
    }
    expect(log.some((m) => m.role === "tool")).toBe(false);
  });

  it("no tool calls => returns; also covers inferDefinitionId no-colon fallback", async () => {
    const log: any[] = [];
    const storage = makeStorage(log);
    (storage.getConversationMeta as any).mockResolvedValue(null);
    const llmProvider: ILLMProvider = {
      name: "mock",
      async *chat() {
        yield "plain answer";
      },
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
      network: {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      taskAgent: { maxIterations: 2 },
    };
    for await (const _ of createTaskAgent(context)({ conversationId: "noColon", message: "u" })) {
      /* drain */
    }
    expect(log.some((m) => m.role === "assistant" && m.content.includes("plain answer"))).toBe(
      true,
    );
  });

  it("contextCompaction branches affect llm request messages", async () => {
    const now = Date.now();
    const history = Array.from({ length: 6 }).map((_, i) => ({
      messageId: `m${i}`,
      conversationId: "c",
      originNodeId: "local",
      timestamp: now + i,
      lamportClock: i,
      role: i === 0 ? "user" : "assistant",
      content: `t${i}`,
    }));
    // First run: replayLastUserMessage === false => just tail
    {
      const log: any[] = [...history];
      const seen: any[] = [];
      const context = makeContext(log, async function* (req: any) {
        seen.push(req);
        yield "done";
      });
      context.taskAgent = {
        maxIterations: 1,
        contextCompaction: { maxMessages: 3, replayLastUserMessage: false },
      } as any;
      for await (const _ of createTaskAgent(context)({ conversationId: "c", message: "u" })) {
        /* drain */
      }
      expect(seen[0].messages.length).toBe(3);
    }

    // Second run: force a 2nd iteration so last message is tool/assistant and lastUser may be outside tail.
    {
      let round = 0;
      const seen2: any[] = [];
      const context2 = makeContext([...history], async function* (req: any) {
        seen2.push(req);
        round += 1;
        if (round === 1) {
          yield '<tool_use name="echo">{"x":1}</tool_use>';
        } else {
          yield "final";
        }
      });
      context2.taskAgent = { maxIterations: 3, contextCompaction: { maxMessages: 2 } } as any;
      for await (const _ of createTaskAgent(context2)({ conversationId: "c", message: "u" })) {
        /* drain */
      }
      expect(seen2.length).toBeGreaterThanOrEqual(2);
      expect(String(seen2[1].messages[0].content)).toContain("[context-summary]");
    }

    // 注意：taskAgent 每次调用都会先 append 一条 user 消息，因此“完全没有 user 消息”的分支在集成路径下不可达。
  });

  it("ContextCompaction hook can replace history and skip built-in compaction", async () => {
    const now = Date.now();
    const history = Array.from({ length: 8 }).map((_, i) => ({
      messageId: `hook-m${i}`,
      conversationId: "hook-compact",
      originNodeId: "local",
      timestamp: now + i,
      lamportClock: i,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `original-${i}`,
    }));
    const replacement = {
      messageId: "hook-replacement",
      conversationId: "hook-compact",
      originNodeId: "plugin",
      timestamp: now + 100,
      lamportClock: 100,
      role: "assistant" as const,
      content: "plugin-managed compacted history",
    };
    const seen: any[] = [];
    const context = makeContext([...history], async function* (req: any) {
      seen.push(req);
      yield "done";
    });
    context.taskAgent = {
      maxIterations: 1,
      autoCompact: { threshold: 1 },
      contextCompaction: { maxMessages: 1 },
    } as any;
    registerHook("ContextCompaction", async (_ctx, data) => {
      expect(data.conversationId).toBe("hook-compact");
      expect(data.history).toHaveLength(history.length + 1);
      return {
        allowed: true,
        modified: {
          history: [replacement],
          skipDefault: true,
          compacted: true,
          droppedCount: history.length,
          summaryText: replacement.content,
        },
      };
    });

    const steps: any[] = [];
    for await (const step of createTaskAgent(context)({
      conversationId: "hook-compact",
      message: "u",
    })) {
      steps.push(step);
    }

    expect(seen[0].messages).toEqual([{ role: "assistant", content: replacement.content }]);
    expect(steps.some((s) => s.type === "thinking" && s.data?.status === "compacted")).toBe(true);
    expect(context.storage.appendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "hook-replacement" }),
    );
  });
});
