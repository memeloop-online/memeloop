import type { AgentDefinition } from '../../agent/types.js';
import type { ResolvedAgentModelRoute } from '../../llm/prepareModelRequest.js';
import type { AgentFrameworkContext } from '../../types.js';
import type { AgentStopData } from '../hooks/types.js';
import type { AgentLoopScriptReference } from '../scriptLoader.js';
import type { AgentLoopGenerator, AgentLoopInput, AgentLoopRuntime, AgentLoopScriptPolicy, AgentLoopStep, LoopProfile } from '../types.js';
import type { ToolProgressGuardState } from './toolProgressGuard.js';

export type LoadAgentToolLoopScriptOptions = AgentLoopScriptPolicy;

export type AgentToolLoopScriptReference = AgentLoopScriptReference;

export interface AgentToolLoopContext extends AgentFrameworkContext {
  profile?: LoopProfile;
  runtime?: Partial<AgentLoopRuntime>;
  script?: AgentToolLoopScript;
  loadScript?: (
    script: AgentToolLoopScriptReference,
    context: AgentToolLoopContext,
  ) => AgentToolLoopScript | Promise<AgentToolLoopScript>;
  scriptPolicy?: LoadAgentToolLoopScriptOptions;
}

export interface AgentToolLoopState {
  iteration: number;
  maxIterations: number;
  recentToolCalls: string[];
  toolProgressGuard: ToolProgressGuardState;
  agentStarted: boolean;
  agentStopped: boolean;
  stopReason?: AgentStopData['reason'];
  definitionId?: string;
  definition?: AgentDefinition;
  modelRoute?: ResolvedAgentModelRoute;
}

export interface AgentToolLoopTurnStartResult {
  action: 'continue' | 'stop';
  step?: AgentLoopStep;
}

export interface AgentToolLoopIterationResult {
  action: 'continue' | 'stop';
  reason?: AgentStopData['reason'];
}

export type AgentToolLoopIterationGenerator = AsyncGenerator<AgentLoopStep, AgentToolLoopIterationResult, void>;

export interface AgentToolLoopScriptContext {
  /** The host turn input. `input.message` is the user prompt for this turn. */
  input: AgentLoopInput;
  /** Full host context for advanced integrations. Prefer the primitive helpers below. */
  context: AgentToolLoopContext;
  /** Active profile selected by the registry/runtime. */
  profile?: LoopProfile;
  /** Create mutable loop state for one turn. Scripts can store it in checkpoints if they implement resume. */
  createState: () => AgentToolLoopState;
  /** Persist the user turn and run pre-agent hooks. Returns a blocking step when a hook stops the turn. */
  startTurn: (state: AgentToolLoopState) => Promise<AgentToolLoopTurnStartResult>;
  /** Run exactly one LLM/tool iteration. The script owns the surrounding loop policy. */
  runIteration: (state: AgentToolLoopState) => AgentToolLoopIterationGenerator;
  /**
   * Refresh the durable definition snapshot used by the current turn.
   *
   * Hosts may persist prompt edits while a scripted loop is still running.
   * Calling this primitive between iterations makes the next prompt build use
   * that latest snapshot without teaching scripts how to read host storage.
   */
  refreshDefinition: (state: AgentToolLoopState) => Promise<AgentDefinition>;
  /** Run AgentStop hooks once. Pass a reason when stopping because of an error outside `runIteration`. */
  stopTurn: (state: AgentToolLoopState, reason?: AgentStopData['reason']) => Promise<void>;
  /** Emit a raw loop step upstream. */
  emit: (step: AgentLoopStep) => void;
  /** Emit a user-visible message or step. */
  finish: (message: string | AgentLoopStep) => void;
  /** True when host cancellation has been requested for this conversation. */
  isCancelled: () => boolean;
  /** Write an observability event through the runtime and host logger. */
  log: (event: string, data?: Record<string, unknown>) => void;
}

export type AgentToolLoopScriptResult =
  | AgentLoopGenerator
  | AgentLoopStep
  | AgentLoopStep[]
  | string
  | undefined;

export type AgentToolLoopScript = (
  scriptContext: AgentToolLoopScriptContext,
) => AgentToolLoopScriptResult | Promise<AgentToolLoopScriptResult>;
