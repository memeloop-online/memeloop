import { getBuiltinAgentToolLoopSource } from '../../loops/agent-tool-loop/builtinLoopSources.js';
import { type AgentLoopScriptReference, loadAgentLoopScript } from '../scriptLoader.js';
import type { AgentLoopScriptPolicy } from '../types.js';
import type { AgentToolLoopScript } from './loop.js';

export type LoadAgentToolLoopScriptOptions = AgentLoopScriptPolicy;

export type AgentToolLoopScriptReference = AgentLoopScriptReference;

export async function loadAgentToolLoopScript(
  scriptReference: AgentToolLoopScriptReference,
  options: LoadAgentToolLoopScriptOptions = {},
): Promise<AgentToolLoopScript> {
  return loadAgentLoopScript<AgentToolLoopScript>(scriptReference, {
    ...options,
    getBuiltinScriptSource: getBuiltinAgentToolLoopSource,
    scriptType: 'AgentToolLoop script',
  });
}
