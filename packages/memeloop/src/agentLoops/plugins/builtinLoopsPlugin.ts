/**
 * Built-in loop registrations — installed at startup so getLoopRegistry().createRunner('llm-io') works.
 *
 * This module allows hosts to skip manual registerLoop() for the built-in loop types.
 * Hosts can still override by calling registerLoop() with the same id after.
 */

import { getLoopRegistry } from '../registry.js';
import { createSubAgentLoopDefinition, getSubAgentLoopId } from '../sub-agent/loop.js';
import type { AgentLoopDefinition } from '../types.js';

export const LLM_IO_LOOP_ID = 'llm-io';
export const SUB_AGENT_LOOP_ID = getSubAgentLoopId();

function createLlmIoLoopDefinition(name: string): AgentLoopDefinition {
  return {
    id: LLM_IO_LOOP_ID,
    name,
    description: 'LLM I/O loop — the classic ReAct agent loop that calls the LLM and executes tools.',
    createRunner: () => {
      throw new Error('LLM_IO_Loop runner is created via createTaskAgent(); import from "memeloop" directly.');
    },
  };
}

/**
 * Register the default built-in loops (llm-io and sub-agent) with the loop registry.
 * Safe to call multiple times — skips already-registered loops.
 */
export function registerBuiltinLoops(): void {
  const registry = getLoopRegistry();

  if (!registry.getLoop(LLM_IO_LOOP_ID)) {
    registry.registerLoop(createLlmIoLoopDefinition('LLM_IO_Loop'));
  }

  if (!registry.getLoop(SUB_AGENT_LOOP_ID)) {
    registry.registerLoop(createSubAgentLoopDefinition());
  }
}
