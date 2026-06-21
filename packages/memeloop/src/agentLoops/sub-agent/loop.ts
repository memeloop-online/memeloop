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
import { loadSubAgentLoopScript, type LoadSubAgentLoopScriptOptions, type SubAgentLoopScriptReference } from './scriptLoader.js';
import { BUILTIN_SUB_AGENT_SEQUENTIAL_SCRIPT_ID } from './scripts/builtinScripts.js';

const LOOP_ID = 'sub-agent';
const LOOP_NAME = 'SubAgent Loop';
const LOOP_DESC = 'Orchestrates child agents to collaborate on a task. Supports sequential chaining, parallel execution, and feedback loops.';

export interface SubAgentLoopScriptArguments {
  input: AgentLoopInput;
  context: SubAgentLoopContext;
  profile?: LoopProfile;
  agents: SubAgentDescriptor[];
  runtime?: Partial<AgentLoopRuntime>;
  runAgent: (input: SubAgentRunAgentInput) => Promise<SubAgentRunAgentResult>;
  runAgents: (inputs: SubAgentRunAgentInput[]) => Promise<SubAgentRunAgentResult[]>;
  runSequential: (input?: SubAgentBatchRunInput) => Promise<SubAgentBatchRunResult>;
  runParallel: (input?: SubAgentBatchRunInput) => Promise<SubAgentBatchRunResult>;
  formatAgentResults: (result: SubAgentBatchRunResult, options?: SubAgentFormatResultsOptions) => string;
  finishAgentResults: (result: SubAgentBatchRunResult, options?: SubAgentFormatResultsOptions) => void;
  emit: (step: AgentLoopStep) => void;
  finish: (message: string | AgentLoopStep) => void;
  isCancelled: () => boolean;
  log: (event: string, data?: Record<string, unknown>) => void;
  state: AgentLoopRuntime['state'];
  checkpoint: AgentLoopRuntime['checkpoint'];
}

export type SubAgentScriptContext = SubAgentLoopScriptArguments;

export type SubAgentContext = SubAgentScriptContext;

export interface SubAgentDescriptor {
  profileId: string;
  prompt?: string;
  conversationId?: string;
  label?: string;
  [key: string]: unknown;
}

export type SubAgentConfigEntry =
  | string
  | ({
    profileId?: string;
    profile?: string;
    prompt?: string;
    conversationId?: string;
    label?: string;
  } & Record<string, unknown>);

export interface SubAgentRunAgentInput {
  /** Child profile id. `profile` is accepted as an ergonomic alias for scripts. */
  profileId?: string;
  profile?: string;
  /** Defaults to the parent input message. */
  prompt?: string;
  conversationId?: string;
  label?: string;
}

export interface SubAgentRunAgentResult {
  profileId: string;
  conversationId: string;
  steps: AgentLoopStep[];
  text: string;
}

export interface SubAgentRunAgentFailure {
  profileId: string;
  conversationId?: string;
  error: string;
}

export interface SubAgentBatchRunInput {
  agents?: SubAgentConfigEntry[];
  prompt?: string;
  continueOnError?: boolean;
}

export interface SubAgentBatchRunResult {
  results: SubAgentRunAgentResult[];
  failures: SubAgentRunAgentFailure[];
  text: string;
}

