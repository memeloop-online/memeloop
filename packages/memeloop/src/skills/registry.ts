/**
 * Skill registry for managing skill definitions.
 * Supports programmatic registration and auto-discovery from `.memeloop/skills/` directories.
 */

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SkillDefinition, SkillManifest } from "./types.js";

/** Internal registry map. */
const skillRegistry = new Map<string, SkillDefinition>();

/**
 * Register a skill definition.
 * @throws {Error} if the skill is missing required fields (id, name, instructions)
 */
export function registerSkill(skill: SkillDefinition): void {
  if (!skill.id || typeof skill.id !== "string" || skill.id.trim().length === 0) {
    throw new Error("Skill must have a non-empty id");
  }
  if (!skill.name || typeof skill.name !== "string") {
    throw new Error("Skill must have a name");
  }
  if (!skill.instructions || typeof skill.instructions !== "string") {
    throw new Error("Skill must have instructions");
  }
  skillRegistry.set(skill.id, skill);
}

/**
 * Retrieve a registered skill by id.
 * @returns The skill definition, or undefined if not found.
 */
export function getSkill(id: string): SkillDefinition | undefined {
  return skillRegistry.get(id);
}

/**
 * List all registered skills.
 */
export function listSkills(): SkillDefinition[] {
  return Array.from(skillRegistry.values());
}

/**
 * Remove a skill from the registry.
 * @returns true if the skill was found and removed.
 */
export function unregisterSkill(id: string): boolean {
  return skillRegistry.delete(id);
}

/**
 * Remove all skills from the registry.
 */
export function clearSkills(): void {
  skillRegistry.clear();
}

/**
 * Auto-discover and load skills from a directory.
 * Each subdirectory is expected to contain a `skill.json` manifest.
 *
 * Expected structure:
 * ```
 * .memeloop/skills/
 *   my-skill/
 *     skill.json   # { "id": "my-skill", "name": "...", "instructions": "..." }
 * ```
 *
 * @param dir - Absolute or relative path to the skills directory
 */
export function loadSkillsFromDir(dir: string): void {
  const skillsDir = resolve(dir);
  if (!existsSync(skillsDir)) return;

  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    // Permission errors, non-directory paths, etc.
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillPath = resolve(skillsDir, entry.name);
    const manifestPath = resolve(skillPath, "skill.json");

    if (!existsSync(manifestPath)) continue;

    try {
      const raw = readFileSync(manifestPath, "utf-8");
      const manifest: SkillManifest = JSON.parse(raw);
      registerSkill(manifest);
    } catch {
      // Skip malformed manifests silently
    }
  }
}
