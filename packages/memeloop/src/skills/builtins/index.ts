export { frontendUiUxSkill } from "./frontend-ui-ux.js";
export { gitMasterSkill } from "./git-master.js";
export { playwrightSkill } from "./playwright.js";

import { frontendUiUxSkill } from "./frontend-ui-ux.js";
import { gitMasterSkill } from "./git-master.js";
import { playwrightSkill } from "./playwright.js";
import type { SkillDefinition } from "../types.js";

/** All built-in skills shipped with memeloop. */
export const BUILTIN_SKILLS: SkillDefinition[] = [
  frontendUiUxSkill,
  gitMasterSkill,
  playwrightSkill,
];
