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

import type { AgentLoopDefinition, AgentLoopGenerator, AgentLoopInput, AgentLoopRuntime, AgentLoopStep, LoopProfile } from '../types.js';
import { loadSubAgentLoopScript } from './scriptLoader.js';

const LOOP_ID = 'sub-agent';
const LOOP_NAME = 'SubAgent Loop';
const LOOP_DESC = 'Orchestrates child agents to collaborate on a task. Supports sequential chaining, parallel execution, and feedback loops.';

export interface SubAgentLoopScriptArguments {
  input: AgentLoopInput;
  context: SubAgentLoopContext;
  profile?: LoopProfile;
  runtime?: Partial<AgentLoopRuntime>;
  runAgent: (input: SubAgentRunAgentInput) => Promise<SubAgentRunAgentResult>;
  runAgents: (inputs: SubAgentRunAgentInput[]) => Promise<SubAgentRunAgentResult[]>;
  emit: (step: AgentLoopStep) => void;
  finish: (message: string | AgentLoopStep) => void;
  isCancelled: () => boolean;
  log: (event: string, data?: Record<string, unknown>) => void;
  state: AgentLoopRuntime['state'];
  checkpoint: AgentLoopRuntime['checkpoint'];
}

export interface SubAgentRunAgentInput {
  /** Child profile id. `profile` is accepted as an ergonomic alias for scripts. */
  profileId?: string;
  profile?: string;
  prompt: string;
  conversationId?: string;
}

export interface SubAgentRunAgentResult {
  profileId: string;
  conversationId: string;
  steps: AgentLoopStep[];
  text: string;
}

export type SubAgentLoopScriptResult =
  | AgentLoopGenerator
  | AgentLoopStep
  | AgentLoopStep[]
  | string
  | undefined;

export type SubAgentLoopScript = (
  scriptArguments: SubAgentLoopScriptArguments,
) => SubAgentLoopScriptResult | Promise<SubAgentLoopScriptResult>;

export interface SubAgentLoopContext {
  [key: string]: unknown;
  profile?: LoopProfile;
  runtime?: Partial<AgentLoopRuntime>;
  childProfiles?: string[];
  script?: SubAgentLoopScript;
  loadScript?: (
    script: string,
    context: SubAgentLoopContext,
  ) => SubAgentLoopScript | Promise<SubAgentLoopScript>;
}

function isAsyncIterable(value: unknown): value is AgentLoopGenerator {
  return Boolean(value && typeof value === 'object' && Symbol.asyncIterator in value);
}

function messageStep(message: string): AgentLoopStep {
  return { type: 'message', data: message };
}

function stepText(step: AgentLoopStep): string | undefined {
  if (step.type !== 'message') return undefined;
  if (typeof step.data === 'string') return step.data;
  if (step.data && typeof step.data === 'object' && 'content' in step.data) {
    const content = (step.data as { content?: unknown }).content;
    return typeof content === 'string' ? content : undefined;
  }
  return undefined;
}

function createScriptArguments(
  input: AgentLoopInput,
  context: SubAgentLoopContext,
  emittedSteps: AgentLoopStep[],
): SubAgentLoopScriptArguments {
  const emit = (step: AgentLoopStep): void => {
    emittedSteps.push(step);
    context.runtime?.emit?.(step);
  };

  const log = (event: string, data?: Record<string, unknown>): void => {
    context.runtime?.log?.(event, data);
  };

  const isCancelled = (): boolean => context.runtime?.signal?.cancelled === true;

  const runAgent = async (childInput: SubAgentRunAgentInput): Promise<SubAgentRunAgentResult> => {
    if (isCancelled()) throw new Error('SubAgent_Loop cancelled before child agent start');
    const profileId = childInput.profileId ?? childInput.profile;
    if (!profileId) throw new Error('ctx.runAgent requires profileId or profile');
    if (!context.runtime?.runChildAgent) throw new Error('ctx.runAgent requires runtime.runChildAgent');

    const childConversationId = childInput.conversationId ?? `${input.conversationId}:child:${profileId}:${Date.now().toString(36)}`;
    emit({
      type: 'thinking',
      data: { status: 'child-agent-started', profileId, conversationId: childConversationId },
    });

    const steps: AgentLoopStep[] = [];
    const chunks: string[] = [];
    try {
      for await (
        const step of context.runtime.runChildAgent({
          profileId,
          prompt: childInput.prompt,
          conversationId: childConversationId,
        })
      ) {
        if (isCancelled()) throw new Error('SubAgent_Loop cancelled during child agent run');
        steps.push(step);
        const text = stepText(step);
        if (text) chunks.push(text);
        emit({
          type: 'thinking',
          data: { status: 'child-agent-step', profileId, conversationId: childConversationId, step },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({
        type: 'thinking',
        data: { status: 'child-agent-failed', profileId, conversationId: childConversationId, error: message },
      });
      throw error;
    }

    emit({
      type: 'thinking',
      data: { status: 'child-agent-completed', profileId, conversationId: childConversationId },
    });
    return { profileId, conversationId: childConversationId, steps, text: chunks.join('').trim() };
  };

  return {
    input,
    context,
    profile: context.profile,
    runtime: context.runtime,
    runAgent,
    runAgents: inputs => Promise.all(inputs.map(runAgent)),
    emit,
    finish: message => {
      emit(typeof message === 'string' ? messageStep(message) : message);
    },
    isCancelled,
    log,
    state: context.runtime?.state ?? {
      get: async () => undefined,
      set: async () => undefined,
      update: async () => undefined,
    },
    checkpoint: context.runtime?.checkpoint ?? (async () => undefined),
  };
}

async function* drainEmittedSteps(steps: AgentLoopStep[]): AgentLoopGenerator {
  while (steps.length > 0) {
    const step = steps.shift();
    if (step) yield step;
  }
}

async function* runScript(
  script: SubAgentLoopScript,
  input: AgentLoopInput,
  context: SubAgentLoopContext,
): AgentLoopGenerator {
  const emittedSteps: AgentLoopStep[] = [];
  const scriptArguments = createScriptArguments(input, context, emittedSteps);
  const result = await script(scriptArguments);

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
  const failures: string[] = [];

  for (let index = 0; index < childProfiles.length; index += 1) {
    if (context.runtime?.signal?.cancelled) {
      yield {
        type: 'thinking',
        data: { status: 'cancelled', conversationId: input.conversationId },
      };
      return;
    }

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

    try {
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
        const text = stepText(step);
        if (text) summaries.push(text);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${profileId}: ${message}`);
      yield {
        type: 'thinking',
        data: { status: 'child-agent-failed', profileId, conversationId: childConversationId, error: message },
      };
      continue;
    }

    yield {
      type: 'thinking',
      data: { status: 'child-agent-completed', profileId, conversationId: childConversationId },
    };
  }

  yield {
    type: 'message',
    data: [
      summaries.length > 0 ? summaries.join('\n\n') : 'No child agent output.',
      failures.length > 0 ? `Failed child agents:\n${failures.join('\n')}` : '',
    ].filter(Boolean).join('\n\n'),
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
          yield* runScript(script, input, context);
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
