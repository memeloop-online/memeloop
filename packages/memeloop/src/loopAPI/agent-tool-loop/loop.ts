import { getLoadedScriptMetadata } from '../scriptLoader.js';
import type { AgentLoopDefinition } from '../types.js';
import { createAgentToolLoopRunner } from './directRunner.js';
import { loadAgentToolLoopScript } from './scriptLoader.js';
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
    resolveCapabilities: async ({ profile, scriptPolicy }) => {
      if (!profile.scriptReference) return {};
      const script = await loadAgentToolLoopScript(profile.scriptReference, scriptPolicy);
      return getLoadedScriptMetadata(script)?.capabilities ?? {};
    },
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
