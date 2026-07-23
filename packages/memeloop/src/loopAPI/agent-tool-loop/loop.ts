import type { AgentLoopDefinition } from '../types.js';
import { createAgentToolLoopRunner } from './directRunner.js';
import { asAgentToolLoopContext, resolveAgentToolLoopScript, runAgentToolLoopScript } from './scriptRunner.js';

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

export { createAgentToolLoopRunner } from './directRunner.js';

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
