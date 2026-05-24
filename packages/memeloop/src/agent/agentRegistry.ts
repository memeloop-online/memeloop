import type { AgentType, AgentRegistryEntry } from "./agentTypes.js";
import { PREDEFINED_AGENTS } from "./agentTypes.js";

/**
 * Agent registry for managing specialized agent definitions.
 * Pre-seeded with built-in agents (build, plan, explore, oracle, librarian).
 */
export class AgentRegistry {
  private readonly agents = new Map<string, AgentRegistryEntry>();

  constructor() {
    this.seedDefaults();
  }

  /** Seed the registry with pre-built agent definitions. */
  private seedDefaults(): void {
    for (const def of PREDEFINED_AGENTS) {
      this.agents.set(def.id, def);
    }
  }

  /**
   * Register a new agent definition or override an existing one.
   * Throws if the definition is invalid.
   */
  registerAgent(def: AgentRegistryEntry): void {
    if (!def.id || typeof def.id !== "string" || def.id.trim().length === 0) {
      throw new Error("Agent definition must have a non-empty id");
    }
    if (!def.name || typeof def.name !== "string") {
      throw new Error("Agent definition must have a name");
    }
    if (!def.type || typeof def.type !== "string") {
      throw new Error("Agent definition must have a type");
    }
    if (!def.prompt || typeof def.prompt !== "string") {
      throw new Error("Agent definition must have a prompt");
    }
    if (!def.permissions || typeof def.permissions.default !== "string") {
      throw new Error("Agent definition must have valid permissions");
    }
    this.agents.set(def.id, def);
  }

  /**
   * Get an agent definition by ID.
   * Returns undefined if not found.
   */
  getAgent(id: string): AgentRegistryEntry | undefined {
    return this.agents.get(id);
  }

  /**
   * List all registered agent definitions.
   */
  listAgents(): AgentRegistryEntry[] {
    return Array.from(this.agents.values());
  }

  /**
   * List agents filtered by type.
   */
  listAgentsByType(type: AgentType): AgentRegistryEntry[] {
    return this.listAgents().filter((a) => a.type === type);
  }

  /**
   * Remove an agent definition by ID.
   * Built-in agents (memeloop:* prefixed) are re-seeded on next getAgent call.
   */
  unregisterAgent(id: string): boolean {
    return this.agents.delete(id);
  }

  /**
   * Reset the registry to only built-in defaults.
   */
  reset(): void {
    this.agents.clear();
    this.seedDefaults();
  }
}

/** Shared singleton instance for convenience. */
let defaultRegistry: AgentRegistry | null = null;

export function getAgentRegistry(): AgentRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new AgentRegistry();
  }
  return defaultRegistry;
}

export function resetAgentRegistry(): void {
  if (defaultRegistry) {
    defaultRegistry.reset();
  }
  defaultRegistry = null;
}
