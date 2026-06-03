import { beforeEach, describe, expect, it } from "vitest";

import {
  clearSkills,
  getSkill,
  listSkills,
  loadSkillsFromDirectory,
  registerSkill,
  unregisterSkill,
} from "../skillRegistry.js";
import type { SkillDefinition } from "../skillTypes.js";

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
      expect(() => {
        registerSkill(makeSkill({ id: "" }));
      }).toThrow(/non-empty id/);
    });

    it("throws for skill without a name", () => {
      expect(() => {
        registerSkill(makeSkill({ name: "" }));
      }).toThrow(/must have a name/);
    });

    it("throws for skill without instructions", () => {
      expect(() => {
        registerSkill(makeSkill({ instructions: "" }));
      }).toThrow(/must have instructions/);
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

  describe("loadSkillsFromDirectory", () => {
    it("does not throw for non-existent directory", () => {
      expect(() => {
        loadSkillsFromDirectory("/tmp/memeloop-test-nonexistent-dir");
      }).not.toThrow();
    });

    it("does not throw for file path instead of directory", () => {
      // Just smoke test — should handle gracefully
      expect(() => {
        loadSkillsFromDirectory(__filename);
      }).not.toThrow();
    });
  });
});
