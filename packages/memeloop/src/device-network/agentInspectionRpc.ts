import {
  assertPromptPreviewAuditDetailChunk,
  assertPromptPreviewAuditDetailRequest,
  assertPromptPreviewAuditPage,
  assertPromptPreviewAuditPageRequest,
  assertPromptPreviewAuditReleaseRequest,
  assertPromptPreviewPreparedExecution,
} from '../agent-management/PromptPreviewAudit.js';
import type {
  PromptPreviewAuditDetailChunk,
  PromptPreviewAuditDetailRequest,
  PromptPreviewAuditPage,
  PromptPreviewAuditPageRequest,
  PromptPreviewAuditReleaseRequest,
  PromptPreviewPreparedExecution,
  PromptPreviewPrepareRequest,
} from '../agent-management/types.js';
import { type AgentModelConfig, assertAgentModelConfig } from '../agent/types.js';
import { decodeBase64, encodeBase64 } from '../encoding/base64.js';
import type { ModelCatalogModel } from '../modelCatalog/types.js';

export const AGENT_INSPECTION_RPC_METHODS = {
  preparePromptPreviewExecutionModelRequest: 'memeloop.chat.preparePromptPreviewExecutionModelRequest',
  getPromptPreviewAuditPage: 'memeloop.chat.getPromptPreviewAuditPage',
  getPromptPreviewAuditDetail: 'memeloop.chat.getPromptPreviewAuditDetail',
  releasePromptPreviewAuditSession: 'memeloop.chat.releasePromptPreviewAuditSession',
  cancelPromptPreview: 'memeloop.chat.cancelPromptPreview',
  getConversationModelParameters: 'memeloop.chat.getConversationModelParameters',
  setConversationModelParameters: 'memeloop.chat.setConversationModelParameters',
} as const;

export type AgentInspectionRpcMethod = typeof AGENT_INSPECTION_RPC_METHODS[keyof typeof AGENT_INSPECTION_RPC_METHODS];
const methods = new Set<string>(Object.values(AGENT_INSPECTION_RPC_METHODS));
export function isAgentInspectionRpcMethod(method: string): method is AgentInspectionRpcMethod {
  return methods.has(method);
}

export interface ConversationModelParameters {
  selection: AgentModelConfig;
  /** Exact public catalog capabilities; never provider credentials. */
  model?: ModelCatalogModel;
}

export interface ConversationModelParametersHost {
  get(conversationId: string): Promise<ConversationModelParameters>;
  set(conversationId: string, selection: AgentModelConfig): Promise<ConversationModelParameters>;
}

export interface AgentPromptInspectionHost {
  prepare(input: PromptPreviewPrepareRequest): Promise<PromptPreviewPreparedExecution>;
  getAuditPage(request: PromptPreviewAuditPageRequest): PromptPreviewAuditPage | Promise<PromptPreviewAuditPage>;
  getAuditDetail(request: PromptPreviewAuditDetailRequest): PromptPreviewAuditDetailChunk | Promise<PromptPreviewAuditDetailChunk>;
  release(request: PromptPreviewAuditReleaseRequest): void | Promise<void>;
  /** The host verifies pending preparation belongs to this conversation before cancelling. */
  cancel(input: { conversationId: string; requestId: string }): void | Promise<void>;
  /** Correlate the opaque session to its original authorized conversation. */
  getSessionConversationId(sessionId: string, expectedRevision: string): string | Promise<string>;
}

