/**
 * Skill registry for managing skill definitions.
 * Supports programmatic registration. File-system discovery belongs in host adapters.
 *
 * Moved from src/skills/registry.ts — now part of the definitions module.
 */

import type { SkillDefinition } from './skillTypes.js';

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>();

  /**
   * Register a skill definition.
   * @throws {Error} if the skill is missing required fields (id, name, instructions)
   */
  registerSkill(skill: SkillDefinition): void {
    validateSkill(skill);
    this.skills.set(skill.id, skill);
  }

  /**
   * Retrieve a registered skill by id.
   * @returns The skill definition, or undefined if not found.
   */
  getSkill(id: string): SkillDefinition | undefined {
    return this.skills.get(id);
  }

  /**
   * List all registered skills.
   */
  listSkills(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  /**
   * Remove a skill from the registry.
   * @returns true if the skill was found and removed.
   */
  unregisterSkill(id: string): boolean {
    return this.skills.delete(id);
  }

  /**
   * Remove all skills from the registry.
   */
  clearSkills(): void {
    this.skills.clear();
  }
}

const defaultSkillRegistry = new SkillRegistry();

export function getDefaultSkillRegistry(): SkillRegistry {
  return defaultSkillRegistry;
}

function validateSkill(skill: SkillDefinition): void {
  if (!skill.id || typeof skill.id !== 'string' || skill.id.trim().length === 0) {
    throw new Error('Skill must have a non-empty id');
  }
  if (!skill.name || typeof skill.name !== 'string') {
    throw new Error('Skill must have a name');
  }
  if (!skill.instructions || typeof skill.instructions !== 'string') {
    throw new Error('Skill must have instructions');
  }
}

/**
 * Register a skill definition.
 * @throws {Error} if the skill is missing required fields (id, name, instructions)
 */
export function registerSkill(skill: SkillDefinition): void {
  defaultSkillRegistry.registerSkill(skill);
}

/**
 * Retrieve a registered skill by id.
 * @returns The skill definition, or undefined if not found.
 */
export function getSkill(id: string): SkillDefinition | undefined {
  return defaultSkillRegistry.getSkill(id);
}

/**
 * List all registered skills.
 */
export function listSkills(): SkillDefinition[] {
  return defaultSkillRegistry.listSkills();
}

/**
 * Remove a skill from the registry.
 * @returns true if the skill was found and removed.
 */
export function unregisterSkill(id: string): boolean {
  return defaultSkillRegistry.unregisterSkill(id);
}

/**
 * Remove all skills from the registry.
 */
export function clearSkills(): void {
  defaultSkillRegistry.clearSkills();
}
