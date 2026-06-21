import { type AgentLoopScriptReference, loadAgentLoopScript } from '../scriptLoader.js';
import type { AgentLoopScriptPolicy } from '../types.js';
import type { LlmIoLoopScript } from './loop.js';
import { getBuiltinLlmIoScriptSource } from './scripts/builtinScripts.js';

export type LoadLlmIoLoopScriptOptions = AgentLoopScriptPolicy;

export type LlmIoLoopScriptReference = AgentLoopScriptReference;

export async function loadLlmIoLoopScript(
  scriptReference: LlmIoLoopScriptReference,
  options: LoadLlmIoLoopScriptOptions = {},
): Promise<LlmIoLoopScript> {
  return loadAgentLoopScript<LlmIoLoopScript>(scriptReference, {
    ...options,
    getBuiltinScriptSource: getBuiltinLlmIoScriptSource,
    scriptType: 'LLM_IO loop script',
  });
}
