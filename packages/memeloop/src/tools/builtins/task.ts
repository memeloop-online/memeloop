import type { AgentLoopStep } from '../../loopAPI/types.js';
import { createAgentClient } from '../../orchestration/index.js';
import type { AgentOrchestrationClient } from '../../orchestration/index.js';
import { safeErrorMessageFromUnknown } from '../../safeError.js';
import { MEMELOOP_STRUCTURED_TOOL_KEY, truncateToolSummary } from '../structuredToolResult.js';
import { collectAgentLoopText } from './agentLoopOutput.js';
import { type BuiltinToolContext, type BuiltinToolImpl, requireBuiltinLocalNodeId } from './types.js';

const TOOL_ID = 'task';

async function supportsAgentWorkload(client: AgentOrchestrationClient): Promise<boolean> {
  try {
    const caps = await client.getCapabilities();
    return caps.operations.includes('apply') && caps.resourceKinds.includes('AgentWorkload');
  } catch {
    return false;
  }
}

async function runTaskViaOrchestration(
  client: AgentOrchestrationClient,
  agentId: string,
  prompt: string,
  background: boolean | undefined,
  localNodeId: string | undefined,
  conversationId: string,
  permissions: { default: 'allow' | 'ask' | 'deny'; rules: Array<{ pattern: string; action: 'allow' | 'ask' | 'deny' }> },
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const agents = createAgentClient(client);
  const workload = await agents.createWorkload({
    name: conversationId,
    profileId: agentId,
    promptReference: prompt,
    completionPolicy: background ? 'detach' : 'complete',
    toolPolicy: {
      defaultAction: permissions.default,
      rules: permissions.rules,
    },
  });
  signal?.throwIfAborted();
  const run = await agents.createRun({
    name: `${conversationId}-run`,
    workloadName: workload.metadata.name,
    promptReference: prompt,
  });
  signal?.throwIfAborted();

  const nodeId = requireBuiltinLocalNodeId(localNodeId);

  if (background) {
    return {
      summary: `Background task "${agentId}" launched. Task ID: ${conversationId}`,
      conversationId,
      agentId,
      taskId: conversationId,
      background: true,
      [MEMELOOP_STRUCTURED_TOOL_KEY]: {
        summary: `[bg-task] ${agentId}: ${conversationId}`,
        detailRef: {
          type: 'agent-run' as const,
          conversationId,
          nodeId,
          resourceVersion: run.metadata.resourceVersion,
        },
      },
    };
  }

  const result = await agents.waitForRunCondition(
    run.metadata.name,
    { type: 'Completed', status: 'True' },
    { timeout: 30_000, interval: 1000, signal },
  );
  signal?.throwIfAborted();
  const finalRun = await agents.getRun(run.metadata.name);
  signal?.throwIfAborted();
  const text = finalRun?.status?.summary ?? '(no summary)';
  const shortSummary = truncateToolSummary(text);
  return {
    result: text,
    conversationId,
    agentId,
    [MEMELOOP_STRUCTURED_TOOL_KEY]: {
      summary: shortSummary,
      detailRef: {
        type: 'agent-run' as const,
        conversationId,
        nodeId,
        resourceVersion: result.observedResourceVersion,
      },
    },
  };
}

async function runTaskLocally(
  runLocalAgent: NonNullable<BuiltinToolContext['runLocalAgent']>,
  context: BuiltinToolContext,
  agentId: string,
  prompt: string,
  background: boolean | undefined,
  conversationId: string,
): Promise<Record<string, unknown>> {
  const signal = context.operationSignal;
  async function collectOutput(
    gen: AsyncIterable<AgentLoopStep>,
  ): Promise<{ text: string; conversationId: string }> {
    const text = await collectAgentLoopText(gen, signal);
    return { text, conversationId };
  }

  if (background) {
    const gen = runLocalAgent({ conversationId, message: prompt, signal });
    void collectOutput(gen).catch(() => {
      /* background errors are non-fatal */
    });

    const nodeId = requireBuiltinLocalNodeId(context.localNodeId);
    return {
      summary: `Background task "${agentId}" launched. Task ID: ${conversationId}`,
      conversationId,
      agentId,
      taskId: conversationId,
      background: true,
      [MEMELOOP_STRUCTURED_TOOL_KEY]: {
        summary: `[bg-task] ${agentId}: ${conversationId}`,
        detailRef: {
          type: 'agent-run' as const,
          conversationId,
          nodeId,
        },
      },
    };
  }

  const gen = runLocalAgent({ conversationId, message: prompt, signal });
  const { text, conversationId: cid } = await collectOutput(gen);

  const shortSummary = truncateToolSummary(text);
  const nodeId = requireBuiltinLocalNodeId(context.localNodeId);
  return {
    result: text,
    conversationId: cid,
    agentId,
    [MEMELOOP_STRUCTURED_TOOL_KEY]: {
      summary: shortSummary,
      detailRef: {
        type: 'agent-run' as const,
        conversationId: cid,
        nodeId,
      },
    },
  };
}

