import { builtinAgentAgentLoopSources, getBuiltinAgentAgentLoopSource } from '../../loops/agent-agent-loop/builtinLoopSources.js';
import { type AgentLoopScriptReference, loadAgentLoopScript, registerBuiltinScriptSources } from '../scriptLoader.js';
import type { AgentLoopScriptPolicy } from '../types.js';
import type { AgentAgentLoopScript } from './loop.js';

export type LoadAgentAgentLoopScriptOptions = AgentLoopScriptPolicy;

export type AgentAgentLoopScriptReference = AgentLoopScriptReference;

let builtinDigestsRegistered: Promise<unknown> | undefined;

/**
 * Register the first-party builtin loop sources in the digest allowlist
 * once, so builtin scripts load without gate overhead while every other
 * source must pass the script load gate (plan 24.15).
 */
function ensureBuiltinDigestsRegistered(): Promise<unknown> {
  builtinDigestsRegistered ??= registerBuiltinScriptSources(builtinAgentAgentLoopSources);
  return builtinDigestsRegistered;
}

export async function loadAgentAgentLoopScript(
  scriptReference: AgentAgentLoopScriptReference,
  options: LoadAgentAgentLoopScriptOptions = {},
): Promise<AgentAgentLoopScript> {
  await ensureBuiltinDigestsRegistered();
  return loadAgentLoopScript<AgentAgentLoopScript>(scriptReference, {
    ...options,
    getBuiltinScriptSource: getBuiltinAgentAgentLoopSource,
    scriptType: 'AgentAgentLoop script',
  });
}
