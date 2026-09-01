import { type AgentDeviceRpcPullAgentRunLogRequest, type AgentDeviceRpcRunLogMessage } from '../../device-network/agentDeviceRpc.js';
import { type AgentDeviceRpcClient, createAgentDeviceRpcClient } from '../../device-network/agentDeviceRpcClient.js';
import { canonicalJsonBytes } from '../../encoding/canonicalJson.js';
import { createAgentClient } from '../../orchestration/index.js';
import type { AgentOrchestrationClient } from '../../orchestration/index.js';
import { safeErrorFromUnknown, safeErrorMessageFromUnknown } from '../../safeError.js';
import { MEMELOOP_STRUCTURED_TOOL_KEY, truncateToolSummary } from '../structuredToolResult.js';
import { type BuiltinToolContext, type BuiltinToolImpl, requireBuiltinLocalNodeId } from './types.js';

const TOOL_ID = 'remoteAgent';
const REMOTE_LOG_POLL_INTERVAL_MS = 500;
const REMOTE_LOG_PAGE_SIZE = 50;
const MAX_REMOTE_LOG_RESIDENT_MESSAGES = 50;
const MAX_REMOTE_LOG_RESIDENT_BYTES = 256 * 1024;
const MAX_REMOTE_SUMMARY_BYTES = 64 * 1024;
const MAX_REMOTE_STREAM_CHUNK_CODE_UNITS = 256 * 1024;

type RemoteConversationMessage = AgentDeviceRpcRunLogMessage;

function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  return '';
}

function getRemoteStreamChunkContent(chunk: unknown): unknown {
  if ((typeof chunk !== 'object' || chunk === null) && typeof chunk !== 'function') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(chunk, 'content');
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
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
  const summary = joined.trim();
  if (!summary) return '(task dispatched; remote messages had no readable content)';
  const encoded = new TextEncoder().encode(summary);
  if (encoded.byteLength <= MAX_REMOTE_SUMMARY_BYTES) return summary;
  const marker = '[older remote output omitted; open the agent-run detail]';
  const markerBytes = new TextEncoder().encode(`${marker}\n`).byteLength;
  return `${marker}\n${utf8Suffix(summary, MAX_REMOTE_SUMMARY_BYTES - markerBytes)}`;
}

async function collectRemoteConversationSummary(
  client: AgentDeviceRpcClient,
  conversationId: string,
  runId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const startedAt = Date.now();
  const collectedMessages: RemoteConversationMessage[] = [];
  let collectedBytes = 0;
  let cursor: string | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    signal?.throwIfAborted();
    const request: AgentDeviceRpcPullAgentRunLogRequest = {
      conversationId,
      runId,
      limit: REMOTE_LOG_PAGE_SIZE,
      maxBytes: MAX_REMOTE_LOG_RESIDENT_BYTES,
      ...(cursor ? { cursor } : {}),
    };
    const response = await client.pullAgentRunLog(request, { signal });
    const newMessages = response.messages;
    if (response.hasMoreAfter && newMessages.length === 0) {
      throw new Error('remote_agent_log_page_made_no_progress');
    }

    if (newMessages.length > 0) {
      if (response.hasMoreAfter && (!response.nextCursor || response.nextCursor === cursor)) {
        throw new Error('remote_agent_log_cursor_did_not_advance');
      }
      for (const message of newMessages) {
        const messageBytes = canonicalJsonBytes(message, {
          maxBytes: MAX_REMOTE_LOG_RESIDENT_BYTES,
          maxStringBytes: MAX_REMOTE_LOG_RESIDENT_BYTES,
          maxStringCodeUnits: MAX_REMOTE_LOG_RESIDENT_BYTES,
        }).byteLength;
        if (messageBytes > MAX_REMOTE_LOG_RESIDENT_BYTES) {
          throw new Error('remote_agent_log_message_exceeds_resident_budget');
        }
        collectedMessages.push(message);
        collectedBytes += messageBytes;
        while (
          collectedMessages.length > MAX_REMOTE_LOG_RESIDENT_MESSAGES ||
          collectedBytes > MAX_REMOTE_LOG_RESIDENT_BYTES
        ) {
          const removed = collectedMessages.shift();
          if (removed) {
            collectedBytes -= canonicalJsonBytes(removed, {
              maxBytes: MAX_REMOTE_LOG_RESIDENT_BYTES,
              maxStringBytes: MAX_REMOTE_LOG_RESIDENT_BYTES,
              maxStringCodeUnits: MAX_REMOTE_LOG_RESIDENT_BYTES,
            }).byteLength;
          }
        }
      }
      if (response.nextCursor) cursor = response.nextCursor;
    }

    if (response.hasMoreAfter) continue;
    const status = response.runStatus;
    if (status === null || status === undefined) throw new Error('remote_agent_run_not_found');
    if (status.runId !== runId || status.conversationId !== conversationId) {
      throw new Error('remote_agent_run_identity_mismatch');
    }
    if (status.state === 'completed') return summarizeRemoteMessages(collectedMessages);
    if (status.state === 'failed') {
      throw new Error(status.error ? `remote_agent_run_failed:${status.error.code}` : 'remote_agent_run_failed');
    }
    if (status.state === 'cancelled') throw new Error('remote_agent_run_cancelled');
    await abortableDelay(REMOTE_LOG_POLL_INTERVAL_MS, signal);
  }

  throw new Error('remote_agent_run_timeout');
}

function utf8Suffix(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return '';
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maximumBytes) return value;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const minimumStart = Math.max(0, encoded.byteLength - maximumBytes);
  for (let start = minimumStart; start < Math.min(encoded.byteLength, minimumStart + 4); start += 1) {
    try {
      return decoder.decode(encoded.subarray(start));
    } catch {
      // A UTF-8 sequence is at most four bytes, so only the leading suffix can fail.
    }
  }
  throw new Error('remote_agent_utf8_projection_failed');
}

