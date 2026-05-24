import { describe, expect, it, beforeEach } from "vitest";

import {
  registerSkill,
  getSkill,
  listSkills,
  unregisterSkill,
  clearSkills,
  loadSkillsFromDir,
} from "../registry.js";
import type { SkillDefinition } from "../types.js";
import { BUILTIN_SKILLS } from "../builtins/index.js";

function makeSkill(overrides?: Partial<SkillDefinition>): SkillDefinition {
  return {
    id: "test-skill",
    name: "Test Skill",
    instructions: "You are a test skill.",
    ...overrides,
  };
}

describe("Skill Registry", () => {
  beforeEach(() => {
    clearSkills();
  });

  describe("registerSkill", () => {
    it("registers a valid skill", () => {
      const skill = makeSkill();
      registerSkill(skill);
      expect(getSkill("test-skill")).toBe(skill);
    });

    it("throws for skill with empty id", () => {
      expect(() => registerSkill(makeSkill({ id: "" }))).toThrow(
        /non-empty id/,
      );
    });

    it("throws for skill without a name", () => {
      expect(() => registerSkill(makeSkill({ name: "" }))).toThrow(
        /must have a name/,
      );
    });

    it("throws for skill without instructions", () => {
      expect(() => registerSkill(makeSkill({ instructions: "" }))).toThrow(
        /must have instructions/,
      );
    });

    it("overwrites existing skill with same id", () => {
      const first = makeSkill({ id: "dup", name: "First" });
      const second = makeSkill({ id: "dup", name: "Second" });
      registerSkill(first);
      registerSkill(second);
      expect(getSkill("dup")?.name).toBe("Second");
    });
  });

  describe("getSkill", () => {
    it("returns undefined for unknown skill", () => {
      expect(getSkill("nonexistent")).toBeUndefined();
    });

    it("returns the registered skill", () => {
      const skill = makeSkill({ id: "my-skill" });
      registerSkill(skill);
      expect(getSkill("my-skill")).toEqual(skill);
    });
  });

  describe("listSkills", () => {
    it("returns empty list initially", () => {
      expect(listSkills()).toEqual([]);
    });

    it("returns all registered skills", () => {
      registerSkill(makeSkill({ id: "a" }));
      registerSkill(makeSkill({ id: "b" }));
      expect(listSkills()).toHaveLength(2);
    });
  });

  describe("unregisterSkill", () => {
    it("removes a registered skill", () => {
      registerSkill(makeSkill({ id: "to-remove" }));
      expect(unregisterSkill("to-remove")).toBe(true);
      expect(getSkill("to-remove")).toBeUndefined();
    });

    it("returns false for unknown skill", () => {
      expect(unregisterSkill("unknown")).toBe(false);
    });
  });

  describe("clearSkills", () => {
    it("removes all skills", () => {
      registerSkill(makeSkill({ id: "a" }));
      registerSkill(makeSkill({ id: "b" }));
      clearSkills();
      expect(listSkills()).toEqual([]);
    });
  });

  describe("loadSkillsFromDir", () => {
    it("does not throw for non-existent directory", () => {
      expect(() =>
        loadSkillsFromDir("/tmp/memeloop-test-nonexistent-dir"),
      ).not.toThrow();
    });

    it("does not throw for file path instead of directory", () => {
      // Just smoke test — should handle gracefully
      expect(() =>
        loadSkillsFromDir(__filename),
      ).not.toThrow();
    });
  });
});

describe("Built-in Skills", () => {
  it("has 3 built-in skills", () => {
    expect(BUILTIN_SKILLS).toHaveLength(3);
  });

  it("all built-in skills have required fields", () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.id).toBeTruthy();
      expect(skill.name).toBeTruthy();
      expect(skill.instructions).toBeTruthy();
      expect(skill.instructions.length).toBeGreaterThan(50);
    }
  });

  it("all built-in skills have unique ids", () => {
    const ids = BUILTIN_SKILLS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes frontend-ui-ux skill", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.id === "frontend-ui-ux");
    expect(skill).toBeDefined();
    expect(skill?.name).toBe("Frontend UI/UX");
    expect(skill?.instructions).toContain("designer-turned-developer");
  });

  it("includes git-master skill", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.id === "git-master");
    expect(skill).toBeDefined();
    expect(skill?.name).toBe("Git Master");
    expect(skill?.instructions).toContain("Git Safety Protocol");
  });

  it("includes playwright skill", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.id === "playwright");
    expect(skill).toBeDefined();
    expect(skill?.name).toBe("Playwright");
    expect(skill?.instructions).toContain("Playwright for browser automation");
  });

  it("all built-in skills can be registered without error", () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(() => registerSkill(skill)).not.toThrow();
    }
  });
});
