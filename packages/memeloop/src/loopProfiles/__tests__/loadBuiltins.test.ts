import { describe, expect, it } from "vitest";
import type { LoopProfile } from "../../agentLoops/types.js";

import { getBuiltinLoopProfiles } from "../loadBuiltins.js";

describe("getBuiltinLoopProfiles", () => {
  it("returns built-in loop profiles array", () => {
    const defs = getBuiltinLoopProfiles();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBe(5);
    for (const d of defs) {
      expect(typeof d).toBe("object");
      expect(d).toMatchObject({
        id: expect.any(String) as string,
      });
    }
  });

  it("includes all expected built-in profile ids", () => {
    const defs = getBuiltinLoopProfiles();
    const ids = defs.map((d: LoopProfile) => d.id);
    expect(ids).toContain("memeloop:general-assistant");
    expect(ids).toContain("memeloop:code-assistant");
    expect(ids).toContain("memeloop:frontend-ui-ux");
    expect(ids).toContain("memeloop:git-master");
    expect(ids).toContain("memeloop:playwright");
  });
});
