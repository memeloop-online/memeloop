/**
 * SubAgent_Loop — a loop that orchestrates child agents.
 *
 * This loop does NOT call the LLM directly. Instead it coordinates child agents:
 * - running a child agent and feeding its result to another child agent (review / verify)
 * - splitting work across multiple parallel child agents
 * - looping back to a child agent with feedback when a reviewer rejects the output
 *
 * The loop script (.mjs) holds the orchestration logic. This file provides the
 * runtime that invokes the script and manages child agent runs.
 */

import type { AgentLoopDefinition, AgentLoopGenerator, AgentLoopInput, AgentLoopRuntime, LoopProfile } from '../types.js';
import { loadSubAgentLoopScript } from './scriptLoader.js';

const LOOP_ID = 'sub-agent';
const LOOP_NAME = 'SubAgent Loop';
const LOOP_DESC = 'Orchestrates child agents to collaborate on a task. Supports sequential chaining, parallel execution, and feedback loops.';

export interface SubAgentLoopScriptArguments {
  input: AgentLoopInput;
  context: SubAgentLoopContext;
  profile?: LoopProfile;
  runtime?: Pick<AgentLoopRuntime, 'runChildAgent' | 'log'>;
}

export type SubAgentLoopScript = (
  scriptArguments: SubAgentLoopScriptArguments,
) => AgentLoopGenerator | Promise<AgentLoopGenerator>;

export interface SubAgentLoopContext {
  [key: string]: unknown;
  profile?: LoopProfile;
  runtime?: Pick<AgentLoopRuntime, 'runChildAgent' | 'log'>;
  childProfiles?: string[];
  script?: SubAgentLoopScript;
  loadScript?: (
    script: string,
    context: SubAgentLoopContext,
  ) => SubAgentLoopScript | Promise<SubAgentLoopScript>;
}

function asSubAgentContext(context: { [key: string]: unknown }): SubAgentLoopContext {
  return context as SubAgentLoopContext;
}

async function resolveScript(
  context: SubAgentLoopContext,
): Promise<SubAgentLoopScript | undefined> {
  if (context.script) return context.script;
  const scriptPath = context.profile?.script;
  if (!scriptPath) return undefined;
  if (context.loadScript) return context.loadScript(scriptPath, context);
  return loadSubAgentLoopScript(scriptPath);
}

async function* runConfiguredChildProfiles(
  input: AgentLoopInput,
  context: SubAgentLoopContext,
): AgentLoopGenerator {
  const childProfiles = context.childProfiles ?? [];
  const runChildAgent = context.runtime?.runChildAgent;
  const summaries: string[] = [];

  for (let index = 0; index < childProfiles.length; index += 1) {
    const profileId = childProfiles[index];
    const childConversationId = `${input.conversationId}:child:${index}`;
    yield {
      type: 'thinking',
      data: { status: 'child-agent-started', profileId, conversationId: childConversationId },
    };

    if (!runChildAgent) {
      yield {
        type: 'thinking',
        data: { status: 'child-agent-unavailable', profileId, conversationId: childConversationId },
      };
      continue;
    }

    for await (
      const step of runChildAgent({
        profileId,
        prompt: input.message,
        conversationId: childConversationId,
      })
    ) {
      yield {
        type: 'thinking',
        data: { status: 'child-agent-step', profileId, conversationId: childConversationId, step },
      };
      if (step.type === 'message') {
        summaries.push(typeof step.data === 'string' ? step.data : JSON.stringify(step.data));
      }
    }

    yield {
      type: 'thinking',
      data: { status: 'child-agent-completed', profileId, conversationId: childConversationId },
    };
  }

  yield {
    type: 'message',
    data: summaries.length > 0 ? summaries.join('\n\n') : 'No child agent output.',
  };
}

/**
 * Create the SubAgent_Loop definition and register it with the loop registry.
 */
export function createSubAgentLoopDefinition(): AgentLoopDefinition {
  return {
    id: LOOP_ID,
    name: LOOP_NAME,
    description: LOOP_DESC,
    createRunner: (rawContext) => {
      return async function* subAgentLoop(input) {
        const context = asSubAgentContext(rawContext);
        const script = await resolveScript(context);

        yield {
          type: 'thinking',
          data: { status: 'sub-agent-loop-started', conversationId: input.conversationId },
        };
        context.runtime?.log?.('sub-agent-loop-started', {
          conversationId: input.conversationId,
          profileId: context.profile?.id,
        });

        if (script) {
          yield* await script({
            input,
            context,
            profile: context.profile,
            runtime: context.runtime,
          });
          yield {
            type: 'thinking',
            data: { status: 'completed', conversationId: input.conversationId },
          };
          return;
        }

        if (context.childProfiles && context.childProfiles.length > 0) {
          yield* runConfiguredChildProfiles(input, context);
          yield {
            type: 'thinking',
            data: { status: 'completed', conversationId: input.conversationId },
          };
          return;
        }

        yield {
          type: 'thinking',
          data: { status: 'script-missing', conversationId: input.conversationId },
        };
        yield {
          type: 'message',
          data: 'SubAgent_Loop requires a loop script or childProfiles configuration.',
        };
        yield {
          type: 'thinking',
          data: { status: 'completed', conversationId: input.conversationId },
        };
      };
    },
  };
}

/** Export loop id for consumers. */
export function getSubAgentLoopId(): string {
  return LOOP_ID;
}
