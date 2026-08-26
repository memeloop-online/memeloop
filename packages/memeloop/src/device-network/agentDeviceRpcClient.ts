import type { ChatMessage } from '../conversation/types.js';
import {
  AGENT_DEVICE_RPC_LIMITS,
  AGENT_DEVICE_RPC_METHODS,
  type AgentDeviceRpcCancelRequest,
  type AgentDeviceRpcContract,
  type AgentDeviceRpcCreateRequest,
  type AgentDeviceRpcDeleteTurnRequest,
  type AgentDeviceRpcGetAttachmentChunkRequest,
  type AgentDeviceRpcGetConversationMetaRequest,
  type AgentDeviceRpcGetConversationTimelinePageRequest,
  type AgentDeviceRpcGetDefinitionsRequest,
  type AgentDeviceRpcGetMessageDetailRequest,
  type AgentDeviceRpcGetMessagePageRequest,
  type AgentDeviceRpcGetRunStatusRequest,
  type AgentDeviceRpcGetTurnDetailRequest,
  type AgentDeviceRpcListConversationsRequest,
  type AgentDeviceRpcListTurnsRequest,
  type AgentDeviceRpcLoadAroundRequest,
  type AgentDeviceRpcMethod,
  AgentDeviceRpcProtocolError,
  type AgentDeviceRpcPullAgentRunLogRequest,
  type AgentDeviceRpcRequest,
  type AgentDeviceRpcResponse,
  type AgentDeviceRpcRetryTurnRequest,
  type AgentDeviceRpcRunTurnRequest,
  type AgentDeviceRpcSendRequest,
  assertAgentDeviceRpcRequest,
  assertAgentDeviceRpcResponseCorrelation,
  parseAgentDeviceRpcMessageDetail,
  parseAgentDeviceRpcResponse,
} from './agentDeviceRpc.js';
import { ATTACHMENT_UPLOAD_LIMITS, type AttachmentUploadRpcCall, createAttachmentUploadRpcClient } from './attachmentUpload.js';
import { createScheduledTaskRpcClient, type ScheduledTaskRpcCall } from './scheduledTaskRpc.js';
import type { DeviceConnectionGrant } from './types.js';

export type AgentDeviceRpcSend = (
  peerId: string,
  method: string,
  parameters: unknown,
  options?: AgentDeviceRpcTransportOptions,
) => Promise<unknown>;

export interface AgentDeviceRpcTransportOptions {
  presentedGrant?: DeviceConnectionGrant;
  signal?: AbortSignal;
}

export interface AgentDeviceRpcCallOptions {
  signal?: AbortSignal;
}

export interface AgentDeviceRpcClientOptions {
  peerId: string;
  sendRpc: AgentDeviceRpcSend;
  presentedGrant?: DeviceConnectionGrant;
  /** Override only when the host's runtime needs a UUID polyfill. */
  createRequestId?: () => string;
}

export type AgentDeviceRpcStartTurnRequest =
  | {
    kind: 'send';
    request: Omit<AgentDeviceRpcSendRequest, 'requestId' | 'turnId'> & { requestId?: string; turnId?: string };
  }
  | {
    kind: 'runTurn';
    request: Omit<AgentDeviceRpcRunTurnRequest, 'requestId' | 'turnId'> & { requestId?: string; turnId?: string };
  };

export type PreparedAgentDeviceRpcStartTurnRequest =
  | { kind: 'send'; request: AgentDeviceRpcSendRequest }
  | { kind: 'runTurn'; request: AgentDeviceRpcRunTurnRequest };

export interface AgentDeviceRpcReadAttachmentOptions extends AgentDeviceRpcCallOptions {
  /** A host policy bound; prevents a malicious peer from declaring unbounded data. */
  maxBytes: number;
  /** Whole multi-chunk operation deadline; defaults to 120 seconds. */
  deadlineMs?: number;
}

