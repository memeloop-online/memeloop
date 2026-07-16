/**
 * AgentAgent_Loop — a loop that orchestrates child agents.
 *
 * This loop does NOT call the LLM directly. Instead it coordinates child agents:
 * - running a child agent and feeding its result to another child agent (review / verify)
 * - splitting work across multiple parallel child agents
 * - looping back to a child agent with feedback when a reviewer rejects the output
 *
 * The loop script (.mjs) holds the orchestration logic. This file provides the
 * runtime that invokes the script and manages child agent runs.
 */

import type { AgentClient, AgentOrchestrationClient } from '../../orchestration/index.js';
import { createAgentClient } from '../../orchestration/index.js';
import type { AgentLoopDefinition, AgentLoopGenerator, AgentLoopInput, AgentLoopRuntime, AgentLoopStep, LoopProfile } from '../types.js';
import { type AgentAgentLoopScriptReference, loadAgentAgentLoopScript, type LoadAgentAgentLoopScriptOptions } from './scriptLoader.js';

const LOOP_ID = 'agent-agent-loop';
const LOOP_NAME = 'AgentAgent Loop';
const LOOP_DESC = 'Orchestrates child agents to collaborate on a task. Supports sequential chaining, parallel execution, and feedback loops.';

/**
 * Typed API passed to a AgentAgent `.mjs` script.
 *
 * The API is intentionally primitive: scripts decide the workflow shape, role
 * names, approval rules, retry limits, and delivery gates. This runtime only
 * handles child-agent execution, progress events, cancellation, state, and
 * checkpoints.
 */
export interface AgentAgentLoopScriptArguments {
  /** The parent turn input. `input.message` is the user's original goal. */
  input: AgentLoopInput;
  /** Host/runtime context for advanced integrations. Prefer the typed helpers below when possible. */
  context: AgentAgentLoopContext;
  /** Active profile. Scripts may define their own workflow-specific metadata keys here. */
  profile?: LoopProfile;
  /** Normalized worker agents read from `context.agents` or `profile.metadata.agents`. */
  agents: AgentAgentDescriptor[];
  /**
   * Read raw agent entries from `profile.metadata[key]`; defaults to `agents`.
   * This is deliberately generic so scripts can choose names like `critics`,
   * `builders`, `verifiers`, or any other workflow-specific role.
   */
  getAgentEntries: (key?: string) => AgentAgentConfigEntry[];
  /** Low-level runtime hooks. Prefer `state`, `checkpoint`, `emit`, and run helpers first. */
  runtime?: Partial<AgentLoopRuntime>;
  /** Policy-scoped declarative manager facade. It never exposes raw infrastructure drivers or secrets. */
  orchestration?: AgentOrchestrationClient;
  /** Typed convenience client for creating, reading, and deleting Agent workloads and runs. */
  agentClient?: AgentClient;
  /** Run one child agent and collect all yielded steps into a text result. */
  runAgent: (input: AgentAgentRunAgentInput) => Promise<AgentAgentRunAgentResult>;
  /** Run child agents concurrently. Use `runSequential` when order matters. */
  runAgents: (inputs: AgentAgentRunAgentInput[]) => Promise<AgentAgentRunAgentResult[]>;
  /** Run a batch of agents in order, aggregating successful output and failures. */
  runSequential: (input?: AgentAgentBatchRunInput) => Promise<AgentAgentBatchRunResult>;
  /** Run a batch of agents concurrently, aggregating successful output and failures. */
  runParallel: (input?: AgentAgentBatchRunInput) => Promise<AgentAgentBatchRunResult>;
  /** Format a batch result for final delivery or an intermediate report. */
  formatAgentResults: (result: AgentAgentBatchRunResult, options?: AgentAgentFormatResultsOptions) => string;
  /** Emit a formatted batch result as the parent loop's final/user-visible message. */
  finishAgentResults: (result: AgentAgentBatchRunResult, options?: AgentAgentFormatResultsOptions) => void;
  /** Emit a raw loop step upstream. Use sparingly; helpers already emit progress. */
  emit: (step: AgentLoopStep) => void;
  /** Emit a user-visible message or step and end the script's work. */
  finish: (message: string | AgentLoopStep) => void;
  /** True when the host cancelled this parent run. Long-running scripts should check this between phases. */
  isCancelled: () => boolean;
  /** Write an observability event through the host runtime logger. */
  log: (event: string, data?: Record<string, unknown>) => void;
  /** Per-run persistent state scoped by the host runtime. */
  state: AgentLoopRuntime['state'];
  /** Record a resumable milestone for long workflows. */
  checkpoint: AgentLoopRuntime['checkpoint'];
}

