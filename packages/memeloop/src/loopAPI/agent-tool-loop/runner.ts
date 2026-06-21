/**
 * AgentToolLoop runner — convenience API for driving a full loop turn.
 */

import type { AgentFrameworkContext, AgentInstanceState } from '../../types.js';
import type { AgentLoopGenerator, AgentLoopInput, AgentLoopStep } from '../types.js';
import { createAgentToolLoopRunner } from './loop.js';

export interface RunAgentToolLoopTurnCallbacks {
  onStep?: (step: AgentLoopStep) => void | Promise<void>;
  onProgress?: (
    status: string,
    data: Record<string, unknown>,
    step: AgentLoopStep,
  ) => void | Promise<void>;
  agentToolLoop?: (input: AgentLoopInput) => AgentLoopGenerator;
}

export interface RunAgentToolLoopTurnResult {
  state: AgentInstanceState;
  stepCount: number;
}

export function resolveAgentToolLoopTerminalState(
  step: AgentLoopStep,
  current: AgentInstanceState,
): AgentInstanceState {
  if (step.type !== 'thinking') return current;
  const data = step.data as { status?: string };
  if (data.status === 'input-required') return 'input-required';
  if (data.status === 'cancelled') return 'canceled';
  if (data.status === 'max-iterations') return 'completed';
  if (data.status === 'blocked') return 'failed';
  if (data.status === 'calling-llm') return 'working';
  return current;
}

export async function runAgentToolLoopTurn(
  context: AgentFrameworkContext,
  input: AgentLoopInput,
  callbacks: RunAgentToolLoopTurnCallbacks = {},
): Promise<RunAgentToolLoopTurnResult> {
  const agentToolLoop = callbacks.agentToolLoop ?? createAgentToolLoopRunner(context);
  let terminalState: AgentInstanceState = 'completed';
  let stepCount = 0;

  for await (const step of agentToolLoop(input)) {
    stepCount += 1;
    terminalState = resolveAgentToolLoopTerminalState(step, terminalState);
    await callbacks.onStep?.(step);

    if (step.type === 'thinking' && step.data && typeof step.data === 'object') {
      const data = step.data as Record<string, unknown>;
      const status = data.status;
      if (typeof status === 'string') {
        await callbacks.onProgress?.(status, data, step);
      }
    }
  }

  return {
    state: terminalState === 'working' || terminalState === 'submitted' ? 'completed' : terminalState,
    stepCount,
  };
}
