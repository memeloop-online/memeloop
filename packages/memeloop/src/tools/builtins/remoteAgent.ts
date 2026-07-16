import { createAgentClient } from '../../orchestration/index.js';
import type { AgentOrchestrationClient } from '../../orchestration/index.js';
import { MEMELOOP_STRUCTURED_TOOL_KEY, truncateToolSummary } from '../structuredToolResult.js';
import type { BuiltinToolContext, BuiltinToolImpl } from './types.js';

const TOOL_ID = 'remoteAgent';
const REMOTE_LOG_POLL_INTERVAL_MS = 500;
const REMOTE_LOG_IDLE_POLLS = 2;

type RemoteConversationMessage = {
  messageId?: string;
  role?: string;
  content?: unknown;
};

function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return Object.prototype.toString.call(content);
  }
}

function getRemoteStreamChunkContent(chunk: unknown): unknown {
  if (chunk != null && typeof chunk === 'object' && 'content' in chunk) {
    return Reflect.get(chunk, 'content');
  }

  return undefined;
}

function summarizeRemoteMessages(messages: RemoteConversationMessage[]): string {
  const relevant = messages.filter((message) => message.role && message.role !== 'user');
  if (relevant.length === 0) {
    return '(task dispatched; waiting for remote output)';
  }
  const joined = relevant
    .map((message) => {
      const role = typeof message.role === 'string' ? message.role : 'message';
      const content = messageContentToText(message.content).trim();
      return content.length > 0 ? `[${role}] ${content}` : '';
    })
    .filter((line) => line.length > 0)
    .join('\n');
  return joined.trim() || '(task dispatched; remote messages had no readable content)';
}

async function collectRemoteConversationSummary(
  sendRpc: NonNullable<BuiltinToolContext['sendRpcToNode']>,
  nodeId: string,
  conversationId: string,
  timeoutMs: number,
): Promise<string> {
  const startedAt = Date.now();
  const knownMessageIds = new Set<string>();
  const collectedMessages: RemoteConversationMessage[] = [];
  let idlePolls = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const response = (await sendRpc(nodeId, 'memeloop.chat.pullAgentRunLog', {
      conversationId,
      knownMessageIds: [...knownMessageIds],
    })) as { messages?: RemoteConversationMessage[] };
    const newMessages = Array.isArray(response?.messages) ? response.messages : [];

    if (newMessages.length > 0) {
      idlePolls = 0;
      for (const message of newMessages) {
        if (typeof message.messageId === 'string' && message.messageId.length > 0) {
          knownMessageIds.add(message.messageId);
        }
        collectedMessages.push(message);
      }
    } else if (collectedMessages.some((message) => message.role && message.role !== 'user')) {
      idlePolls += 1;
      if (idlePolls >= REMOTE_LOG_IDLE_POLLS) {
        break;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, REMOTE_LOG_POLL_INTERVAL_MS));
  }

  return summarizeRemoteMessages(collectedMessages);
}

async function supportsAgentWorkload(client: AgentOrchestrationClient): Promise<boolean> {
  try {
    const caps = await client.getCapabilities();
    return caps.operations.includes('apply') && caps.resourceKinds.includes('AgentWorkload');
  } catch {
    return false;
  }
}

