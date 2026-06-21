/** AgentToolLoop — iterates between LLM calls and external tool execution. */

export { BUILTIN_AGENT_TOOL_LOOP_DEFAULT_SCRIPT_ID, builtinAgentToolLoopSources, getBuiltinAgentToolLoopSource } from '../../loops/agent-tool-loop/builtinLoopSources.js';
export { autoCompact, compactMessages, shouldCompact } from './compaction.js';
export type { CompactionOptions, CompactionResult } from './compaction.js';
export { createAgentToolLoopDefinition, createAgentToolLoopRunner } from './loop.js';
export type {
  AgentToolLoopContext,
  AgentToolLoopIterationGenerator,
  AgentToolLoopIterationResult,
  AgentToolLoopScript,
  AgentToolLoopScriptContext,
  AgentToolLoopState,
  AgentToolLoopTurnStartResult,
} from './loop.js';
export { resolveAgentToolLoopTerminalState, runAgentToolLoopTurn, type RunAgentToolLoopTurnCallbacks, type RunAgentToolLoopTurnResult } from './runner.js';
export { type AgentToolLoopScriptReference, loadAgentToolLoopScript, type LoadAgentToolLoopScriptOptions } from './scriptLoader.js';
