import type { AgentProfile, AgentProfileType } from "./agentProfiles.js";
import { BUILTIN_AGENT_PROFILES } from "./agentProfiles.js";

/**
 * Registry for agent profiles used by task delegation.
 * Pre-seeded with built-in profiles (build, plan, explore, oracle, librarian).
 */
export class AgentProfileRegistry {
  private readonly profiles = new Map<string, AgentProfile>();

  constructor() {
    this.seedDefaults();
  }

  /** Seed the registry with built-in agent profiles. */
  private seedDefaults(): void {
    for (const profile of BUILTIN_AGENT_PROFILES) {
      this.profiles.set(profile.id, profile);
    }
  }

  /**
   * Register a new agent profile or override an existing one.
   * Throws if the profile is invalid.
   */
  registerAgentProfile(profile: AgentProfile): void {
    if (!profile.id || typeof profile.id !== "string" || profile.id.trim().length === 0) {
      throw new Error("Agent profile must have a non-empty id");
    }
    if (!profile.name || typeof profile.name !== "string") {
      throw new Error("Agent profile must have a name");
    }
    if (!profile.type || typeof profile.type !== "string") {
      throw new Error("Agent profile must have a type");
    }
    if (!profile.prompt || typeof profile.prompt !== "string") {
      throw new Error("Agent profile must have a prompt");
    }
    if (!profile.permissions || typeof profile.permissions.default !== "string") {
      throw new Error("Agent profile must have valid permissions");
    }
    this.profiles.set(profile.id, profile);
  }

  /**
   * Get an agent profile by ID.
   * Returns undefined if not found.
   */
  getAgentProfile(id: string): AgentProfile | undefined {
    return this.profiles.get(id);
  }

  /**
   * List all registered agent profiles.
   */
  listAgentProfiles(): AgentProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * List agent profiles filtered by type.
   */
  listAgentProfilesByType(type: AgentProfileType): AgentProfile[] {
    return this.listAgentProfiles().filter((profile) => profile.type === type);
  }

  /**
   * Remove an agent profile by ID.
   */
  unregisterAgentProfile(id: string): boolean {
    return this.profiles.delete(id);
  }

  /**
   * Reset the registry to only built-in defaults.
   */
  reset(): void {
    this.profiles.clear();
    this.seedDefaults();
  }
}

/** Shared singleton instance for convenience. */
let defaultRegistry: AgentProfileRegistry | null = null;

export function getAgentProfileRegistry(): AgentProfileRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new AgentProfileRegistry();
  }
  return defaultRegistry;
}

export function resetAgentProfileRegistry(): void {
  if (defaultRegistry) {
    defaultRegistry.reset();
  }
  defaultRegistry = null;
}