async function runRemoteAgentViaOrchestration(
  client: AgentOrchestrationClient,
  nodeId: string,
  definitionId: string,
  message: string,
  localNodeId: string | undefined,
): Promise<Record<string, unknown>> {
  const timestamp = Date.now().toString(36);
  const conversationId = `remote:${nodeId}:${definitionId}:${timestamp}`;
  const agents = createAgentClient(client);
  const workload = await agents.createWorkload({
    name: conversationId,
    profileId: definitionId,
    promptReference: message,
    completionPolicy: 'complete',
    placement: { requiredNode: nodeId },
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
  const resolvedNodeId = localNodeId?.trim() || 'local';
  return {
    summary,
    remoteNodeId: nodeId,
    remoteConversationId: conversationId,
    definitionId,
    [MEMELOOP_STRUCTURED_TOOL_KEY]: {
      summary: shortSummary,
      detailRef: {
        type: 'agent-run',
        conversationId,
        nodeId: resolvedNodeId,
        resourceVersion: result.observedResourceVersion,
      },
    },
  };
}

export const remoteAgentConfigSchema = {
  type: 'object',
  properties: {
    nodeId: { type: 'string', description: 'Target node ID to run the agent-run on' },
    definitionId: { type: 'string', description: 'Agent definition ID on that node' },
    message: { type: 'string', description: 'Task message for the remote agent' },
  },
  required: ['nodeId', 'definitionId', 'message'],
} as const;

/** List policy-filtered execution targets and capabilities. No direct peer enumeration. */
export const remoteAgentListImpl: BuiltinToolImpl = async (_arguments, context) => {
  if (context.orchestration) {
    try {
      const caps = await context.orchestration.getCapabilities();
      const targets = caps.resourceKinds.map((kind) => ({
        kind,
        interfaces: caps.interfaces,
        operations: caps.operations,
      }));
      return {
        targets,
        capabilities: caps.interfaces,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        targets: [],
        error: `Orchestration target discovery failed: ${message}`,
      };
    }
  }

  return {
    targets: [],
    error: 'Direct peer enumeration is disabled. Configure an orchestration manager to discover execution targets.',
  };
};

export const remoteAgentImpl: BuiltinToolImpl = async (arguments_, context) => {
  const nodeId = arguments_.nodeId as string | undefined;
  const definitionId = arguments_.definitionId as string | undefined;
  const message = arguments_.message as string | undefined;

  if (!nodeId || !definitionId || typeof message !== 'string') {
    return remoteAgentListImpl(arguments_, context);
  }

  try {
    if (context.orchestration && (await supportsAgentWorkload(context.orchestration))) {
      return await runRemoteAgentViaOrchestration(context.orchestration, nodeId, definitionId, message, context.localNodeId);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : messageContentToText(error);
    return { error: `remoteAgent failed: ${errorMessage}` };
  }

  const sendRpc = context.sendRpcToNode
    ? async (nodeId: string, method: string, parameters: unknown) => context.sendRpcToNode?.(nodeId, method, parameters)
    : undefined;
  if (!sendRpc) {
    return {
      error: 'Remote node RPC not configured (no sendRpcToNode). Connect to peer nodes first.',
    };
  }

  try {
    const createResult = (await sendRpc(nodeId, 'memeloop.agent.create', {
      definitionId,
    })) as { conversationId?: string };
    const conversationId = createResult?.conversationId;
    if (!conversationId) {
      return { error: 'Remote agent.create did not return conversationId', raw: createResult };
    }

    await sendRpc(nodeId, 'memeloop.agent.send', {
      conversationId,
      message,
    });

    const subscribeStream = (
      context as BuiltinToolContext & {
        subscribeRemoteStream?: (
          nodeId: string,
          conversationId: string,
          onChunk: (chunk: unknown) => void,
        ) => () => void;
      }
    ).subscribeRemoteStream;
    const streamWaitMs = context.remoteAgentStreamTimeoutMs ?? 30_000;
    const chunks: string[] = [];
    if (subscribeStream) {
      await new Promise<void>((resolve) => {
        const unsub = subscribeStream(nodeId, conversationId, (chunk) => {
          if (typeof chunk === 'string') chunks.push(chunk);
          else {
            const chunkContent = getRemoteStreamChunkContent(chunk);
            if (chunkContent !== undefined) {
              chunks.push(messageContentToText(chunkContent));
            }
          }
        });
        setTimeout(() => {
          unsub();
          resolve();
        }, streamWaitMs);
      });
    }

    const fullSummary = chunks.length > 0
      ? chunks.join('').trim()
      : await collectRemoteConversationSummary(sendRpc, nodeId, conversationId, streamWaitMs);
    const shortSummary = truncateToolSummary(fullSummary);
    return {
      summary: fullSummary,
      remoteNodeId: nodeId,
      remoteConversationId: conversationId,
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
    const message = error instanceof Error ? error.message : messageContentToText(error);
    return { error: `remoteAgent failed: ${message}` };
  }
};

export function getRemoteAgentToolId(): string {
  return TOOL_ID;
}