export const taskToolConfigSchema = {
  type: 'object',
  properties: {
    agent: {
      type: 'string',
      description: "Agent ID to delegate to (e.g. 'memeloop:build', 'memeloop:explore')",
    },
    prompt: {
      type: 'string',
      description: 'Task prompt / instructions for the delegated agent',
    },
    background: {
      type: 'boolean',
      description: 'If true, runs asynchronously and returns a task ID immediately',
    },
  },
  required: ['agent', 'prompt'],
} as const;

/**
 * Check if we're already nested too deep in agent-runs.
 * The conversationId format for agent-runs is `agentId:timestamp`.
 * We check the current conversation for nesting depth heuristics.
 */
function isTooDeeplyNested(context: { activeToolConversationId?: string }): boolean {
  const cid = context.activeToolConversationId;
  if (!cid) return false;
  // Count how many colons indicate nesting depth
  const depth = cid.split(':').length - 1;
  // Allow up to 2 levels of nesting (agent:sub:timestamp = 2 colons)
  return depth > 2;
}

/**
 * Set up per-agent tool permissions on the framework context so that
 * the AgentToolLoop's resolveToolPermission picks up the agent's restrictions.
 */
function applyAgentPermissions(
  context: { agentToolLoop?: { toolPermissions?: Record<string, unknown> } },
  agentId: string,
  defaultAction: 'allow' | 'ask' | 'deny',
  rules: Array<{ pattern: string; action: 'allow' | 'ask' | 'deny' }>,
): void {
  const tp = context.agentToolLoop ?? (context.agentToolLoop = {});
  const tperm = (tp.toolPermissions ?? (tp.toolPermissions = {})) as {
    perAgent?: Record<
      string,
      { default?: string; rules?: Array<{ pattern: string; action: string }> }
    >;
  };
  const perAgent = tperm.perAgent ?? (tperm.perAgent = {});
  perAgent[agentId] = { default: defaultAction, rules };
}

export const taskToolImpl: BuiltinToolImpl = async (arguments_, context) => {
  context.operationSignal?.throwIfAborted();
  const agentId = arguments_.agent as string | undefined;
  const prompt = arguments_.prompt as string | undefined;
  const background = arguments_.background as boolean | undefined;

  if (!agentId || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return { error: "task requires 'agent' (string) and 'prompt' (non-empty string)" };
  }

  if (isTooDeeplyNested(context)) {
    return {
      error: 'Maximum agent nesting depth exceeded. Cannot delegate further.',
    };
  }

  const registry = context.agentProfiles;
  if (!registry) return { error: 'task requires a runtime-scoped AgentProfileRegistry' };
  const agentProfile = registry.getAgentProfile(agentId);
  if (!agentProfile) {
    const available = registry
      .listAgentProfiles()
      .map((a) => a.id)
      .join(', ');
    return {
      error: `Agent "${agentId}" not found in registry. Available: [${available}]`,
    };
  }

  const permissions = {
    default: agentProfile.permissions.default,
    rules: agentProfile.permissions.rules,
  };

  const timestamp = Date.now().toString(36);
  const conversationId = `${agentProfile.id}:${timestamp}`;

  try {
    if (context.orchestration && (await supportsAgentWorkload(context.orchestration))) {
      context.operationSignal?.throwIfAborted();
      return await runTaskViaOrchestration(
        context.orchestration,
        agentProfile.id,
        prompt,
        background,
        context.localNodeId,
        conversationId,
        permissions,
        context.operationSignal,
      );
    }

    if (!context.runLocalAgent) {
      return {
        error: 'Local agent runner not configured (no runLocalAgent in context).',
      };
    }

    applyAgentPermissions(
      context as { agentToolLoop?: { toolPermissions?: Record<string, unknown> } },
      agentProfile.id,
      permissions.default,
      permissions.rules,
    );

    return await runTaskLocally(
      (input) => context.runLocalAgent!(input),
      context,
      agentProfile.id,
      prompt,
      background,
      conversationId,
    );
  } catch (error) {
    if (context.operationSignal?.aborted) context.operationSignal.throwIfAborted();
    const message = safeErrorMessageFromUnknown(error, { fallback: 'Agent task failed' });
    return {
      error: `Task execution failed: ${message}`,
      conversationId,
      agentId: agentProfile.id,
    };
  }
};

export function getTaskToolId(): string {
  return TOOL_ID;
}
