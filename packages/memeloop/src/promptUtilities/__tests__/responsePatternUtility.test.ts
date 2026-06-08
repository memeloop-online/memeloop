import { describe, expect, it } from "vitest";

import { matchAllToolCallings, matchToolCalling } from "../responsePatternUtility.js";

describe("responsePatternUtility", () => {
  it("matchToolCalling parses tool_use JSON body", () => {
    const text = `Hello <tool_use name="wiki-search">{"q":"foo"}</tool_use> tail`;
    const m = matchToolCalling(text);
    expect(m).toEqual({
      found: true,
      toolId: "wiki-search",
      parameters: { q: "foo" },
      originalText: '<tool_use name="wiki-search">{"q":"foo"}</tool_use>',
    });
  });

  it("matchAllToolCallings finds multiple calls and parallel flag", () => {
    const text = `<parallel_tool_calls>
<tool_use name="a">{}</tool_use>
<function_call name="b">{"x":1,}</function_call>
</parallel_tool_calls>`;
    const { calls, parallel } = matchAllToolCallings(text);
    expect(parallel).toBe(true);
    expect(calls.map((c) => c.toolId).sort()).toEqual(["a", "b"]);
  });
});
