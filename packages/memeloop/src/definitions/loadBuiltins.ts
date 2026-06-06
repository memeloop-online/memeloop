import type { AgentDefinition } from '../agent/protocol.js';

import codeAssistant from './code-assistant.json';
import frontendUiUx from './frontend-ui-ux.json';
import generalAssistant from './general-assistant.json';
import gitMaster from './git-master.json';
import playwright from './playwright.json';

/** 内置 Agent 定义（与 `*.json` 文件同步）。 */
export function getBuiltinAgentDefinitions(): AgentDefinition[] {
  return [
    generalAssistant,
    codeAssistant,
    frontendUiUx,
    gitMaster,
    playwright,
  ] as unknown as AgentDefinition[];
}
