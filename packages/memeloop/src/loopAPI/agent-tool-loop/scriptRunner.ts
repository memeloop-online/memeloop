import type { AgentLoopGenerator, AgentLoopInput, AgentLoopStep } from '../types.js';
import type { AgentToolLoopContext, AgentToolLoopScript, AgentToolLoopScriptContext } from './contracts.js';
import { loadAgentToolLoopScript } from './scriptLoader.js';
import { createAgentToolLoopState, runAgentToolLoopIteration, startAgentToolLoopTurn, stopAgentToolLoopTurn } from './turnPrimitives.js';

function isAsyncIterable(value: unknown): value is AgentLoopGenerator {
  return Boolean(value && typeof value === 'object' && Symbol.asyncIterator in value);
}

function messageStep(message: string): AgentLoopStep {
  return { type: 'message', data: message };
}

async function* drainEmittedSteps(steps: AgentLoopStep[]): AgentLoopGenerator {
  while (steps.length > 0) {
    const step = steps.shift();
    if (step) yield step;
  }
}

export function asAgentToolLoopContext(rawContext: { [key: string]: unknown }): AgentToolLoopContext {
  return rawContext as unknown as AgentToolLoopContext;
}

export async function resolveAgentToolLoopScript(context: AgentToolLoopContext): Promise<AgentToolLoopScript | undefined> {
  if (context.script) return context.script;
  const scriptReference = context.profile?.scriptReference ?? context.profile?.scriptRef ?? context.profile?.script;
  if (!scriptReference) return undefined;
  if (context.loadScript) return context.loadScript(scriptReference, context);
  return loadAgentToolLoopScript(scriptReference, context.scriptPolicy);
}

function createAgentToolLoopScriptContext(
  input: AgentLoopInput,
  context: AgentToolLoopContext,
  emittedSteps: AgentLoopStep[],
): AgentToolLoopScriptContext {
  const emit = (step: AgentLoopStep): void => {
    emittedSteps.push(step);
    context.runtime?.emit?.(step);
  };
  return {
    input,
    context,
    profile: context.profile,
    createState: () => createAgentToolLoopState(context),
    startTurn: state => startAgentToolLoopTurn(context, input, state),
    runIteration: state => runAgentToolLoopIteration(context, input, state),
    stopTurn: (state, reason) => stopAgentToolLoopTurn(context, input, state, reason),
    emit,
    finish: message => {
      emit(typeof message === 'string' ? messageStep(message) : message);
    },
    isCancelled: () => context.runtime?.signal?.cancelled === true || context.agentToolLoop?.isCancelled?.(input.conversationId) === true,
    log: (event, data) => {
      context.runtime?.log?.(event, data);
      context.logger?.debug?.(event, data);
    },
  };
}

export async function* runAgentToolLoopScript(
  script: AgentToolLoopScript,
  input: AgentLoopInput,
  context: AgentToolLoopContext,
): AgentLoopGenerator {
  const emittedSteps: AgentLoopStep[] = [];
  const result = await script(createAgentToolLoopScriptContext(input, context, emittedSteps));

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
