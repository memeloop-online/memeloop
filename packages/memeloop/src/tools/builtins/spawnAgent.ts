import { createAgentClient } from '../../orchestration/index.js';
import type { AgentOrchestrationClient } from '../../orchestration/index.js';
import { safeErrorMessageFromUnknown } from '../../safeError.js';
import { MEMELOOP_STRUCTURED_TOOL_KEY, truncateToolSummary } from '../structuredToolResult.js';
import { collectAgentLoopText } from './agentLoopOutput.js';
import { type BuiltinToolContext, type BuiltinToolImpl, requireBuiltinLocalNodeId } from './types.js';

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
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const agents = createAgentClient(client);
  const workload = await agents.createWorkload({
    name: conversationId,
    profileId: definitionId,
    completionPolicy: 'complete',
  });
  signal?.throwIfAborted();
  const run = await agents.createRun({
    name: `${conversationId}-run`,
    workloadName: workload.metadata.name,
    promptReference: message,
  });
  signal?.throwIfAborted();
  const result = await agents.waitForRunCondition(
    run.metadata.name,
    { type: 'Completed', status: 'True' },
    { timeout: 30_000, interval: 1000, signal },
  );
  signal?.throwIfAborted();
  const finalRun = await agents.getRun(run.metadata.name);
  signal?.throwIfAborted();
  const summary = finalRun?.status?.summary ?? '(no summary)';
  const shortSummary = truncateToolSummary(summary);
  const nodeId = requireBuiltinLocalNodeId(localNodeId);
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
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const fullSummary = await collectAgentLoopText(
    runLocalAgent({ conversationId, message, signal }),
    signal,
  );
  const shortSummary = truncateToolSummary(fullSummary);
  const nodeId = requireBuiltinLocalNodeId(localNodeId);
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
  context.operationSignal?.throwIfAborted();
  const definitionId = arguments_.definitionId as string | undefined;
  const message = arguments_.message as string | undefined;

  if (!definitionId || typeof message !== 'string') {
    return { error: 'spawnAgent requires definitionId and message' };
  }

  const conversationId = `spawn:${definitionId}:${Date.now().toString(36)}`;

  try {
    if (context.orchestration && (await supportsAgentWorkload(context.orchestration))) {
      context.operationSignal?.throwIfAborted();
      return await runSpawnAgentViaOrchestration(
        context.orchestration,
        definitionId,
        message,
        conversationId,
        context.localNodeId,
        context.operationSignal,
      );
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
      context.operationSignal,
    );
  } catch (error) {
    if (context.operationSignal?.aborted) context.operationSignal.throwIfAborted();
    const errorMessage = safeErrorMessageFromUnknown(error, { fallback: 'Agent spawn failed' });
    return { error: `spawnAgent failed: ${errorMessage}`, conversationId };
  }
};

export function getSpawnAgentToolId(): string {
  return TOOL_ID;
}
