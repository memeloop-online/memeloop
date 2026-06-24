/**
 * Built-in Loop Profiles.
 *
 * Each profile defines which agent loop to run, which .mjs script to load,
 * which prompts, plugins, and hook plugins to enable.
 *
 * Replaces the old `src/prompt/loadBuiltins.ts`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getLoopRegistry } from '../loopAPI/registry.js';
import type { LoopProfile } from '../loopAPI/types.js';

function getProfileDirectory(): string {
  // In CJS builds `import.meta.url` is empty, so fall back to `__dirname`.
  // TypeScript strips import attributes when targeting newer module settings,
  // so we load JSON at runtime to keep both ESM and CJS builds working.
  return dirname(__filename);
}

function loadProfileJSON(name: string): LoopProfile {
  const content = readFileSync(join(getProfileDirectory(), `${name}.json`), 'utf8');
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
