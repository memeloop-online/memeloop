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
    const response = (await sendRpc(nodeId, 'memeloop.chat.pullSubAgentLog', {
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

export const remoteAgentConfigSchema = {
  type: 'object',
  properties: {
    nodeId: { type: 'string', description: 'Target node ID to run the sub-agent on' },
    definitionId: { type: 'string', description: 'Agent definition ID on that node' },
    message: { type: 'string', description: 'Task message for the remote agent' },
  },
  required: ['nodeId', 'definitionId', 'message'],
} as const;

/** List nodes and their definitions (for tool description / agent choice). No args. */
export const remoteAgentListImpl: BuiltinToolImpl = async (_arguments, context) => {
  const getPeers = context.getPeers ? async () => context.getPeers?.() : undefined;
  const sendRpc = context.sendRpcToNode
    ? async (nodeId: string, method: string, parameters: unknown) => context.sendRpcToNode?.(nodeId, method, parameters)
    : undefined;

  if (!getPeers) {
    return { nodes: [], error: 'Peer list not configured (no getPeers).' };
  }

  const peers = (await getPeers()) ?? [];
  const online = peers.filter((p) => p.status === 'online');
  const result: { nodeId: string; name: string; definitions?: unknown[] }[] = [];

  for (const node of online) {
    const entry: { nodeId: string; name: string; definitions?: unknown[] } = {
      nodeId: node.identity.nodeId,
      name: node.identity.name,
    };
    if (sendRpc) {
      try {
        const response = (await sendRpc(
          node.identity.nodeId,
          'memeloop.agent.getDefinitions',
          {},
        )) as { definitions?: unknown[] };
        entry.definitions = Array.isArray(response?.definitions) ? response.definitions : [];
      } catch {
        entry.definitions = [];
      }
    }
    result.push(entry);
  }

  return { nodes: result };
};

export const remoteAgentImpl: BuiltinToolImpl = async (arguments_, context) => {
  const nodeId = arguments_.nodeId as string | undefined;
  const definitionId = arguments_.definitionId as string | undefined;
  const message = arguments_.message as string | undefined;

  if (!nodeId || !definitionId || typeof message !== 'string') {
    return remoteAgentListImpl(arguments_, context);
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
          type: 'sub-agent',
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
