/**
 * LLM_IO_Loop — the default agent loop that iterates between LLM calls and external tool execution.
 *
 * This directory replaces the old flat `agentLoops/taskAgent.ts` structure.
 * Importers should use `from "memeloop"` or the relative path to this barrel.
 */

export { createTaskAgent } from "./loop.js";
export { runTaskAgentTurn, resolveTaskAgentTerminalState, type RunTaskAgentTurnCallbacks, type RunTaskAgentTurnResult } from "./runner.js";
export { autoCompact, compactMessages, shouldCompact } from "./compaction.js";
export type { CompactionOptions, CompactionResult } from "./compaction.js";
