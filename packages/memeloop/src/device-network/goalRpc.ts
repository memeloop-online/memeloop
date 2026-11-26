import type { AgentGoal, GoalClient, GoalMutation, StartGoalInput } from '../agent-management/goal.js';
import { normalizeAgentRunError } from '../runState.js';

export const GOAL_RPC_METHODS = {
  get: 'memeloop.goal.get',
  start: 'memeloop.goal.start',
  pause: 'memeloop.goal.pause',
  resume: 'memeloop.goal.resume',
  complete: 'memeloop.goal.complete',
} as const;

export interface GoalRpcContract {
  'memeloop.goal.get': { request: { conversationId: string }; response: AgentGoal | null };
  'memeloop.goal.start': { request: StartGoalInput; response: AgentGoal };
  'memeloop.goal.pause': { request: GoalMutation; response: AgentGoal };
  'memeloop.goal.resume': { request: GoalMutation; response: AgentGoal };
  'memeloop.goal.complete': { request: GoalMutation & { evidence: string }; response: AgentGoal };
}
export type GoalRpcMethod = keyof GoalRpcContract;

export function isGoalRpcMethod(method: string): method is GoalRpcMethod {
  return Object.values(GOAL_RPC_METHODS).includes(method as GoalRpcMethod);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_goal_rpc_object');
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum?: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || (maximum !== undefined && value.length > maximum)) throw new Error('invalid_goal_rpc_text');
}

function integer(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('invalid_goal_rpc_revision');
}

export function assertGoalRpcRequest(method: GoalRpcMethod, value: unknown): void {
  const input = record(value);
  text(input.conversationId, 512);
  if (method === GOAL_RPC_METHODS.start) {
    text(input.definitionId, 512);
    text(input.objective);
  } else if (method !== GOAL_RPC_METHODS.get) {
    integer(input.expectedRevision);
    if (method === GOAL_RPC_METHODS.complete) text(input.evidence);
  }
}

export function parseGoalRpcResponse<M extends GoalRpcMethod>(method: M, value: unknown): GoalRpcContract[M]['response'] {
  if (method === GOAL_RPC_METHODS.get && value === null) return null as GoalRpcContract[M]['response'];
  const goal = record(value);
  for (const key of ['id', 'conversationId', 'definitionId', 'executionNodeId']) text(goal[key], 512);
  text(goal.objective);
  text(goal.updatedAt);
  integer(goal.revision);
  if (goal.controlRevision !== undefined) integer(goal.controlRevision);
  integer(goal.round);
  if (goal.consecutiveFailures !== undefined) integer(goal.consecutiveFailures);
  if (goal.lastRunError !== undefined) normalizeAgentRunError(goal.lastRunError);
  if (!['active', 'paused', 'blocked', 'completed'].includes(goal.status as string)) throw new Error('invalid_goal_rpc_status');
  if (goal.evidence !== undefined) text(goal.evidence);
  if (goal.blockedReason !== undefined) text(goal.blockedReason);
  if (goal.nextWakeAt !== undefined) text(goal.nextWakeAt);
  if (goal.pendingRound !== undefined) {
    const pending = record(goal.pendingRound);
    text(pending.requestId, 512);
    text(pending.turnId, 512);
    text(pending.message);
    if (pending.runId !== undefined) text(pending.runId, 512);
  }
  return value as GoalRpcContract[M]['response'];
}

export function assertGoalRpcCorrelation(request: { conversationId: string }, response: AgentGoal | null): void {
  if (response && response.conversationId !== request.conversationId) throw new Error('goal_rpc_conversation_mismatch');
}

export function bindGoalRpcClient(
  request: <M extends GoalRpcMethod>(method: M, input: GoalRpcContract[M]['request']) => Promise<GoalRpcContract[M]['response']>,
): GoalClient {
  return {
    get: conversationId => request(GOAL_RPC_METHODS.get, { conversationId }),
    start: input => request(GOAL_RPC_METHODS.start, input),
    pause: input => request(GOAL_RPC_METHODS.pause, input),
    resume: input => request(GOAL_RPC_METHODS.resume, input),
    complete: input => request(GOAL_RPC_METHODS.complete, input),
  };
}
