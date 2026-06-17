/**
 * Built-in Loop Profiles.
 *
 * Each profile defines which agent loop to run, which .mjs script to load,
 * which prompts, plugins, and hook plugins to enable.
 *
 * Replaces the old `src/prompt/loadBuiltins.ts`.
 */

import type { LoopProfile } from "../agentLoops/types.js";

// Built-in profiles are imported as JSON.
// Each JSON file is a LoopProfile with loopId defaulting to "llm-io".
import generalAssistant from "./general-assistant.json";
import codeAssistant from "./code-assistant.json";
import frontendUiUx from "./frontend-ui-ux.json";
import gitMaster from "./git-master.json";
import playwright from "./playwright.json";

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
