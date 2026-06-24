/**
 * Built-in Loop Profiles.
 *
 * Each profile defines which agent loop to run, which .mjs script to load,
 * which prompts, plugins, and hook plugins to enable.
 *
 * Replaces the old `src/prompt/loadBuiltins.ts`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getLoopRegistry } from '../loopAPI/registry.js';
import type { LoopProfile } from '../loopAPI/types.js';

function loadProfileJSON(name: string): LoopProfile {
  const url = new URL(`./${name}.json`, import.meta.url);
  const content = readFileSync(fileURLToPath(url), 'utf8');
  return JSON.parse(content) as LoopProfile;
}

/** Get all built-in Loop Profiles. */
export function getBuiltinLoopProfiles(): LoopProfile[] {
  return [
    loadProfileJSON('general-assistant'),
    loadProfileJSON('code-assistant'),
    loadProfileJSON('frontend-ui-ux'),
    loadProfileJSON('git-master'),
    loadProfileJSON('playwright'),
  ];
}

/** Get a built-in Loop Profile by id. */
export function getBuiltinLoopProfile(id: string): LoopProfile | undefined {
  return getBuiltinLoopProfiles().find((p) => p.id === id);
}

/** Register bundled profiles with the global loop registry. */
export function registerBuiltinLoopProfiles(): void {
  const registry = getLoopRegistry();
  for (const profile of getBuiltinLoopProfiles()) {
    registry.registerProfile(profile);
  }
}
