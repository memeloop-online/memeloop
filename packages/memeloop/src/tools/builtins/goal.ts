import type { AgentGoal } from '../../agent-management/goal.js';
import type { BuiltinToolImpl } from './types.js';

export const GOAL_TOOL_ID = 'goal';
export const GOAL_SYSTEM_PROMPT = [
  'Work toward the active goal using conversation history and available tools.',
  'A finished reply completes this round; the goal remains active.',
  'When the entire objective is achieved, call goal with action "complete" and concrete verification evidence.',
  'When progress requires user input or an external change, call goal with action "block" and the specific reason.',
].join('\n\n');

export const goalConfigSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['get', 'complete', 'block'] },
    evidence: { type: 'string', description: 'Concrete verification that the entire objective has been achieved.' },
    reason: { type: 'string', description: 'Specific user input or external change required for further progress.' },
  },
  required: ['action'],
} as const;

function result(goal: AgentGoal | null) {
  if (!goal) return { goal: null };
  return {
    id: goal.id,
    objective: goal.objective,
    status: goal.status,
    round: goal.round,
    ...(goal.evidence === undefined ? {} : { evidence: goal.evidence }),
    ...(goal.blockedReason === undefined ? {} : { blockedReason: goal.blockedReason }),
  };
}

export const goalImpl: BuiltinToolImpl = async (arguments_, context) => {
  const conversationId = context.activeToolConversationId;
  if (!context.goals || !conversationId) throw new Error('goal_host_unavailable');
  context.operationSignal?.throwIfAborted();
  if (arguments_.action === 'get') return result(await context.goals.get(conversationId));
  const runId = context.activeToolRunId;
  if (!runId) throw new Error('goal_run_identity_required');
  if (arguments_.action === 'complete' && typeof arguments_.evidence === 'string') {
    return result(await context.goals.completeFromRun(conversationId, runId, arguments_.evidence));
  }
  if (arguments_.action === 'block' && typeof arguments_.reason === 'string') {
    return result(await context.goals.blockFromRun(conversationId, runId, arguments_.reason));
  }
  throw new Error('goal_action_requires_evidence_or_reason');
};
