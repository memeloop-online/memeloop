import type { AgentRunError } from '../runState.js';
import type { MemeLoopRuntime } from '../runtime.js';

export type AgentGoalStatus = 'active' | 'paused' | 'blocked' | 'completed';

export interface AgentGoal {
  id: string;
  conversationId: string;
  definitionId: string;
  executionNodeId: string;
  objective: string;
  status: AgentGoalStatus;
  revision: number;
  /** Last user/tool state transition; round bookkeeping only advances revision. */
  controlRevision?: number;
  round: number;
  pendingRound?: {
    requestId: string;
    turnId: string;
    message: string;
    runId?: string;
  };
  nextWakeAt?: string;
  consecutiveFailures?: number;
  lastRunError?: AgentRunError;
  evidence?: string;
  blockedReason?: string;
  updatedAt: string;
}

/** One current goal per conversation; writes atomically compare the stored revision. */
export interface GoalStore {
  get(conversationId: string): Promise<AgentGoal | null>;
  save(goal: AgentGoal, expectedRevision: number | null): Promise<boolean>;
  listActive(executionNodeId: string, cursor?: string): Promise<{ items: AgentGoal[]; nextCursor?: string }>;
}

export interface GoalMutation {
  conversationId: string;
  expectedRevision: number;
}

export interface StartGoalInput {
  conversationId: string;
  definitionId: string;
  objective: string;
}

export interface GoalClient {
  get(conversationId: string): Promise<AgentGoal | null>;
  start(input: StartGoalInput): Promise<AgentGoal>;
  pause(input: GoalMutation): Promise<AgentGoal>;
  resume(input: GoalMutation): Promise<AgentGoal>;
  complete(input: GoalMutation & { evidence: string }): Promise<AgentGoal>;
}

export interface GoalToolHost {
  /** Revalidate a matching pending goal round before dispatch or crash recovery. */
  prepareRound?(conversationId: string, requestId: string): Promise<boolean>;
  get(conversationId: string): Promise<AgentGoal | null>;
  completeFromRun(conversationId: string, runId: string, evidence: string): Promise<AgentGoal>;
  blockFromRun(conversationId: string, runId: string, reason: string): Promise<AgentGoal>;
}

/** A custom loop controls only the goal belonging to its current durable run. */
export interface GoalScriptClient {
  get(): Promise<AgentGoal | null>;
  complete(evidence: string): Promise<AgentGoal>;
  block(reason: string): Promise<AgentGoal>;
}

export function bindGoalScriptClient(host: GoalToolHost | undefined, input: { conversationId: string; runId?: string; signal?: AbortSignal }): GoalScriptClient | undefined {
  if (!host || !input.runId) return undefined;
  const { conversationId, runId, signal } = input;
  return {
    get: () => host.get(conversationId),
    complete: evidence => {
      signal?.throwIfAborted();
      return host.completeFromRun(conversationId, runId, evidence);
    },
    block: reason => {
      signal?.throwIfAborted();
      return host.blockFromRun(conversationId, runId, reason);
    },
  };
}

export type GoalRuntime = Pick<MemeLoopRuntime, 'sendMessage' | 'getRunStatus' | 'cancelRun' | 'subscribeToUpdates'>;

export interface GoalClock {
  now(): Date;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}
