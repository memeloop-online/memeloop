import { MEMELOOP_STRUCTURED_TOOL_KEY, truncateToolSummary } from '../structuredToolResult.js';
import type { BuiltinToolImpl } from './types.js';

const TOOL_ID = 'spawnAgent';

export const spawnAgentConfigSchema = {
  type: 'object',
  properties: {
    definitionId: { type: 'string', description: 'Agent definition ID to use for the agent-run' },
    message: { type: 'string', description: 'User message / task for the agent-run' },
  },
  required: ['definitionId', 'message'],
} as const;

export const spawnAgentImpl: BuiltinToolImpl = async (arguments_, context) => {
  const definitionId = arguments_.definitionId as string | undefined;
  const message = arguments_.message as string | undefined;

  if (!definitionId || typeof message !== 'string') {
    return { error: 'spawnAgent requires definitionId and message' };
  }

  if (!context.runLocalAgent) {
    return {
      error: 'Local agent runner not configured (no runLocalAgent in context).',
    };
  }

  const conversationId = `spawn:${definitionId}:${Date.now().toString(36)}`;
  const chunks: string[] = [];

  try {
    for await (const step of context.runLocalAgent({ conversationId, message })) {
      if (step.type === 'message' && typeof step.data === 'string') {
        chunks.push(step.data);
      }
      if (
        step.type === 'message' &&
        step.data != null &&
        typeof step.data === 'object' &&
        'content' in step.data
      ) {
        const c = (step.data as { content?: string }).content;
        if (typeof c === 'string') chunks.push(c);
      }
    }
    const fullSummary = chunks.join('').trim() || '(no text output)';
    const shortSummary = truncateToolSummary(fullSummary);
    const nodeId = context.localNodeId?.trim() || 'local';
    return {
      summary: fullSummary,
      conversationId,
      definitionId,
      [MEMELOOP_STRUCTURED_TOOL_KEY]: {
        summary: shortSummary,
        detailRef: {
          type: 'agent-run',
          conversationId,
          nodeId,
        },
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `spawnAgent failed: ${message}`, conversationId };
  }
};

export function getSpawnAgentToolId(): string {
  return TOOL_ID;
}
