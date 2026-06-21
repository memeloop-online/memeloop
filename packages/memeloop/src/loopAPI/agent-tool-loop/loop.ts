import type { AgentFrameworkContext } from '../../types.js';
import type { AgentLoopDefinition, AgentLoopGenerator, AgentLoopInput } from '../types.js';
import { asAgentToolLoopContext, resolveAgentToolLoopScript, runAgentToolLoopScript } from './scriptRunner.js';
import { createAgentToolLoopState, runAgentToolLoopIteration, startAgentToolLoopTurn, stopAgentToolLoopTurn } from './turnPrimitives.js';

export type {
  AgentToolLoopContext,
  AgentToolLoopIterationGenerator,
  AgentToolLoopIterationResult,
  AgentToolLoopScript,
  AgentToolLoopScriptContext,
  AgentToolLoopScriptReference,
  AgentToolLoopState,
  AgentToolLoopTurnStartResult,
  LoadAgentToolLoopScriptOptions,
} from './contracts.js';

export function createAgentToolLoopRunner(
  context: AgentFrameworkContext,
): (input: AgentLoopInput) => AgentLoopGenerator {
  return async function* agentToolLoopRunner(input): AgentLoopGenerator {
    const state = createAgentToolLoopState(context);
    try {
      const start = await startAgentToolLoopTurn(context, input, state);
      if (start.step) yield start.step;
      if (start.action === 'stop') return;

      while (true) {
        const result = yield* runAgentToolLoopIteration(context, input, state);
        if (result.action === 'stop') return;
      }
    } catch (error) {
      await stopAgentToolLoopTurn(context, input, state, 'error');
      throw error;
    } finally {
      await stopAgentToolLoopTurn(context, input, state);
    }
  };
}

export function createAgentToolLoopDefinition(name = 'AgentToolLoop'): AgentLoopDefinition {
  return {
    id: 'agent-tool-loop',
    name,
    description: 'Agent/tool loop that alternates between LLM output and external tool execution.',
    createRunner: (rawContext) => {
      const context = asAgentToolLoopContext(rawContext);
      return async function* agentToolLoop(input) {
        const script = await resolveAgentToolLoopScript(context);
        if (script) {
          yield* runAgentToolLoopScript(script, input, context);
          return;
        }
        yield* createAgentToolLoopRunner(context)(input);
      };
    },
  };
}
