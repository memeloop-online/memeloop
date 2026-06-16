import { describe, expect, it } from "vitest";

import { mergeAgentToolsIntoFrameworkConfig } from "../hostAgentTools.js";

describe("mergeAgentToolsIntoFrameworkConfig", () => {
  it("merges agentTools into existing framework plugins without dropping prompt modifiers", () => {
    const config = mergeAgentToolsIntoFrameworkConfig(
      {
        prompts: [{ id: "builtin-system", role: "system", text: "hello" }],
        plugins: [
          { toolId: "fullReplacement" },
          { toolId: "wikiSearch", wikiSearchParam: { sourceType: "old" } },
        ],
        response: [],
      },
      [
        {
          toolId: "wikiSearch",
          parameters: {
            wikiSearchParam: {
              sourceType: "wiki",
              toolListPosition: { targetId: "builtin-system", position: "after" },
            },
          },
        },
        {
          toolId: "modelContextProtocol",
          parameters: {
            modelContextProtocolParam: {
              serverUrl: "http://127.0.0.1:38385/mcp",
            },
          },
        },
      ],
    );

    expect(config.plugins).toEqual([
      { toolId: "fullReplacement" },
      {
        id: "wikiSearch-agent-tool",
        toolId: "wikiSearch",
        enabled: true,
        wikiSearchParam: {
          sourceType: "wiki",
          toolListPosition: { targetId: "builtin-system", position: "after" },
        },
      },
      {
        id: "modelContextProtocol-agent-tool",
        toolId: "modelContextProtocol",
        enabled: true,
        modelContextProtocolParam: {
          serverUrl: "http://127.0.0.1:38385/mcp",
        },
      },
    ]);
  });
});
