import type { AgentFrameworkContext } from '../../types.js';
import type { AgentLoopGenerator, AgentLoopInput } from '../types.js';
import { createAgentToolLoopState, runAgentToolLoopIteration, startAgentToolLoopTurn, stopAgentToolLoopTurn } from './turnPrimitives.js';

/**
 * Direct agent/tool runner with no dynamic script-loader dependency.
 *
 * This is the portable path used by React Native. Hosts that need deployable
 * script references use `createAgentToolLoopDefinition` from the full entry.
 */
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
