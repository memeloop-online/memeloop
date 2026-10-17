import { getBuiltinAgentAgentLoopModule } from '../../loops/agent-agent-loop/builtinLoopModules.js';
import { builtinAgentAgentLoopSources, getBuiltinAgentAgentLoopSource } from '../../loops/agent-agent-loop/builtinLoopSources.js';
import { type AgentLoopScriptReference, createBuiltinAgentLoopScriptLoader } from '../scriptLoader.js';
import type { AgentLoopScriptPolicy } from '../types.js';
import type { AgentAgentLoopScript } from './loop.js';

export type LoadAgentAgentLoopScriptOptions = AgentLoopScriptPolicy;

export type AgentAgentLoopScriptReference = AgentLoopScriptReference;

const loadScript = createBuiltinAgentLoopScriptLoader<AgentAgentLoopScript>({
  sources: builtinAgentAgentLoopSources,
  getBuiltinScriptModule: getBuiltinAgentAgentLoopModule,
  getBuiltinScriptSource: getBuiltinAgentAgentLoopSource,
  scriptType: 'AgentAgentLoop script',
});

export async function loadAgentAgentLoopScript(
  scriptReference: AgentAgentLoopScriptReference,
  options: LoadAgentAgentLoopScriptOptions = {},
): Promise<AgentAgentLoopScript> {
  return loadScript(scriptReference, options);
}