export type PromptPreviewRpcDetailChunk = Omit<PromptPreviewAuditDetailChunk, 'canonicalUtf8'> & { canonicalBase64: string };
export interface AgentInspectionRpcContract {
  [AGENT_INSPECTION_RPC_METHODS.preparePromptPreviewExecutionModelRequest]: {
    request: PromptPreviewPrepareRequest;
    response: PromptPreviewPreparedExecution;
  };
  [AGENT_INSPECTION_RPC_METHODS.getPromptPreviewAuditPage]: {
    request: PromptPreviewAuditPageRequest & { conversationId: string };
    response: PromptPreviewAuditPage;
  };
  [AGENT_INSPECTION_RPC_METHODS.getPromptPreviewAuditDetail]: {
    request: PromptPreviewAuditDetailRequest & { conversationId: string };
    response: PromptPreviewRpcDetailChunk;
  };
  [AGENT_INSPECTION_RPC_METHODS.releasePromptPreviewAuditSession]: {
    request: PromptPreviewAuditReleaseRequest & { conversationId: string };
    response: { released: true };
  };
  [AGENT_INSPECTION_RPC_METHODS.cancelPromptPreview]: {
    request: { conversationId: string; requestId: string };
    response: { cancelled: true };
  };
  [AGENT_INSPECTION_RPC_METHODS.getConversationModelParameters]: {
    request: { conversationId: string };
    response: ConversationModelParameters;
  };
  [AGENT_INSPECTION_RPC_METHODS.setConversationModelParameters]: {
    request: { conversationId: string; selection: AgentModelConfig };
    response: ConversationModelParameters;
  };
}

export function assertAgentInspectionRpcRequest(method: AgentInspectionRpcMethod, value: unknown): void {
  const request = record(value);
  identifier(request.conversationId);
  const { conversationId: _conversationId, ...payload } = request;
  switch (method) {
    case AGENT_INSPECTION_RPC_METHODS.preparePromptPreviewExecutionModelRequest:
      keys(request, ['requestId', 'conversationId', 'inputText']);
      identifier(request.requestId);
      if (request.inputText !== undefined && typeof request.inputText !== 'string') invalid();
      break;
    case AGENT_INSPECTION_RPC_METHODS.getPromptPreviewAuditPage:
      assertPromptPreviewAuditPageRequest(payload);
      break;
    case AGENT_INSPECTION_RPC_METHODS.getPromptPreviewAuditDetail:
      assertPromptPreviewAuditDetailRequest(payload);
      break;
    case AGENT_INSPECTION_RPC_METHODS.releasePromptPreviewAuditSession:
      assertPromptPreviewAuditReleaseRequest(payload);
      break;
    case AGENT_INSPECTION_RPC_METHODS.cancelPromptPreview:
      keys(request, ['requestId', 'conversationId']);
      identifier(request.requestId);
      break;
    case AGENT_INSPECTION_RPC_METHODS.getConversationModelParameters:
      keys(request, ['conversationId']);
      break;
    case AGENT_INSPECTION_RPC_METHODS.setConversationModelParameters:
      keys(request, ['conversationId', 'selection']);
      assertAgentModelConfig(request.selection);
      break;
  }
}

export function assertAgentInspectionRpcResponse(method: AgentInspectionRpcMethod, value: unknown): void {
  switch (method) {
    case AGENT_INSPECTION_RPC_METHODS.preparePromptPreviewExecutionModelRequest:
      assertPromptPreviewPreparedExecution(value);
      break;
    case AGENT_INSPECTION_RPC_METHODS.getPromptPreviewAuditPage:
      assertPromptPreviewAuditPage(value);
      break;
    case AGENT_INSPECTION_RPC_METHODS.getPromptPreviewAuditDetail: {
      const response = record(value);
      keys(response, ['sessionId', 'revision', 'target', 'canonicalBase64', 'complete', 'nextCursor']);
      if (typeof response.canonicalBase64 !== 'string') invalid();
      // Request-specific byte and continuation validation follows correlation.
      decodeBase64(response.canonicalBase64);
      break;
    }
    case AGENT_INSPECTION_RPC_METHODS.releasePromptPreviewAuditSession:
      keys(record(value), ['released']);
      if (record(value).released !== true) invalid();
      break;
    case AGENT_INSPECTION_RPC_METHODS.cancelPromptPreview:
      keys(record(value), ['cancelled']);
      if (record(value).cancelled !== true) invalid();
      break;
    case AGENT_INSPECTION_RPC_METHODS.getConversationModelParameters:
    case AGENT_INSPECTION_RPC_METHODS.setConversationModelParameters:
      assertConversationModelParameters(value);
      break;
  }
}

