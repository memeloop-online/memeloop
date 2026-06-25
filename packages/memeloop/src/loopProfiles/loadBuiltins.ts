/**
 * Built-in Loop Profiles.
 *
 * Each profile defines which agent loop to run, which .mjs script to load,
 * which prompts, plugins, and hook plugins to enable.
 *
 * Replaces the old `src/prompt/loadBuiltins.ts`.
 */

import { getLoopRegistry } from '../loopAPI/registry.js';
import type { LoopProfile } from '../loopAPI/types.js';
import { builtinProfileSources } from './builtinProfileSources.js';

function loadProfile(name: string): LoopProfile {
  const source = builtinProfileSources[name];
  if (!source) {
    throw new Error(`Builtin profile not found: ${name}`);
  }
  return JSON.parse(source) as LoopProfile;
}

/** Get all built-in Loop Profiles. */
export function getBuiltinLoopProfiles(): LoopProfile[] {
  return [
    loadProfile('general-assistant'),
    loadProfile('code-assistant'),
    loadProfile('frontend-ui-ux'),
    loadProfile('git-master'),
    loadProfile('playwright'),
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
