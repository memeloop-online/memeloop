import { describe, expect, it, vi } from "vitest";

import { responseConcat } from "../responseConcat.js";

describe("responseConcat", () => {
  it("returns llmResponse when responses stay empty", async () => {
    const r = await responseConcat(
      { response: [] },
      "RAW",
      { tools: { getPromptPlugins: () => new Map() } } as any,
      [],
    );
    expect(r.processedResponse).toBe("RAW");
  });

  it("filters disabled responses and trims/join with blank lines", async () => {
    const plugin = (hooks: any) => {
      hooks.postProcess.tapAsync("t", (ctx: any, cb: () => void) => {
        ctx.responses.push({ text: "A", enabled: true });
        ctx.responses.push({ text: "B", enabled: false });
        ctx.responses.push({ text: "C", enabled: true });
        cb();
      });
    };
    const r = await responseConcat(
      { plugins: [{ toolId: "p1", enabled: true }] as any, response: [] },
      "RAW",
      { tools: { getPromptPlugins: () => new Map([["p1", plugin]]) } } as any,
      [],
    );
    expect(r.processedResponse).toBe("A\n\nC");
  });

  it("runs only enabled plugins and propagates yieldNextRoundTo/toolCallInfo", async () => {
    const plugin = vi.fn((hooks: any) => {
      hooks.postProcess.tapAsync("t", (ctx: any, cb: () => void) => {
        ctx.actions.yieldNextRoundTo = { kind: "tool", toolId: "x" };
        ctx.actions.toolCalling = { kind: "xml", toolName: "t", parameters: { a: 1 } } as any;
        ctx.responses.push({ text: "ok", enabled: true });
        cb();
      });
    });

    const r = await responseConcat(
      {
        plugins: [
          { toolId: "p1", enabled: true },
          { toolId: "p2", enabled: false },
        ] as any,
        response: [],
      },
      "RAW",
      { tools: { getPromptPlugins: () => new Map([["p1", plugin]]) } } as any,
      [],
    );
    expect(plugin).toHaveBeenCalledTimes(1);
    expect(r.yieldNextRoundTo).toBeTruthy();
    expect(r.toolCallInfo).toBeTruthy();
    expect(r.processedResponse).toBe("ok");
  });
});