export type AgentAgentScriptContext = AgentAgentLoopScriptArguments;

export type AgentAgentContext = AgentAgentScriptContext;

export interface AgentAgentDescriptor {
  /** Child profile id to run. */
  profileId: string;
  /** Prompt override for this child run. Defaults to the parent input message. */
  prompt?: string;
  /** Conversation id override. Defaults to `${parent}:child:${index}` for batch helpers. */
  conversationId?: string;
  /** Optional human-readable role label, e.g. "implementer" or "reviewer". */
  label?: string;
  [key: string]: unknown;
}

export type AgentAgentConfigEntry =
  | string
  | ({
    profileId?: string;
    profile?: string;
    prompt?: string;
    conversationId?: string;
    label?: string;
  } & Record<string, unknown>);

export interface AgentAgentRunAgentInput {
  /** Child profile id. `profile` is accepted as an ergonomic alias for scripts. */
  profileId?: string;
  profile?: string;
  /** Defaults to the parent input message. */
  prompt?: string;
  conversationId?: string;
  label?: string;
}

export interface AgentAgentRunAgentResult {
  profileId: string;
  conversationId: string;
  steps: AgentLoopStep[];
  text: string;
}

export interface AgentAgentRunAgentFailure {
  profileId: string;
  conversationId?: string;
  error: string;
}

export interface AgentAgentBatchRunInput {
  /** Agents to run. Defaults to `ctx.agents`. */
  agents?: AgentAgentConfigEntry[];
  /** Prompt shared by every agent in this batch. Defaults to the parent input message. */
  prompt?: string;
  /** When false, the first child failure rejects the batch. Defaults to true. */
  continueOnError?: boolean;
}

export interface AgentAgentBatchRunResult {
  results: AgentAgentRunAgentResult[];
  failures: AgentAgentRunAgentFailure[];
  text: string;
}

export interface AgentAgentFormatResultsOptions {
  emptyMessage?: string;
  failureHeader?: string;
  includeFailureSection?: boolean;
}

export type AgentAgentLoopScriptResult =
  | AgentLoopGenerator
  | AgentLoopStep
  | AgentLoopStep[]
  | string
  | undefined;

export type AgentAgentLoopScript = (
  scriptArguments: AgentAgentLoopScriptArguments,
) => AgentAgentLoopScriptResult | Promise<AgentAgentLoopScriptResult>;