function strictUtf8Prefix(value: string, maximumBytes: number): { text: string; bytes: number } | undefined {
  if (value.length > MAX_REMOTE_STREAM_CHUNK_CODE_UNITS || maximumBytes <= 0) return undefined;
  let bytes = 0;
  let prefixEnd = 0;
  let prefixBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    let codePointBytes: number;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return undefined;
      codePointBytes = 4;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return undefined;
    } else if (codeUnit <= 0x7f) {
      codePointBytes = 1;
    } else if (codeUnit <= 0x7ff) {
      codePointBytes = 2;
    } else {
      codePointBytes = 3;
    }
    bytes += codePointBytes;
    if (bytes <= maximumBytes) {
      prefixEnd = index + 1;
      prefixBytes = bytes;
    }
  }
  const text = value.slice(0, prefixEnd);
  return { text, bytes: prefixBytes };
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(safeErrorFromUnknown(signal?.reason, { fallback: 'operation_aborted' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
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
  const resolvedNodeId = requireBuiltinLocalNodeId(localNodeId);
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
  context.operationSignal?.throwIfAborted();
  if (context.orchestration) {
    try {
      const caps = await context.orchestration.getCapabilities();
      context.operationSignal?.throwIfAborted();
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
      if (context.operationSignal?.aborted) context.operationSignal.throwIfAborted();
      const message = safeErrorMessageFromUnknown(error, { fallback: 'Remote agent request failed' });
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
  context.operationSignal?.throwIfAborted();
  const nodeId = arguments_.nodeId as string | undefined;
  const definitionId = arguments_.definitionId as string | undefined;
  const message = arguments_.message as string | undefined;

  if (!nodeId || !definitionId || typeof message !== 'string') {
    return remoteAgentListImpl(arguments_, context);
  }

  try {
    if (context.orchestration && (await supportsAgentWorkload(context.orchestration))) {
      context.operationSignal?.throwIfAborted();
      return await runRemoteAgentViaOrchestration(
        context.orchestration,
        nodeId,
        definitionId,
        message,
        context.localNodeId,
        context.operationSignal,
      );
    }
  } catch (error) {
    if (context.operationSignal?.aborted) context.operationSignal.throwIfAborted();
    const errorMessage = safeErrorMessageFromUnknown(error, { fallback: 'Remote agent failed' });
    return { error: `remoteAgent failed: ${errorMessage}` };
  }

  if (!context.sendRpcToNode) {
    return {
      error: 'Remote node RPC not configured (no sendRpcToNode). Connect to peer nodes first.',
    };
  }
  const sendRpcToNode = context.sendRpcToNode.bind(context);
  const client = createAgentDeviceRpcClient({
    peerId: nodeId,
    sendRpc: (peerId, method, parameters, options) =>
      options?.signal
        ? sendRpcToNode(peerId, method, parameters, { signal: options.signal })
        : sendRpcToNode(peerId, method, parameters),
  });

  try {
    const createResult = await client.createAgent({
      definitionId,
    }, { signal: context.operationSignal });
    const { conversationId } = createResult;

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
    let chunkBytes = 0;
    const unsubscribe = subscribeStream?.(nodeId, conversationId, (chunk) => {
      let text: string | undefined;
      if (typeof chunk === 'string') text = chunk;
      else {
        const chunkContent = getRemoteStreamChunkContent(chunk);
        if (chunkContent !== undefined) {
          text = messageContentToText(chunkContent);
        }
      }
      if (!text || chunkBytes >= MAX_REMOTE_SUMMARY_BYTES) return;
      const bounded = strictUtf8Prefix(text, MAX_REMOTE_SUMMARY_BYTES - chunkBytes);
      if (!bounded?.text) return;
      chunks.push(bounded.text);
      chunkBytes += bounded.bytes;
    });
    let runId: string | undefined;
    try {
      const prepared = client.prepareStartTurn({
        kind: 'send',
        request: { conversationId, message },
      });
      const accepted = await client.startTurn(prepared, { signal: context.operationSignal });
      runId = accepted.runId;
      const persistedSummary = await collectRemoteConversationSummary(
        client,
        conversationId,
        runId,
        streamWaitMs,
        context.operationSignal,
      );
      const streamedSummary = chunks.join('').trim();
      const fullSummary = persistedSummary === '(task dispatched; waiting for remote output)' && streamedSummary
        ? streamedSummary
        : persistedSummary;
      const shortSummary = truncateToolSummary(fullSummary);
      return {
        summary: fullSummary,
        remoteNodeId: nodeId,
        remoteConversationId: conversationId,
        remoteRunId: runId,
        definitionId,
        [MEMELOOP_STRUCTURED_TOOL_KEY]: {
          summary: shortSummary,
          detailRef: {
            type: 'agent-run',
            runId,
            conversationId,
            nodeId,
          },
        },
      };
    } catch (error) {
      const message = safeErrorMessageFromUnknown(error, { fallback: 'Remote agent failed' });
      if (runId && (context.operationSignal?.aborted || message === 'remote_agent_run_timeout')) {
        await client.cancel({ runId }).catch(() => undefined);
      }
      throw error;
    } finally {
      unsubscribe?.();
    }
  } catch (error) {
    if (context.operationSignal?.aborted) context.operationSignal.throwIfAborted();
    const message = safeErrorMessageFromUnknown(error, { fallback: 'Remote agent failed' });
    return { error: `remoteAgent failed: ${message}` };
  }
};

export function getRemoteAgentToolId(): string {
  return TOOL_ID;
}