export interface AgentDeviceRpcReadMessageDetailOptions extends AgentDeviceRpcCallOptions {
  /** Defaults to the portable 64 MiB safety ceiling and may only lower it. */
  maxBytes?: number;
  /** Whole multi-chunk operation deadline; defaults to 120 seconds. */
  deadlineMs?: number;
}

/**
 * Browser/mobile-safe typed facade. Host code supplies `sendRpc` once and no
 * longer embeds wire method strings or casts untrusted peer responses.
 */
export function createAgentDeviceRpcClient(options: AgentDeviceRpcClientOptions) {
  async function request<M extends AgentDeviceRpcMethod>(
    method: M,
    parameters: AgentDeviceRpcRequest<M>,
    callOptions: AgentDeviceRpcCallOptions = {},
  ): Promise<AgentDeviceRpcResponse<M>> {
    callOptions.signal?.throwIfAborted();
    assertAgentDeviceRpcRequest(method, parameters);
    const response = await options.sendRpc(
      options.peerId,
      method,
      parameters,
      { presentedGrant: options.presentedGrant, signal: callOptions.signal },
    );
    callOptions.signal?.throwIfAborted();
    const parsed = parseAgentDeviceRpcResponse(method, response);
    assertAgentDeviceRpcResponseCorrelation(method, parameters, parsed);
    return parsed;
  }

  async function getDefinitions(
    parameters: AgentDeviceRpcGetDefinitionsRequest = {},
    callOptions: AgentDeviceRpcCallOptions = {},
  ) {
    return request(AGENT_DEVICE_RPC_METHODS.getDefinitions, parameters, callOptions);
  }

  async function createAgent(parameters: AgentDeviceRpcCreateRequest, callOptions: AgentDeviceRpcCallOptions = {}) {
    return request(AGENT_DEVICE_RPC_METHODS.create, parameters, callOptions);
  }

  async function send(parameters: AgentDeviceRpcSendRequest, callOptions: AgentDeviceRpcCallOptions = {}) {
    return request(AGENT_DEVICE_RPC_METHODS.send, parameters, callOptions);
  }

  async function runTurn(parameters: AgentDeviceRpcRunTurnRequest, callOptions: AgentDeviceRpcCallOptions = {}) {
    return request(AGENT_DEVICE_RPC_METHODS.runTurn, parameters, callOptions);
  }

  function prepareStartTurn(parameters: AgentDeviceRpcStartTurnRequest): PreparedAgentDeviceRpcStartTurnRequest {
    const requestId = parameters.request.requestId ??
      (options.createRequestId ?? createAgentDeviceRpcRequestId)();
    const turnId = parameters.request.turnId ??
      (options.createRequestId ?? createAgentDeviceRpcRequestId)();
    return parameters.kind === 'send'
      ? { kind: 'send', request: { ...parameters.request, requestId, turnId } }
      : { kind: 'runTurn', request: { ...parameters.request, requestId, turnId } };
  }

  async function startTurn(
    parameters: PreparedAgentDeviceRpcStartTurnRequest,
    callOptions: AgentDeviceRpcCallOptions = {},
  ) {
    return parameters.kind === 'send'
      ? send(parameters.request, callOptions)
      : runTurn(parameters.request, callOptions);
  }

  async function getRunStatus(parameters: AgentDeviceRpcGetRunStatusRequest, callOptions: AgentDeviceRpcCallOptions = {}) {
    return request(AGENT_DEVICE_RPC_METHODS.getRunStatus, parameters, callOptions);
  }

  async function cancel(parameters: AgentDeviceRpcCancelRequest, callOptions: AgentDeviceRpcCallOptions = {}) {
    return request(AGENT_DEVICE_RPC_METHODS.cancel, parameters, callOptions);
  }

  async function deleteTurn(
    parameters: AgentDeviceRpcDeleteTurnRequest,
    callOptions: AgentDeviceRpcCallOptions = {},
  ) {
    return request(AGENT_DEVICE_RPC_METHODS.deleteTurn, parameters, callOptions);
  }

  async function retryTurn(
    parameters: AgentDeviceRpcRetryTurnRequest,
    callOptions: AgentDeviceRpcCallOptions = {},
  ) {
    return request(AGENT_DEVICE_RPC_METHODS.retryTurn, parameters, callOptions);
  }

  async function listConversations(
    parameters: AgentDeviceRpcListConversationsRequest = {},
    callOptions: AgentDeviceRpcCallOptions = {},
  ) {
    return request(AGENT_DEVICE_RPC_METHODS.listConversations, parameters, callOptions);
  }

  async function getConversationMeta(
    parameters: AgentDeviceRpcGetConversationMetaRequest,
    callOptions: AgentDeviceRpcCallOptions = {},
  ) {
    return request(AGENT_DEVICE_RPC_METHODS.getConversationMeta, parameters, callOptions);
  }

  async function listTurns(parameters: AgentDeviceRpcListTurnsRequest, callOptions: AgentDeviceRpcCallOptions = {}) {
    return request(AGENT_DEVICE_RPC_METHODS.listTurns, {
      ...parameters,
      byteBudget: parameters.byteBudget ?? AGENT_DEVICE_RPC_LIMITS.projectionPageDefaultBytes,
    }, callOptions);
  }

  async function getTurnDetail(
    parameters: AgentDeviceRpcGetTurnDetailRequest,
    callOptions: AgentDeviceRpcCallOptions = {},
  ) {
    return request(AGENT_DEVICE_RPC_METHODS.getTurnDetail, {
      ...parameters,
      limit: parameters.limit ?? AGENT_DEVICE_RPC_LIMITS.turnDetailPage,
      maxBytes: parameters.maxBytes ?? AGENT_DEVICE_RPC_LIMITS.turnDetailDefaultBytes,
    }, callOptions);
  }

  async function getMessagePage(parameters: AgentDeviceRpcGetMessagePageRequest, callOptions: AgentDeviceRpcCallOptions = {}) {
    return request(AGENT_DEVICE_RPC_METHODS.getMessagePage, {
      ...parameters,
      mode: parameters.mode ?? 'on-demand',
      maxBytes: parameters.maxBytes ?? AGENT_DEVICE_RPC_LIMITS.projectionPageDefaultBytes,
    }, callOptions);
  }

  async function getConversationTimelinePage(
    parameters: AgentDeviceRpcGetConversationTimelinePageRequest,
    callOptions: AgentDeviceRpcCallOptions = {},
  ) {
    return request(AGENT_DEVICE_RPC_METHODS.getConversationTimelinePage, {
      ...parameters,
      limit: parameters.limit ?? AGENT_DEVICE_RPC_LIMITS.timelinePage,
      maxBytes: parameters.maxBytes ?? AGENT_DEVICE_RPC_LIMITS.timelinePageDefaultBytes,
    }, callOptions);
  }

  async function loadAround(
    parameters: AgentDeviceRpcLoadAroundRequest,
    callOptions: AgentDeviceRpcCallOptions = {},
  ) {
    return request(AGENT_DEVICE_RPC_METHODS.loadAround, {
      ...parameters,
      maxMessages: parameters.maxMessages ?? AGENT_DEVICE_RPC_LIMITS.loadAroundMessages,
      maxBytes: parameters.maxBytes ?? AGENT_DEVICE_RPC_LIMITS.loadAroundDefaultBytes,
    }, callOptions);
  }

  async function getMessageDetail(
    parameters: AgentDeviceRpcGetMessageDetailRequest,
    callOptions: AgentDeviceRpcCallOptions = {},
  ) {
    return request(AGENT_DEVICE_RPC_METHODS.getMessageDetail, parameters, callOptions);
  }

  async function readMessageDetail(
    parameters: Omit<AgentDeviceRpcGetMessageDetailRequest, 'offset'>,
    readOptions: AgentDeviceRpcReadMessageDetailOptions = {},
  ): Promise<ChatMessage | null> {
    const maxBytes = normalizeMaximumBytes(
      readOptions.maxBytes,
      AGENT_DEVICE_RPC_LIMITS.messageDetailBytes,
    );
    const bytes = await readChunks(
      async (offset, signal) => {
        const chunk = await getMessageDetail({ ...parameters, offset }, { signal });
        return chunk.found ? chunk : null;
      },
      maxBytes,
      readOptions,
    );
    if (bytes === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new AgentDeviceRpcProtocolError('response.data');
    }
    return parseAgentDeviceRpcMessageDetail(value);
  }

  async function getAttachmentChunk(
    parameters: AgentDeviceRpcGetAttachmentChunkRequest,
    callOptions: AgentDeviceRpcCallOptions = {},
  ) {
    return request(AGENT_DEVICE_RPC_METHODS.getAttachmentChunk, parameters, callOptions);
  }

  async function readAttachment(
    parameters: Omit<AgentDeviceRpcGetAttachmentChunkRequest, 'offset'>,
    readOptions: AgentDeviceRpcReadAttachmentOptions,
  ): Promise<Uint8Array | null> {
    const maxBytes = normalizeMaximumBytes(readOptions.maxBytes, ATTACHMENT_UPLOAD_LIMITS.totalBytes);
    return readChunks(
      async (offset, signal) => {
        const chunk = await getAttachmentChunk({ ...parameters, offset }, { signal });
        if (!chunk.found) return null;
        if (chunk.totalBytes > maxBytes) {
          throw new AgentDeviceRpcProtocolError('response.totalBytes');
        }
        return chunk;
      },
      maxBytes,
      readOptions,
    );
  }

  async function pullAgentRunLog(
    parameters: AgentDeviceRpcPullAgentRunLogRequest,
    callOptions: AgentDeviceRpcCallOptions = {},
  ) {
    return request(AGENT_DEVICE_RPC_METHODS.pullAgentRunLog, {
      ...parameters,
      maxBytes: parameters.maxBytes ?? AGENT_DEVICE_RPC_LIMITS.projectionPageDefaultBytes,
    }, callOptions);
  }

  const attachmentUpload = createAttachmentUploadRpcClient({
    call: ((method, parameters, callOptions) => request(method, parameters, callOptions)) as AttachmentUploadRpcCall,
  });
  const scheduledTasks = createScheduledTaskRpcClient({
    call: ((method, parameters, callOptions) => request(method, parameters, callOptions)) as ScheduledTaskRpcCall,
  });

  return {
    request,
    getDefinitions,
    createAgent,
    send,
    runTurn,
    prepareStartTurn,
    startTurn,
    getRunStatus,
    cancel,
    deleteTurn,
    retryTurn,
    listConversations,
    getConversationMeta,
    listTurns,
    getTurnDetail,
    getMessagePage,
    getConversationTimelinePage,
    loadAround,
    getMessageDetail,
    readMessageDetail,
    getAttachmentChunk,
    readAttachment,
    pullAgentRunLog,
    beginAttachmentUpload: attachmentUpload.begin,
    uploadAttachmentChunk: attachmentUpload.chunk,
    commitAttachmentUpload: attachmentUpload.commit,
    scheduledTasks,
    listScheduledTasks: scheduledTasks.list,
    getScheduledTask: scheduledTasks.get,
    createScheduledTask: scheduledTasks.create,
    updateScheduledTask: scheduledTasks.update,
    deleteScheduledTask: scheduledTasks.delete,
    previewScheduledTaskCron: scheduledTasks.cronPreview,
  };
}

