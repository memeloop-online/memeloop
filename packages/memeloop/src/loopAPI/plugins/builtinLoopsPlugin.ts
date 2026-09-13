/**
 * Built-in loop registrations for an explicitly owned runtime registry.
 *
 * This module allows hosts to skip manual registerLoop() for the built-in loop types.
 * Hosts can still override by calling registerLoop() with the same id after.
 */

import { createAgentAgentLoopDefinition, getAgentAgentLoopId } from '../agent-agent-loop/loop.js';
import { createAgentToolLoopDefinition } from '../agent-tool-loop/loop.js';
import type { LoopRegistry } from '../registry.js';

export const AGENT_TOOL_LOOP_ID = 'agent-tool-loop';
export const AGENT_AGENT_LOOP_ID = getAgentAgentLoopId();

/**
 * Register the default built-in loops (agent-tool-loop and agent-agent-loop) with the loop registry.
 * Safe to call multiple times — skips already-registered loops.
 */
export function registerBuiltinLoops(registry: LoopRegistry): void {
  if (!registry.getLoop(AGENT_TOOL_LOOP_ID)) {
    registry.registerLoop(createAgentToolLoopDefinition('AgentToolLoop'));
  }

  if (!registry.getLoop(AGENT_AGENT_LOOP_ID)) {
    registry.registerLoop(createAgentAgentLoopDefinition());
  }
}
