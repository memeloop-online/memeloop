/** AgentToolLoop — iterates between LLM calls and external tool execution. */

export { BUILTIN_AGENT_TOOL_LOOP_DEFAULT_SCRIPT_ID, builtinAgentToolLoopSources, getBuiltinAgentToolLoopSource } from '../../loops/agent-tool-loop/builtinLoopSources.js';
export { BOUNDED_MODEL_CONTEXT_LIMITS, BoundedModelContextError, loadBoundedModelContext } from './boundedModelContext.js';
export type { BoundedModelContext, ContextCompactionWorkBudget, LoadBoundedModelContextOptions } from './boundedModelContext.js';
export { loadAgentExecutionModelContext, prepareAgentExecutionModelRequest, prepareLoadedAgentExecutionModelRequest } from './executionModelContext.js';
export type {
  AgentExecutionModelContext,
  LoadAgentExecutionModelContextOptions,
  PrepareAgentExecutionModelRequestOptions,
  PreparedAgentExecutionModelRequest,
  PrepareLoadedAgentExecutionModelRequestOptions,
} from './executionModelContext.js';
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
export { summarizeModelContext } from './modelContextSummarizer.js';
export { prepareAgentModelRequest } from './modelMessages.js';
export { resolveAgentToolLoopTerminalState, runAgentToolLoopTurn, type RunAgentToolLoopTurnCallbacks, type RunAgentToolLoopTurnResult } from './runner.js';
export { type AgentToolLoopScriptReference, loadAgentToolLoopScript, type LoadAgentToolLoopScriptOptions } from './scriptLoader.js';
export {
  buildSemanticModelContextSummaryPrompt,
  projectSemanticModelContext,
  SEMANTIC_MODEL_CONTEXT_LIMITS,
  SemanticModelContextProjectionError,
} from './semanticModelContextProjection.js';
export type {
  SemanticModelContextMessage,
  SemanticModelContextProjection,
  SemanticModelContextProjectionErrorCode,
  SemanticModelContextToolCall,
  SemanticModelContextToolResult,
} from './semanticModelContextProjection.js';
export { refreshAgentToolLoopDefinition } from './turnPrimitives.js';
