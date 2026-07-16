import { createAgentClient } from '../../orchestration/index.js';
import type { AgentOrchestrationClient } from '../../orchestration/index.js';
import { MEMELOOP_STRUCTURED_TOOL_KEY, truncateToolSummary } from '../structuredToolResult.js';
import type { BuiltinToolContext, BuiltinToolImpl } from './types.js';

const TOOL_ID = 'spawnAgent';

async function supportsAgentWorkload(client: AgentOrchestrationClient): Promise<boolean> {
  try {
    const caps = await client.getCapabilities();
    return caps.operations.includes('apply') && caps.resourceKinds.includes('AgentWorkload');
  } catch {
    return false;
  }
}

async function runSpawnAgentViaOrchestration(
  client: AgentOrchestrationClient,
  definitionId: string,
  message: string,
  conversationId: string,
  localNodeId: string | undefined,
): Promise<Record<string, unknown>> {
  const agents = createAgentClient(client);
  const workload = await agents.createWorkload({
    name: conversationId,
    profileId: definitionId,
    completionPolicy: 'complete',
  });
  const run = await agents.createRun({
    name: `${conversationId}-run`,
    workloadName: workload.metadata.name,
    promptReference: message,
  });
  const result = await agents.waitForRunCondition(
    run.metadata.name,
    { type: 'Completed', status: 'True' },
    { timeout: 30_000, interval: 1000 },
  );
  const finalRun = await agents.getRun(run.metadata.name);
  const summary = finalRun?.status?.summary ?? '(no summary)';
  const shortSummary = truncateToolSummary(summary);
  const nodeId = localNodeId?.trim() || 'local';
  return {
    summary,
    conversationId,
    definitionId,
    [MEMELOOP_STRUCTURED_TOOL_KEY]: {
      summary: shortSummary,
      detailRef: {
        type: 'agent-run',
        conversationId,
        nodeId,
        resourceVersion: result.observedResourceVersion,
      },
    },
  };
}

async function runSpawnAgentLocally(
  runLocalAgent: NonNullable<BuiltinToolContext['runLocalAgent']>,
  definitionId: string,
  message: string,
  conversationId: string,
  localNodeId: string | undefined,
): Promise<Record<string, unknown>> {
  const chunks: string[] = [];
  for await (const step of runLocalAgent({ conversationId, message })) {
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
  const nodeId = localNodeId?.trim() || 'local';
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
}

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

  const conversationId = `spawn:${definitionId}:${Date.now().toString(36)}`;

  try {
    if (context.orchestration && (await supportsAgentWorkload(context.orchestration))) {
      return await runSpawnAgentViaOrchestration(context.orchestration, definitionId, message, conversationId, context.localNodeId);
    }

    if (!context.runLocalAgent) {
      return {
        error: 'Local agent runner not configured (no runLocalAgent in context).',
      };
    }
    return await runSpawnAgentLocally(
      (input) => context.runLocalAgent!(input),
      definitionId,
      message,
      conversationId,
      context.localNodeId,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { error: `spawnAgent failed: ${errorMessage}`, conversationId };
  }
};

export function getSpawnAgentToolId(): string {
  return TOOL_ID;
}
