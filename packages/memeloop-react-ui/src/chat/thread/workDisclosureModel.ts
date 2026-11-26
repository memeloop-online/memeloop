import { type ConversationMessageListProjection, readConversationToolActivity } from 'memeloop';

export type WorkRow = { message: ConversationMessageListProjection; index: number };
export type WorkNode =
  | { kind: 'message'; key: string; row: WorkRow }
  | { kind: 'tools' | 'work'; key: string; steps: number; children: WorkNode[] };

export function isToolMessage(message: ConversationMessageListProjection): boolean {
  return message.role === 'tool' || message.metadata?.originalRole === 'tool' ||
    readConversationToolActivity(message.metadata?.toolActivity).length > 0 ||
    (message.metadata?.displayTruncation as { omittedFields?: string[] } | undefined)?.omittedFields?.includes('toolCalls') === true;
}

export function requiresAttention(message: ConversationMessageListProjection): boolean {
  return message.role === 'error' || message.metadata?.originalRole === 'error' ||
    message.metadata?.isError === true ||
    readConversationToolActivity(message.metadata?.toolActivity).some(item => item.isError) ||
    (message.metadata?.askQuestionAnswered !== true &&
      message.presentations?.some(item => item.toolName === 'ask-question') === true);
}

export function hasToolCommentary(message: ConversationMessageListProjection): boolean {
  return message.role !== 'tool' && message.metadata?.originalRole !== 'tool' && message.content.trim().length > 0;
}

function countSteps(rows: readonly WorkRow[]): number {
  const calls = new Set<string>();
  for (const { message } of rows) {
    const activity = readConversationToolActivity(message.metadata?.toolActivity);
    if (activity.length > 0) {
      for (const item of activity) calls.add(item.callId ?? message.messageId);
    } else if (message.role === 'tool' || message.metadata?.originalRole === 'tool') calls.add(message.messageId);
  }
  return calls.size || rows.filter(row => isToolMessage(row.message)).length;
}

function groupTools(rows: readonly WorkRow[]): WorkNode[] {
  const nodes: WorkNode[] = [];
  let pending: WorkRow[] = [];
  const flush = () => {
    const children = pending.map(row => ({ kind: 'message', key: row.message.messageId, row } as const));
    const steps = countSteps(pending);
    if (steps > 1) nodes.push({ kind: 'tools', key: `tools:${pending[0].message.messageId}`, steps, children });
    else nodes.push(...children);
    pending = [];
  };
  for (const row of rows) {
    if (isToolMessage(row.message) && !requiresAttention(row.message) && !hasToolCommentary(row.message)) pending.push(row);
    else {
      flush();
      nodes.push({ kind: 'message', key: row.message.messageId, row });
    }
  }
  flush();
  return nodes;
}

/** Only complete resident turns get a completed-work summary. */
export function buildWorkDisclosure(
  rows: readonly WorkRow[],
  options: { isRunning: boolean; hasMoreAfter: boolean },
): WorkNode[] {
  const nodes: WorkNode[] = [];
  let start = 0;
  while (start < rows.length) {
    let end = start + 1;
    while (end < rows.length && rows[end].message.turnId === rows[start].message.turnId && rows[end].message.role !== 'user') end += 1;
    const turn = rows.slice(start, end);
    const complete = turn[0].message.role === 'user' &&
      (end < rows.length || (!options.hasMoreAfter && !options.isRunning));
    let lastTool = -1;
    for (let index = turn.length - 1; index >= 0; index -= 1) {
      if (isToolMessage(turn[index].message)) {
        lastTool = index;
        break;
      }
    }
    const process = turn.slice(1, lastTool + 1);
    if (complete && lastTool > 0 && !process.some(row => requiresAttention(row.message))) {
      nodes.push({ kind: 'message', key: turn[0].message.messageId, row: turn[0] });
      nodes.push({
        kind: 'work',
        key: `work:${turn[0].message.messageId}`,
        steps: countSteps(process),
        children: groupTools(process),
      });
      nodes.push(...groupTools(turn.slice(lastTool + 1)));
    } else nodes.push(...groupTools(turn));
    start = end;
  }
  return nodes;
}
