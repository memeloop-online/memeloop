import type { ChatMessage } from '../conversation/types.js';
import {
  AGENT_DEVICE_RPC_LIMITS,
  AGENT_DEVICE_RPC_METHODS,
  type AgentDeviceRpcContract,
  type AgentDeviceRpcGetAttachmentChunkRequest,
  type AgentDeviceRpcGetMessageDetailRequest,
  type AgentDeviceRpcMethod,
  AgentDeviceRpcProtocolError,
  type AgentDeviceRpcRequest,
  type AgentDeviceRpcResponse,
  type AgentDeviceRpcRunTurnRequest,
  type AgentDeviceRpcSendRequest,
  assertAgentDeviceRpcRequest,
  assertAgentDeviceRpcRequestEnvelope,
  assertAgentDeviceRpcResponseCorrelation,
  parseAgentDeviceRpcMessageDetail,
  parseAgentDeviceRpcResponse,
} from './agentDeviceRpc.js';
import { ATTACHMENT_UPLOAD_LIMITS, bindAttachmentUploadRpcClient, decodeAttachmentUploadChunk, type UploadAttachmentChunkRequest } from './attachmentUpload.js';
import { bindScheduledTaskRpcClient } from './scheduledTaskRpc.js';
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
    if (method === AGENT_DEVICE_RPC_METHODS.uploadAttachmentChunk) {
      assertAgentDeviceRpcRequestEnvelope(parameters);
      await decodeAttachmentUploadChunk(parameters as UploadAttachmentChunkRequest);
    } else {
      assertAgentDeviceRpcRequest(method, parameters);
    }
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

  function bind<M extends AgentDeviceRpcMethod>(method: M) {
    return (
      parameters: AgentDeviceRpcRequest<M>,
      callOptions: AgentDeviceRpcCallOptions = {},
    ): Promise<AgentDeviceRpcResponse<M>> => request(method, parameters, callOptions);
  }

  function bindOptional<M extends AgentDeviceRpcMethod>(
    method: M,
    createEmptyRequest: () => AgentDeviceRpcRequest<M>,
  ) {
    return (
      parameters: AgentDeviceRpcRequest<M> = createEmptyRequest(),
      callOptions: AgentDeviceRpcCallOptions = {},
    ): Promise<AgentDeviceRpcResponse<M>> => request(method, parameters, callOptions);
  }

  function bindNormalized<M extends AgentDeviceRpcMethod>(
    method: M,
    normalize: (parameters: AgentDeviceRpcRequest<M>) => AgentDeviceRpcRequest<M>,
  ) {
    return (
      parameters: AgentDeviceRpcRequest<M>,
      callOptions: AgentDeviceRpcCallOptions = {},
    ): Promise<AgentDeviceRpcResponse<M>> => request(method, normalize(parameters), callOptions);
  }

  const getDefinitions = bindOptional(AGENT_DEVICE_RPC_METHODS.getDefinitions, () => ({}));
  const createAgent = bind(AGENT_DEVICE_RPC_METHODS.create);
  const send = bind(AGENT_DEVICE_RPC_METHODS.send);
  const runTurn = bind(AGENT_DEVICE_RPC_METHODS.runTurn);
  const getRunStatus = bind(AGENT_DEVICE_RPC_METHODS.getRunStatus);
  const cancel = bind(AGENT_DEVICE_RPC_METHODS.cancel);
  const deleteTurn = bind(AGENT_DEVICE_RPC_METHODS.deleteTurn);
  const retryTurn = bind(AGENT_DEVICE_RPC_METHODS.retryTurn);
  const listConversations = bindOptional(AGENT_DEVICE_RPC_METHODS.listConversations, () => ({}));
  const getConversationMeta = bind(AGENT_DEVICE_RPC_METHODS.getConversationMeta);
  const listTurns = bindNormalized(AGENT_DEVICE_RPC_METHODS.listTurns, parameters => ({
    ...parameters,
    byteBudget: parameters.byteBudget ?? AGENT_DEVICE_RPC_LIMITS.projectionPageDefaultBytes,
  }));
  const getTurnDetail = bindNormalized(AGENT_DEVICE_RPC_METHODS.getTurnDetail, parameters => ({
    ...parameters,
    limit: parameters.limit ?? AGENT_DEVICE_RPC_LIMITS.turnDetailPage,
    maxBytes: parameters.maxBytes ?? AGENT_DEVICE_RPC_LIMITS.turnDetailDefaultBytes,
  }));
  const getMessagePage = bindNormalized(AGENT_DEVICE_RPC_METHODS.getMessagePage, parameters => ({
    ...parameters,
    maxBytes: parameters.maxBytes ?? AGENT_DEVICE_RPC_LIMITS.projectionPageDefaultBytes,
  }));
  const getConversationTimelinePage = bindNormalized(
    AGENT_DEVICE_RPC_METHODS.getConversationTimelinePage,
    parameters => ({
      ...parameters,
      limit: parameters.limit ?? AGENT_DEVICE_RPC_LIMITS.timelinePage,
      maxBytes: parameters.maxBytes ?? AGENT_DEVICE_RPC_LIMITS.timelinePageDefaultBytes,
    }),
  );
  const loadAround = bindNormalized(AGENT_DEVICE_RPC_METHODS.loadAround, parameters => ({
    ...parameters,
    maxMessages: parameters.maxMessages ?? AGENT_DEVICE_RPC_LIMITS.loadAroundMessages,
    maxBytes: parameters.maxBytes ?? AGENT_DEVICE_RPC_LIMITS.loadAroundDefaultBytes,
  }));
  const getMessageDetail = bind(AGENT_DEVICE_RPC_METHODS.getMessageDetail);
  const getAttachmentChunk = bind(AGENT_DEVICE_RPC_METHODS.getAttachmentChunk);
  const pullAgentRunLog = bindNormalized(AGENT_DEVICE_RPC_METHODS.pullAgentRunLog, parameters => ({
    ...parameters,
    limit: parameters.limit ?? AGENT_DEVICE_RPC_LIMITS.runLogPage,
    maxBytes: parameters.maxBytes ?? AGENT_DEVICE_RPC_LIMITS.runLogPageBytes,
  }));

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

  const attachmentUpload = bindAttachmentUploadRpcClient(request);
  const scheduledTasks = bindScheduledTaskRpcClient(request);

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
