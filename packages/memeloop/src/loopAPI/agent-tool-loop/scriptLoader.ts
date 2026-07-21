import { builtinAgentToolLoopSources, getBuiltinAgentToolLoopSource } from '../../loops/agent-tool-loop/builtinLoopSources.js';
import { type AgentLoopScriptReference, loadAgentLoopScript, registerBuiltinScriptSources } from '../scriptLoader.js';
import type { AgentLoopScriptPolicy } from '../types.js';
import type { AgentToolLoopScript } from './loop.js';

export type LoadAgentToolLoopScriptOptions = AgentLoopScriptPolicy;

export type AgentToolLoopScriptReference = AgentLoopScriptReference;

let builtinDigestsRegistered: Promise<unknown> | undefined;

/**
 * Register the first-party builtin loop sources in the digest allowlist
 * once, so builtin scripts load without gate overhead while every other
 * source must pass the script load gate (plan 24.15).
 */
function ensureBuiltinDigestsRegistered(): Promise<unknown> {
  builtinDigestsRegistered ??= registerBuiltinScriptSources(builtinAgentToolLoopSources);
  return builtinDigestsRegistered;
}

export async function loadAgentToolLoopScript(
  scriptReference: AgentToolLoopScriptReference,
  options: LoadAgentToolLoopScriptOptions = {},
): Promise<AgentToolLoopScript> {
  await ensureBuiltinDigestsRegistered();
  return loadAgentLoopScript<AgentToolLoopScript>(scriptReference, {
    ...options,
    getBuiltinScriptSource: getBuiltinAgentToolLoopSource,
    scriptType: 'AgentToolLoop script',
  });
}