export interface SubAgentFormatResultsOptions {
  emptyMessage?: string;
  failureHeader?: string;
  includeFailureSection?: boolean;
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
  agents?: SubAgentConfigEntry[];
  /** Legacy alias read only for older profiles. New profiles should use agents or profile.metadata.agents. */
  childProfiles?: string[];
  script?: SubAgentLoopScript;
  loadScript?: (
    script: SubAgentLoopScriptReference,
    context: SubAgentLoopContext,
  ) => SubAgentLoopScript | Promise<SubAgentLoopScript>;
  scriptPolicy?: LoadSubAgentLoopScriptOptions;
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

function profileIdFromEntry(entry: SubAgentConfigEntry): string | undefined {
  if (typeof entry === 'string') return entry;
  return entry.profileId ?? entry.profile;
}

function readProfileAgentEntries(profile?: LoopProfile): SubAgentConfigEntry[] | undefined {
  const metadata = profile?.metadata;
  if (!metadata) return undefined;

  const agents = metadata.agents;
  if (Array.isArray(agents)) return agents as SubAgentConfigEntry[];

  const subAgents = metadata.subAgents;
  if (Array.isArray(subAgents)) return subAgents as SubAgentConfigEntry[];

  const legacyChildProfiles = metadata.childProfiles;
  if (Array.isArray(legacyChildProfiles)) return legacyChildProfiles as string[];

  return undefined;
}

function normalizeSubAgents(
  input: AgentLoopInput,
  context: SubAgentLoopContext,
  entries?: SubAgentConfigEntry[],
  prompt?: string,
): SubAgentDescriptor[] {
  const configuredEntries = entries ?? context.agents ?? readProfileAgentEntries(context.profile) ?? context.childProfiles ?? [];
  return configuredEntries.flatMap((entry, index) => {
    const profileId = profileIdFromEntry(entry);
    if (!profileId) return [];
    const record = typeof entry === 'string' ? {} : entry;
    return {
      ...record,
      profileId,
      prompt: prompt ?? record.prompt,
      conversationId: record.conversationId ?? `${input.conversationId}:child:${index}`,
      label: record.label,
    };
  });
}

function formatAgentResults(
  result: SubAgentBatchRunResult,
  options: SubAgentFormatResultsOptions = {},
): string {
  const emptyMessage = options.emptyMessage ?? 'No child agent output.';
  const failureHeader = options.failureHeader ?? 'Failed child agents:';
  const includeFailureSection = options.includeFailureSection !== false;
  const sections = [result.text || emptyMessage];

  if (includeFailureSection && result.failures.length > 0) {
    sections.push(`${failureHeader}\n${result.failures.map(failure => `${failure.profileId}: ${failure.error}`).join('\n')}`);
  }

  return sections.filter(Boolean).join('\n\n');
}

function createScriptArguments(
  input: AgentLoopInput,
  context: SubAgentLoopContext,
  emittedSteps: AgentLoopStep[],
): SubAgentLoopScriptArguments {
  const agents = normalizeSubAgents(input, context);

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
    const prompt = childInput.prompt ?? input.message;
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
          prompt,
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

  const runBatch = async (
    batchInput: SubAgentBatchRunInput | undefined,
    mode: 'parallel' | 'sequential',
  ): Promise<SubAgentBatchRunResult> => {
    const batchAgents = normalizeSubAgents(input, context, batchInput?.agents, batchInput?.prompt);
    const continueOnError = batchInput?.continueOnError !== false;
    const results: SubAgentRunAgentResult[] = [];
    const failures: SubAgentRunAgentFailure[] = [];

    const runOne = async (agent: SubAgentDescriptor): Promise<void> => {
      if (isCancelled()) {
        emit({
          type: 'thinking',
          data: { status: 'cancelled', conversationId: input.conversationId },
        });
        return;
      }
      try {
        const result = await runAgent(agent);
        results.push(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ profileId: agent.profileId, conversationId: agent.conversationId, error: message });
        if (!continueOnError) throw error;
      }
    };

    if (mode === 'parallel') {
      await Promise.all(batchAgents.map(agent => runOne(agent)));
    } else {
      for (const agent of batchAgents) {
        await runOne(agent);
        if (isCancelled()) break;
      }
    }

    return { results, failures, text: results.map(result => result.text).filter(Boolean).join('\n\n') };
  };

  return {
    input,
    context,
    profile: context.profile,
    agents,
    runtime: context.runtime,
    runAgent,
    runAgents: inputs => Promise.all(inputs.map(runAgent)),
    runSequential: batchInput => runBatch(batchInput, 'sequential'),
    runParallel: batchInput => runBatch(batchInput, 'parallel'),
    formatAgentResults,
    finishAgentResults: (result, options) => {
      emit(messageStep(formatAgentResults(result, options)));
    },
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
  const scriptReference = context.profile?.scriptReference ?? context.profile?.scriptRef ?? context.profile?.script;
  if (scriptReference) {
    if (context.loadScript) return context.loadScript(scriptReference, context);
    return loadSubAgentLoopScript(scriptReference, context.scriptPolicy);
  }
  const configuredAgents = context.agents ?? readProfileAgentEntries(context.profile) ?? context.childProfiles;
  if (configuredAgents && configuredAgents.length > 0) {
    return loadSubAgentLoopScript(BUILTIN_SUB_AGENT_SEQUENTIAL_SCRIPT_ID, context.scriptPolicy);
  }
  return undefined;
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

        yield {
          type: 'thinking',
          data: { status: 'script-missing', conversationId: input.conversationId },
        };
        yield {
          type: 'message',
          data: 'SubAgent_Loop requires a loop script or agents configuration.',
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
