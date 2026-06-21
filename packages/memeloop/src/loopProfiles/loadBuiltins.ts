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

// Built-in profiles are imported as JSON.
// Each JSON file is a LoopProfile with loopId defaulting to "agent-tool-loop".
import codeAssistant from './code-assistant.json' with { type: 'json' };
import frontendUiUx from './frontend-ui-ux.json' with { type: 'json' };
import generalAssistant from './general-assistant.json' with { type: 'json' };
import gitMaster from './git-master.json' with { type: 'json' };
import playwright from './playwright.json' with { type: 'json' };

/** Get all built-in Loop Profiles. */
export function getBuiltinLoopProfiles(): LoopProfile[] {
  return [
    generalAssistant,
    codeAssistant,
    frontendUiUx,
    gitMaster,
    playwright,
  ] as unknown as LoopProfile[];
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