export interface AgentAgentLoopContext {
  [key: string]: unknown;
  profile?: LoopProfile;
  runtime?: Partial<AgentLoopRuntime>;
  agents?: AgentAgentConfigEntry[];
  script?: AgentAgentLoopScript;
  loadScript?: (
    script: AgentAgentLoopScriptReference,
    context: AgentAgentLoopContext,
  ) => AgentAgentLoopScript | Promise<AgentAgentLoopScript>;
  scriptPolicy?: LoadAgentAgentLoopScriptOptions;
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

function profileIdFromEntry(entry: AgentAgentConfigEntry): string | undefined {
  if (typeof entry === 'string') return entry;
  return entry.profileId ?? entry.profile;
}

function readProfileAgentEntries(profile?: LoopProfile, key = 'agents'): AgentAgentConfigEntry[] | undefined {
  const metadata = profile?.metadata;
  if (!metadata) return undefined;

  const entries = metadata[key];
  if (Array.isArray(entries)) return entries as AgentAgentConfigEntry[];

  return undefined;
}

function normalizeAgentAgents(
  input: AgentLoopInput,
  context: AgentAgentLoopContext,
  entries?: AgentAgentConfigEntry[],
  prompt?: string,
): AgentAgentDescriptor[] {
  const configuredEntries = entries ?? context.agents ?? readProfileAgentEntries(context.profile) ?? [];
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
  result: AgentAgentBatchRunResult,
  options: AgentAgentFormatResultsOptions = {},
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
  context: AgentAgentLoopContext,
  emittedSteps: AgentLoopStep[],
): AgentAgentLoopScriptArguments {
  const agentEntries = context.agents ?? readProfileAgentEntries(context.profile) ?? [];
  const agents = normalizeAgentAgents(input, context, agentEntries);
  const getAgentEntries = (key = 'agents'): AgentAgentConfigEntry[] => {
    if (key === 'agents') return agentEntries;
    return readProfileAgentEntries(context.profile, key) ?? [];
  };

  const emit = (step: AgentLoopStep): void => {
    emittedSteps.push(step);
    context.runtime?.emit?.(step);
  };

  const log = (event: string, data?: Record<string, unknown>): void => {
    context.runtime?.log?.(event, data);
  };

  const isCancelled = (): boolean => context.runtime?.signal?.cancelled === true;

  const runAgent = async (childInput: AgentAgentRunAgentInput): Promise<AgentAgentRunAgentResult> => {
    if (isCancelled()) throw new Error('AgentAgent_Loop cancelled before child agent start');
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
        if (isCancelled()) throw new Error('AgentAgent_Loop cancelled during child agent run');
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
    batchInput: AgentAgentBatchRunInput | undefined,
    mode: 'parallel' | 'sequential',
  ): Promise<AgentAgentBatchRunResult> => {
    const batchAgents = normalizeAgentAgents(input, context, batchInput?.agents, batchInput?.prompt);
    const continueOnError = batchInput?.continueOnError !== false;
    const results: AgentAgentRunAgentResult[] = [];
    const failures: AgentAgentRunAgentFailure[] = [];

    const runOne = async (agent: AgentAgentDescriptor): Promise<void> => {
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

  const agentClient = context.runtime?.orchestration ? createAgentClient(context.runtime.orchestration) : undefined;

  return {
    input,
    context,
    profile: context.profile,
    agents,
    getAgentEntries,
    runtime: context.runtime,
    orchestration: context.runtime?.orchestration,
    agentClient,
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
  script: AgentAgentLoopScript,
  input: AgentLoopInput,
  context: AgentAgentLoopContext,
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

function asAgentAgentContext(context: { [key: string]: unknown }): AgentAgentLoopContext {
  return context as AgentAgentLoopContext;
}

async function resolveScript(
  context: AgentAgentLoopContext,
): Promise<AgentAgentLoopScript | undefined> {
  if (context.script) return context.script;
  const scriptReference = context.profile?.scriptReference ?? context.profile?.scriptRef ?? context.profile?.script;
  if (scriptReference) {
    if (context.loadScript) return context.loadScript(scriptReference, context);
    return loadAgentAgentLoopScript(scriptReference, context.scriptPolicy);
  }
  return undefined;
}

/**
 * Create the AgentAgent_Loop definition and register it with the loop registry.
 */
export function createAgentAgentLoopDefinition(): AgentLoopDefinition {
  return {
    id: LOOP_ID,
    name: LOOP_NAME,
    description: LOOP_DESC,
    createRunner: (rawContext) => {
      return async function* agentAgentLoop(input) {
        const context = asAgentAgentContext(rawContext);
        const script = await resolveScript(context);

        yield {
          type: 'thinking',
          data: { status: 'agent-agent-loop-loop-started', conversationId: input.conversationId },
        };
        context.runtime?.log?.('agent-agent-loop-loop-started', {
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
          data: 'AgentAgentLoop requires an explicit loop script. Configure profile.scriptReference or provide context.script.',
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
export function getAgentAgentLoopId(): string {
  return LOOP_ID;
}
