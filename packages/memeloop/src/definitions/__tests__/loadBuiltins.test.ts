import type { AgentDefinition } from "@memeloop/protocol";
import { describe, expect, it } from "vitest";

import { getBuiltinAgentDefinitions } from "../loadBuiltins.js";

describe("getBuiltinAgentDefinitions", () => {
  it("returns built-in agent definitions array", () => {
    const defs = getBuiltinAgentDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBe(5);
    for (const d of defs) {
      expect(typeof d).toBe("object");
      expect(d).toMatchObject({
        id: expect.any(String) as string,
      });
    }
  });

  it("includes all expected built-in agent ids", () => {
    const defs = getBuiltinAgentDefinitions();
    const ids = defs.map((d: AgentDefinition) => d.id);
    expect(ids).toContain("memeloop:general-assistant");
    expect(ids).toContain("memeloop:code-assistant");
    expect(ids).toContain("memeloop:frontend-ui-ux");
    expect(ids).toContain("memeloop:git-master");
    expect(ids).toContain("memeloop:playwright");
  });
});