export function assertAgentInspectionRpcCorrelation(method: AgentInspectionRpcMethod, request: unknown, response: unknown): void {
  const input = record(request);
  const output = record(response);
  if (method === AGENT_INSPECTION_RPC_METHODS.getPromptPreviewAuditPage) {
    assertPromptPreviewAuditPage(response, {
      expectedSessionId: input.sessionId as string,
      expectedRevision: input.expectedRevision as string,
      maxBytes: input.maxBytes as number,
      maxEntries: input.limit as number,
    });
  } else if (method === AGENT_INSPECTION_RPC_METHODS.getPromptPreviewAuditDetail) {
    const { conversationId: _conversationId, ...detailRequest } = input;
    assertPromptPreviewAuditDetailRequest(detailRequest);
    assertPromptPreviewAuditDetailChunk(decodePromptPreviewRpcDetail(response as PromptPreviewRpcDetailChunk), detailRequest);
  } else if (method === AGENT_INSPECTION_RPC_METHODS.setConversationModelParameters) {
    const selected = input.selection as AgentModelConfig;
    const saved = output.selection as AgentModelConfig;
    if (selected.providerId !== saved.providerId || selected.modelId !== saved.modelId) invalid();
  }
}

export function encodePromptPreviewRpcDetail(chunk: PromptPreviewAuditDetailChunk): PromptPreviewRpcDetailChunk {
  const { canonicalUtf8, ...metadata } = chunk;
  return { ...metadata, canonicalBase64: encodeBase64(canonicalUtf8) };
}

export function decodePromptPreviewRpcDetail(chunk: PromptPreviewRpcDetailChunk): PromptPreviewAuditDetailChunk {
  const { canonicalBase64, ...metadata } = chunk;
  return { ...metadata, canonicalUtf8: decodeBase64(canonicalBase64) };
}

function assertConversationModelParameters(value: unknown): void {
  const response = record(value);
  keys(response, ['selection', 'model']);
  assertAgentModelConfig(response.selection);
  if (response.model === undefined) return;
  const model = record(response.model);
  keys(model, [
    'id',
    'name',
    'attachment',
    'reasoning',
    'toolCall',
    'reasoningEfforts',
    'structuredOutput',
    'temperature',
    'releaseDate',
    'lastUpdated',
    'status',
    'modalities',
    'limit',
  ]);
  identifier(model.id);
  if (typeof model.name !== 'string') invalid();
  for (const key of ['attachment', 'reasoning', 'toolCall']) if (typeof model[key] !== 'boolean') invalid();
  for (const key of ['temperature', 'structuredOutput']) if (model[key] !== undefined && typeof model[key] !== 'boolean') invalid();
  for (const key of ['releaseDate', 'lastUpdated']) if (model[key] !== undefined && typeof model[key] !== 'string') invalid();
  if (model.status !== undefined && !['alpha', 'beta', 'deprecated'].includes(model.status as string)) invalid();
  if (model.reasoningEfforts !== undefined) {
    if (!Array.isArray(model.reasoningEfforts) || model.reasoningEfforts.some(item => !['minimal', 'low', 'medium', 'high'].includes(item as string))) invalid();
  }
  if (model.limit !== undefined) {
    const limit = record(model.limit);
    keys(limit, ['context', 'input', 'output']);
    for (const value of Object.values(limit)) if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  }
  if (model.modalities !== undefined) {
    const modalities = record(model.modalities);
    keys(modalities, ['input', 'output']);
    for (const key of ['input', 'output']) {
      const values = modalities[key];
      if (!Array.isArray(values) || values.some(item => typeof item !== 'string')) invalid();
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function identifier(value: unknown): void {
  if (typeof value !== 'string' || !value.trim()) invalid();
}
function invalid(): never {
  throw new Error('invalid_agent_inspection_rpc');
}
