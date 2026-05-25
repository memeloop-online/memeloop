import { describe, expect, it, beforeEach } from "vitest";

import {
  AgentRegistry,
  getAgentRegistry,
  resetAgentRegistry,
} from "../agentRegistry.js";
import type { AgentRegistryEntry } from "../agentTypes.js";
import {
  buildAgent,
  planAgent,
  exploreAgent,
  oracleAgent,
  librarianAgent,
  PREDEFINED_AGENTS,
} from "../agentTypes.js";

function makeTestDef(overrides?: Partial<AgentRegistryEntry>): AgentRegistryEntry {
  return {
    id: "test:custom",
    name: "Custom Test Agent",
    type: "build",
    prompt: "You are a test agent.",
    permissions: { default: "allow", rules: [] },
    protocolDef: {
      id: "test:custom",
      name: "Custom Test Agent",
      description: "Test agent",
      systemPrompt: "You are a test agent.",
      tools: [],
      version: "1.0.0",
    },
    ...overrides,
  };
}

describe("AgentRegistry", () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    resetAgentRegistry();
    registry = new AgentRegistry();
  });

  it("is pre-seeded with built-in agent definitions", () => {
    const agents = registry.listAgents();
    expect(agents.length).toBe(5);
    expect(agents.map((a) => a.id)).toEqual([
      "memeloop:build",
      "memeloop:plan",
      "memeloop:explore",
      "memeloop:oracle",
      "memeloop:librarian",
    ]);
  });

  it("can register a new agent definition", () => {
    const def = makeTestDef();
    registry.registerAgent(def);
    expect(registry.listAgents().length).toBe(6);
    expect(registry.getAgent("test:custom")).toBe(def);
  });

  it("can override an existing agent definition", () => {
    const updated: AgentRegistryEntry = {
      ...buildAgent,
      prompt: "Updated build agent prompt.",
    };
    registry.registerAgent(updated);
    const found = registry.getAgent("memeloop:build");
    expect(found?.prompt).toBe("Updated build agent prompt.");
  });

  it("throws when registering an agent with empty id", () => {
    expect(() => registry.registerAgent(makeTestDef({ id: "" }))).toThrow(
      /non-empty id/,
    );
  });

  it("throws when registering an agent without a name", () => {
    expect(() =>
      registry.registerAgent(makeTestDef({ name: "" })),
    ).toThrow(/must have a name/);
  });

  it("throws when registering an agent without a type", () => {
    expect(() =>
      registry.registerAgent(makeTestDef({ type: "" as never })),
    ).toThrow(/must have a type/);
  });

  it("throws when registering an agent without a prompt", () => {
    expect(() =>
      registry.registerAgent(makeTestDef({ prompt: "" })),
    ).toThrow(/must have a prompt/);
  });

  it("getAgent returns undefined for non-existent agent", () => {
    expect(registry.getAgent("nonexistent")).toBeUndefined();
  });

  it("listAgentsByType filters agents by type", () => {
    const oracleAgents = registry.listAgentsByType("oracle");
    expect(oracleAgents.length).toBe(1);
    expect(oracleAgents[0]?.id).toBe("memeloop:oracle");
  });

  it("unregisterAgent removes an agent", () => {
    expect(registry.unregisterAgent("memeloop:build")).toBe(true);
    expect(registry.getAgent("memeloop:build")).toBeUndefined();
    expect(registry.listAgents().length).toBe(4);
  });

  it("unregisterAgent returns false for unknown agent", () => {
    expect(registry.unregisterAgent("nonexistent")).toBe(false);
  });

  it("reset clears all custom agents and restores defaults", () => {
    const def = makeTestDef();
    registry.registerAgent(def);
    expect(registry.listAgents().length).toBe(6);
    registry.reset();
    expect(registry.listAgents().length).toBe(5);
    expect(registry.getAgent("test:custom")).toBeUndefined();
  });
});

describe("getAgentRegistry (singleton)", () => {
  beforeEach(() => {
    resetAgentRegistry();
  });

  it("returns the same instance on repeated calls", () => {
    const a = getAgentRegistry();
    const b = getAgentRegistry();
    expect(a).toBe(b);
  });

  it("starts with built-in agents", () => {
    const reg = getAgentRegistry();
    expect(reg.listAgents().length).toBe(5);
  });
});

describe("pre-defined agents", () => {
  it("buildAgent has full access permissions", () => {
    expect(buildAgent.permissions.default).toBe("allow");
    expect(buildAgent.permissions.rules).toHaveLength(0);
    expect(buildAgent.type).toBe("build");
  });

  it("planAgent is read-only", () => {
    expect(planAgent.permissions.default).toBe("deny");
    expect(planAgent.permissions.rules.length).toBeGreaterThan(0);
    // All allowed tools are read/search
    for (const rule of planAgent.permissions.rules) {
      expect(["file.read", "file.search", "file.list", "grep.search", "glob.*"]).toContain(
        rule.pattern,
      );
      expect(rule.action).toBe("allow");
    }
    expect(planAgent.type).toBe("plan");
  });

  it("exploreAgent has read + search + LSP permissions", () => {
    expect(exploreAgent.permissions.default).toBe("deny");
    const patterns = exploreAgent.permissions.rules.map((r) => r.pattern);
    expect(patterns).toContain("lsp.*");
    expect(patterns).toContain("file.read");
    expect(exploreAgent.type).toBe("explore");
  });

  it("oracleAgent is read-only for architecture consultation", () => {
    expect(oracleAgent.permissions.default).toBe("deny");
    const patterns = oracleAgent.permissions.rules.map((r) => r.pattern);
    expect(patterns).toContain("lsp.*");
    expect(patterns).not.toContain("terminal.*");
    expect(oracleAgent.type).toBe("oracle");
  });

  it("librarianAgent has read + web search permissions", () => {
    expect(librarianAgent.permissions.default).toBe("deny");
    const patterns = librarianAgent.permissions.rules.map((r) => r.pattern);
    expect(patterns).toContain("web.*");
    expect(patterns).not.toContain("terminal.*");
    expect(patterns).not.toContain("lsp.*");
    expect(librarianAgent.type).toBe("librarian");
  });

  it("all pre-defined agents have unique IDs", () => {
    const ids = PREDEFINED_AGENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all pre-defined agents have a protocolDef", () => {
    for (const agent of PREDEFINED_AGENTS) {
      expect(agent.protocolDef).toBeDefined();
      expect(agent.protocolDef.id).toBe(agent.id);
      expect(agent.protocolDef.name).toBe(agent.name);
      expect(agent.protocolDef.systemPrompt).toBe(agent.prompt);
    }
  });
});
