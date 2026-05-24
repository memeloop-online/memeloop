/**
 * Skill system types for memeloop.
 * Skills are reusable instruction bundles that can be loaded into agent contexts.
 */

export interface SkillDefinition {
  /** Unique skill identifier (e.g., "frontend-ui-ux", "git-master") */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Instructions injected into the agent's system prompt when this skill is active */
  instructions: string;
  /** Optional tool IDs this skill grants access to */
  tools?: string[];
  /** Optional MCP server configurations used by this skill */
  mcpServers?: string[];
}

/**
 * Skill manifest format for disk-based skill loading.
 * Matches the JSON structure in `.memeloop/skills/<name>/skill.json`.
 */
export interface SkillManifest extends SkillDefinition {
  /** Skill version for compatibility tracking */
  version?: string;
  /** Author attribution */
  author?: string;
}
