import { type AgentLoopScriptReference, loadAgentLoopScript } from '../scriptLoader.js';
import type { AgentLoopScriptPolicy } from '../types.js';
import type { SubAgentLoopScript } from './loop.js';
import { getBuiltinSubAgentScriptSource } from './scripts/builtinScripts.js';

export type LoadSubAgentLoopScriptOptions = AgentLoopScriptPolicy;

export type SubAgentLoopScriptReference = AgentLoopScriptReference;

export async function loadSubAgentLoopScript(
  scriptReference: SubAgentLoopScriptReference,
  options: LoadSubAgentLoopScriptOptions = {},
): Promise<SubAgentLoopScript> {
  return loadAgentLoopScript<SubAgentLoopScript>(scriptReference, {
    ...options,
    getBuiltinScriptSource: getBuiltinSubAgentScriptSource,
    scriptType: 'SubAgent loop script',
  });
}
