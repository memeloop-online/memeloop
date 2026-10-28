import type { AgentLoopGenerator, AgentLoopStep } from './types.js';

export type AgentLoopScriptResult = AgentLoopGenerator | AgentLoopStep | AgentLoopStep[] | string | undefined;

export function messageStep(message: string): AgentLoopStep {
  return { type: 'message', data: message };
}

export function createScriptStepEmitter(
  emittedSteps: AgentLoopStep[],
  onEmit?: (step: AgentLoopStep) => void,
): (step: AgentLoopStep) => void {
  return (step) => {
    emittedSteps.push(step);
    onEmit?.(step);
  };
}

function isAsyncIterable(value: unknown): value is AgentLoopGenerator {
  return Boolean(value && typeof value === 'object' && Symbol.asyncIterator in value);
}

async function* drainEmittedSteps(steps: AgentLoopStep[]): AgentLoopGenerator {
  while (steps.length > 0) {
    const step = steps.shift();
    if (step) yield step;
  }
}

/**
 * Normalize the result shapes supported by both built-in script runtimes while
 * preserving steps emitted before or during script execution.
 */
export async function* yieldScriptResult(
  result: AgentLoopScriptResult,
  emittedSteps: AgentLoopStep[],
): AgentLoopGenerator {
  yield* drainEmittedSteps(emittedSteps);
  if (isAsyncIterable(result)) {
    yield* result;
    yield* drainEmittedSteps(emittedSteps);
  } else if (typeof result === 'string') {
    yield messageStep(result);
  } else if (Array.isArray(result)) {
    yield* result;
  } else if (result) {
    yield result;
  }
}
