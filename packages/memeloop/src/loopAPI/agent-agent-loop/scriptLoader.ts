import { getBuiltinAgentAgentLoopSource } from '../../loops/agent-agent-loop/builtinLoopSources.js';
import { type AgentLoopScriptReference, loadAgentLoopScript } from '../scriptLoader.js';
import type { AgentLoopScriptPolicy } from '../types.js';
import type { AgentAgentLoopScript } from './loop.js';

export type LoadAgentAgentLoopScriptOptions = AgentLoopScriptPolicy;

export type AgentAgentLoopScriptReference = AgentLoopScriptReference;

export async function loadAgentAgentLoopScript(
  scriptReference: AgentAgentLoopScriptReference,
  options: LoadAgentAgentLoopScriptOptions = {},
): Promise<AgentAgentLoopScript> {
  return loadAgentLoopScript<AgentAgentLoopScript>(scriptReference, {
    ...options,
    getBuiltinScriptSource: getBuiltinAgentAgentLoopSource,
    scriptType: 'AgentAgentLoop script',
  });
}
