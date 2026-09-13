import { getBuiltinAgentToolLoopModule } from '../../loops/agent-tool-loop/builtinLoopModules.js';
import { builtinAgentToolLoopSources, getBuiltinAgentToolLoopSource } from '../../loops/agent-tool-loop/builtinLoopSources.js';
import { type AgentLoopScriptReference, createBuiltinAgentLoopScriptLoader } from '../scriptLoader.js';
import type { AgentLoopScriptPolicy } from '../types.js';
import type { AgentToolLoopScript } from './loop.js';

export type LoadAgentToolLoopScriptOptions = AgentLoopScriptPolicy;

export type AgentToolLoopScriptReference = AgentLoopScriptReference;

const loadScript = createBuiltinAgentLoopScriptLoader<AgentToolLoopScript>({
  sources: builtinAgentToolLoopSources,
  getBuiltinScriptModule: getBuiltinAgentToolLoopModule,
  getBuiltinScriptSource: getBuiltinAgentToolLoopSource,
  scriptType: 'AgentToolLoop script',
});

export async function loadAgentToolLoopScript(
  scriptReference: AgentToolLoopScriptReference,
  options: LoadAgentToolLoopScriptOptions = {},
): Promise<AgentToolLoopScript> {
  return loadScript(scriptReference, options);
}