export type AgentDeviceRpcClient = ReturnType<typeof createAgentDeviceRpcClient>;

/** Create a UUID request id without importing Node crypto into browser/mobile. */
export function createAgentDeviceRpcRequestId(): string {
  const bytes = new Uint8Array(16);
  const getRandomValues = globalThis.crypto?.getRandomValues.bind(globalThis.crypto);
  if (!getRandomValues) throw new AgentDeviceRpcProtocolError('requestIdGenerator');
  getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0F) | 0x40;
  bytes[8] = (bytes[8] & 0x3F) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface ReadableChunk {
  data: string;
  offset: number;
  totalBytes: number;
  nextOffset?: number;
}

async function readChunks(
  read: (offset: number, signal: AbortSignal) => Promise<ReadableChunk | null>,
  maxBytes: number,
  options: { signal?: AbortSignal; deadlineMs?: number },
): Promise<Uint8Array | null> {
  const operation = createDeadlineSignal(options.signal, options.deadlineMs);
  let offset = 0;
  let expectedTotal: number | undefined;
  let result: Uint8Array | undefined;
  let chunkCount = 0;
  try {
    for (;;) {
      operation.signal.throwIfAborted();
      chunkCount += 1;
      if (chunkCount > MAX_DETAIL_CHUNKS) throw new AgentDeviceRpcProtocolError('response.chunkCount');
      const chunk = await read(offset, operation.signal);
      operation.signal.throwIfAborted();
      if (chunk === null) {
        if (offset !== 0) throw new AgentDeviceRpcProtocolError('response.found');
        return null;
      }
      if (chunk.totalBytes > maxBytes) throw new AgentDeviceRpcProtocolError('response.totalBytes');
      if (chunk.offset !== offset) throw new AgentDeviceRpcProtocolError('response.offset');
      if (expectedTotal !== undefined && chunk.totalBytes !== expectedTotal) {
        throw new AgentDeviceRpcProtocolError('response.totalBytes');
      }
      expectedTotal = chunk.totalBytes;
      result ??= new Uint8Array(expectedTotal);
      const bytes = base64ToBytes(chunk.data);
      if (offset + bytes.byteLength > expectedTotal) throw new AgentDeviceRpcProtocolError('response.data');
      result.set(bytes, offset);
      const nextOffset = offset + bytes.byteLength;
      if (chunk.nextOffset === undefined) {
        if (nextOffset !== expectedTotal) throw new AgentDeviceRpcProtocolError('response.nextOffset');
        return result;
      }
      if (bytes.byteLength === 0 || chunk.nextOffset !== nextOffset) {
        throw new AgentDeviceRpcProtocolError('response.nextOffset');
      }
      offset = chunk.nextOffset;
    }
  } finally {
    operation.dispose();
  }
}

const DEFAULT_DETAIL_DEADLINE_MS = 120_000;
const MAX_DETAIL_DEADLINE_MS = 600_000;
const MAX_DETAIL_CHUNKS = 256;

function createDeadlineSignal(parent: AbortSignal | undefined, requested: number | undefined): {
  signal: AbortSignal;
  dispose(): void;
} {
  const deadlineMs = requested ?? DEFAULT_DETAIL_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_DETAIL_DEADLINE_MS) {
    throw new AgentDeviceRpcProtocolError('options.deadlineMs');
  }
  const controller = new AbortController();
  const abortFromParent = () => {
    controller.abort(parent?.reason);
  };
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new Error('agent_device_rpc_detail_deadline'));
  }, deadlineMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

function normalizeMaximumBytes(value: number | undefined, ceiling: number): number {
  const result = value ?? ceiling;
  if (!Number.isSafeInteger(result) || result < 0 || result > ceiling) {
    throw new AgentDeviceRpcProtocolError('options.maxBytes');
  }
  return result;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) result[index] = binary.charCodeAt(index);
  return result;
}

// Ensure mapped DTOs remain visible in generated declarations without forcing
// hosts to import the contract map directly.
export type { AgentDeviceRpcContract };
