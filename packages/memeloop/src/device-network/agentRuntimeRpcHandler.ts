import type { AgentDefinition } from '../agent/types.js';
import type { ChatMessage, ConversationMessageEvent, ConversationTombstoneEvent } from '../conversation/index.js';
import { canonicalJsonBytes } from '../encoding/canonicalJson.js';
import type { MemeLoopRunStatus, MemeLoopRuntime } from '../runtime.js';
import {
  assertConversationFullContentMessagePage,
  assertConversationMessagePage,
  projectConversationMessageForList,
  readConversationMessageWindowAround,
} from '../storage/conversationPaging.js';
import type {
  ConversationFullContentMessagePageSuccess,
  ConversationMessageCursor,
  ConversationMessagePageSuccess,
  GetConversationMessageWindowAroundOptions,
  GetFullContentMessagePageOptions,
  GetMessagePageOptions,
} from '../storage/ports.js';
import type { IAgentStorage } from '../types.js';
import {
  AGENT_DEVICE_RPC_LIMITS,
  AGENT_DEVICE_RPC_METHODS,
  type AgentDeviceRpcContract,
  type AgentDeviceRpcDeleteTurnRequest,
  type AgentDeviceRpcGetAttachmentChunkRequest,
  type AgentDeviceRpcGetConversationMetaRequest,
  type AgentDeviceRpcGetMessageDetailRequest,
  type AgentDeviceRpcGetMessagePageRequest,
  type AgentDeviceRpcGetRunStatusRequest,
  type AgentDeviceRpcGrantResources,
  type AgentDeviceRpcMethod,
  type AgentDeviceRpcPullAgentRunLogRequest,
  type AgentDeviceRpcRequest,
  type AgentDeviceRpcRetryTurnRequest,
  type AgentDeviceRpcRunTurnRequest,
  type AgentDeviceRpcSendRequest,
  assertAgentDeviceRpcRequest,
  assertAgentDeviceRpcRequestEnvelope,
  assertAgentDeviceRpcResponseCorrelation,
  getAgentDeviceRpcGrantResources,
  isAgentDeviceRpcMethod,
  parseAgentDeviceRpcResponse,
} from './agentDeviceRpc.js';
import {
  type AttachmentUploadStore,
  type BeginAttachmentUploadRequest,
  type CommitAttachmentUploadRequest,
  decodeAttachmentUploadChunkRequest,
  type DecodedAttachmentUploadChunkRequest,
  verifyAttachmentUploadChunkIntegrity,
} from './attachmentUpload.js';
import { deviceConnectionGrantAllowsRpc } from './deviceGrantMessages.js';
import {
  assertScheduledTaskRpcResponseOrigin,
  type ScheduledTaskRpcHandlerInput,
  type ScheduledTaskRpcValidatedHandler,
  type ScheduledTaskRpcValidatedHandlerInput,
} from './scheduledTaskRpc.js';
import type { DeviceConnectionGrantStringScope, DeviceRpcHandler } from './types.js';

export interface AgentRuntimeRpcProjectionStore {
  listConversations(
    request: AgentDeviceRpcRequest<typeof AGENT_DEVICE_RPC_METHODS.listConversations>,
    context: AgentRuntimeRpcCollectionQueryContext,
  ): Promise<AgentDeviceRpcContract[typeof AGENT_DEVICE_RPC_METHODS.listConversations]['response']>;
  listTurns(
    /** Must enforce byteBudget while scanning and return continuation cursors. */
    request: AgentDeviceRpcRequest<typeof AGENT_DEVICE_RPC_METHODS.listTurns>,
    context: AgentRuntimeRpcReadContext,
  ): Promise<AgentDeviceRpcContract[typeof AGENT_DEVICE_RPC_METHODS.listTurns]['response']>;
  getTurnDetail(
    /** Must enforce maxBytes while scanning and return continuation cursors. */
    request: AgentDeviceRpcRequest<typeof AGENT_DEVICE_RPC_METHODS.getTurnDetail>,
    context: AgentRuntimeRpcReadContext,
  ): Promise<AgentDeviceRpcContract[typeof AGENT_DEVICE_RPC_METHODS.getTurnDetail]['response']>;
}

export interface AgentRuntimeRpcReadContext {
  signal?: AbortSignal;
}

/**
 * Authorization predicates that a collection adapter MUST put in its storage
 * query before ordering, cursor evaluation, pagination, or payload decoding.
 * `undefined` means all; an empty array means none. `scopeKey` must be bound
 * into opaque cursors so a cursor minted for another grant cannot be reused.
 */
export interface AgentRuntimeRpcCollectionQueryContext extends AgentRuntimeRpcReadContext {
  allowedConversationIds?: readonly string[];
  allowedDefinitionIds?: readonly string[];
  scopeKey: string;
}

export interface AgentRuntimeRpcDefinitionQueryContext extends AgentRuntimeRpcReadContext {
  allowedDefinitionIds?: readonly string[];
  scopeKey: string;
}

/** Bounded readers required by the complete remote Agent/chat RPC surface. */
export interface AgentRuntimeRpcStorage extends IAgentStorage {
  getMessagePage: NonNullable<IAgentStorage['getMessagePage']>;
  getMessageIdentity: NonNullable<IAgentStorage['getMessageIdentity']>;
  readMessageDetailRange: NonNullable<IAgentStorage['readMessageDetailRange']>;
  getMessageWindowAround: NonNullable<IAgentStorage['getMessageWindowAround']>;
  getConversationTimelinePage: NonNullable<IAgentStorage['getConversationTimelinePage']>;
  readAttachmentRange: NonNullable<IAgentStorage['readAttachmentRange']>;
}

export interface AgentRuntimeRpcRetryTurnResult {
  handle: Awaited<ReturnType<MemeLoopRuntime['sendMessage']>>;
  tombstone: ConversationTombstoneEvent;
  userEvent: ConversationMessageEvent;
}

export interface AgentRuntimeDeviceRpcHandlerOptions {
  runtime: Pick<MemeLoopRuntime, 'createAgent' | 'sendMessage' | 'getRunStatus' | 'cancelRun'>;
  storage: AgentRuntimeRpcStorage;
  /** Required scalable SQL/IndexedDB projections. There is deliberately no full-log fallback. */
  projections: AgentRuntimeRpcProjectionStore;
  /** Typed durable schedule handler, including execution-node target checks. */
  scheduledTaskHandler: ((input: ScheduledTaskRpcHandlerInput) => Promise<unknown>) & {
    dispatchValidatedRequest?: ScheduledTaskRpcValidatedHandler;
  };
  attachmentUploadStore?: AttachmentUploadStore;
  /** Atomic old-turn tombstone + new user event + durable run acceptance. */
  retryTurn?: (
    request: AgentDeviceRpcRetryTurnRequest,
    requestPeerId: string,
  ) => Promise<AgentRuntimeRpcRetryTurnResult>;
  /** Apply `allowedDefinitionIds` before reading definition payloads. */
  getAgentDefinitions?: (
    context: AgentRuntimeRpcDefinitionQueryContext,
  ) => AgentDefinition[] | Promise<AgentDefinition[]>;
  localNodeId?: string;
  /**
   * Explicit opt-in for an in-process handler that can never receive an
   * untrusted remote request. Network hosts must provide a verified grant or
   * an `authorize` callback instead.
   */
  trustedLocalOnly?: boolean;
  /** Optional host policy layered on top of the authenticated RPC v2 peer/grant check. */
  authorize?: (request: AgentRuntimeRpcAuthorizationRequest) => boolean | Promise<boolean>;
}

const AGENT_RUN_LOG_CONTENT_MAX_BYTES = 32 * 1024;
const RPC_MESSAGE_PROJECTION_MAX_BYTES = 128 * 1024;
const RPC_DETAIL_CHUNK_BYTES = 256 * 1024;
const RPC_ATTACHMENT_CHUNK_BYTES = 3 * 1024 * 1024;

export type AgentRuntimeRpcPermission = 'agent.read' | 'agent.execute' | 'agent.cancel';

export interface AgentRuntimeRpcAuthorizationRequest {
  remotePeerId: string;
  method: string;
  permission: AgentRuntimeRpcPermission;
  presentedGrant: Parameters<DeviceRpcHandler>[0]['presentedGrant'];
  conversationId?: string;
  definitionId?: string;
}

const RPC_METHOD_PERMISSION: Readonly<Record<string, AgentRuntimeRpcPermission>> = {
  [AGENT_DEVICE_RPC_METHODS.getDefinitions]: 'agent.read',
  [AGENT_DEVICE_RPC_METHODS.create]: 'agent.execute',
  [AGENT_DEVICE_RPC_METHODS.send]: 'agent.execute',
  [AGENT_DEVICE_RPC_METHODS.runTurn]: 'agent.execute',
  [AGENT_DEVICE_RPC_METHODS.getRunStatus]: 'agent.read',
  [AGENT_DEVICE_RPC_METHODS.cancel]: 'agent.cancel',
  [AGENT_DEVICE_RPC_METHODS.deleteTurn]: 'agent.cancel',
  [AGENT_DEVICE_RPC_METHODS.retryTurn]: 'agent.execute',
  [AGENT_DEVICE_RPC_METHODS.listConversations]: 'agent.read',
  [AGENT_DEVICE_RPC_METHODS.getConversationMeta]: 'agent.read',
  [AGENT_DEVICE_RPC_METHODS.listTurns]: 'agent.read',
  [AGENT_DEVICE_RPC_METHODS.getTurnDetail]: 'agent.read',
  [AGENT_DEVICE_RPC_METHODS.getMessagePage]: 'agent.read',
  [AGENT_DEVICE_RPC_METHODS.getConversationTimelinePage]: 'agent.read',
  [AGENT_DEVICE_RPC_METHODS.loadAround]: 'agent.read',
  [AGENT_DEVICE_RPC_METHODS.getMessageDetail]: 'agent.read',
  [AGENT_DEVICE_RPC_METHODS.getAttachmentChunk]: 'agent.read',
  [AGENT_DEVICE_RPC_METHODS.pullAgentRunLog]: 'agent.read',
  [AGENT_DEVICE_RPC_METHODS.beginAttachmentUpload]: 'agent.execute',
  [AGENT_DEVICE_RPC_METHODS.uploadAttachmentChunk]: 'agent.execute',
  [AGENT_DEVICE_RPC_METHODS.commitAttachmentUpload]: 'agent.execute',
  [AGENT_DEVICE_RPC_METHODS.scheduleList]: 'agent.read',
  [AGENT_DEVICE_RPC_METHODS.scheduleGet]: 'agent.read',
  [AGENT_DEVICE_RPC_METHODS.scheduleCreate]: 'agent.execute',
  [AGENT_DEVICE_RPC_METHODS.scheduleUpdate]: 'agent.execute',
  [AGENT_DEVICE_RPC_METHODS.scheduleDelete]: 'agent.cancel',
  [AGENT_DEVICE_RPC_METHODS.scheduleCronPreview]: 'agent.read',
};

export function createAgentRuntimeDeviceRpcHandler(options: AgentRuntimeDeviceRpcHandlerOptions): DeviceRpcHandler {
  return async ({ remotePeerId, method, parameters, presentedGrant, signal }) => {
    signal?.throwIfAborted();
    if (!isAgentDeviceRpcMethod(method)) throw new Error(`rpc_method_not_found:${method}`);
    const permission = RPC_METHOD_PERMISSION[method];
    let decodedAttachmentUploadChunk: DecodedAttachmentUploadChunkRequest | undefined;
    if (method === AGENT_DEVICE_RPC_METHODS.uploadAttachmentChunk) {
      assertAgentDeviceRpcRequestEnvelope(parameters);
      decodedAttachmentUploadChunk = decodeAttachmentUploadChunkRequest(parameters);
    } else {
      assertAgentDeviceRpcRequest(method, parameters);
    }
    signal?.throwIfAborted();
    const request = parameters as AgentDeviceRpcRequest<typeof method>;
    const claimedResources = getAgentDeviceRpcGrantResources(method, request);
    await authorizeRpc(options, {
      remotePeerId,
      method,
      permission,
      presentedGrant,
      conversationId: claimedResources.conversationId,
      definitionId: claimedResources.definitionId,
    }, true);
    const durableRun = await resolveDurableRunForRequest(options, remotePeerId, claimedResources, signal);
    const resources = await resolveAuthorizationResources(options, method, claimedResources, durableRun, signal);
    await authorizeRpc(options, {
      remotePeerId,
      method,
      permission,
      presentedGrant,
      ...resources,
    });
    switch (method) {
      case AGENT_DEVICE_RPC_METHODS.getDefinitions: {
        const request = parameters as AgentDeviceRpcRequest<typeof method>;
        const scope = collectionQueryContext(presentedGrant, signal);
        if (scope.allowedDefinitionIds?.length === 0) {
          return validatedResponse(method, { definitions: [] }, request);
        }
        const definitions = await options.getAgentDefinitions?.({
          allowedDefinitionIds: scope.allowedDefinitionIds,
          scopeKey: scope.scopeKey,
          ...(signal === undefined ? {} : { signal }),
        }) ?? [];
        signal?.throwIfAborted();
        assertDefinitionsWithinGrant(method, definitions, presentedGrant);
        return validatedResponse(method, { definitions }, request);
      }
      case AGENT_DEVICE_RPC_METHODS.create: {
        const request = parameters as AgentDeviceRpcRequest<typeof method>;
        return validatedResponse(
          method,
          await options.runtime.createAgent({
            definitionId: request.definitionId,
            initialMessage: request.initialMessage,
            conversationId: request.conversationId,
          }),
          request,
        );
      }
      case AGENT_DEVICE_RPC_METHODS.send: {
        const request = parameters as AgentDeviceRpcSendRequest;
        const handle = await options.runtime.sendMessage({
          ...request,
          requestPeerId: remotePeerId,
        });
        return validatedResponse(method, { ok: true, ...handle }, request);
      }
      case AGENT_DEVICE_RPC_METHODS.runTurn: {
        const request = parameters as AgentDeviceRpcRunTurnRequest;
        if (request.conversation && request.conversation.definitionId !== request.definitionId) {
          throw new Error('invalid_rpc_params');
        }
        await options.runtime.createAgent({
          definitionId: request.definitionId,
          conversationId: request.conversationId,
        });
        const handle = await options.runtime.sendMessage({
          ...request,
          requestPeerId: remotePeerId,
        });
        return validatedResponse(method, { ok: true, ...handle }, request);
      }
      case AGENT_DEVICE_RPC_METHODS.getRunStatus: {
        const request = parameters as AgentDeviceRpcGetRunStatusRequest;
        return validatedResponse(method, { status: durableRun ?? null }, request);
      }
      case AGENT_DEVICE_RPC_METHODS.cancel: {
        const request = parameters as AgentDeviceRpcGetRunStatusRequest;
        const ok = durableRun ? await options.runtime.cancelRun(request.runId) : false;
        const status = durableRun ? await options.runtime.getRunStatus(request.runId) ?? durableRun : null;
        return validatedResponse(method, { ok, status }, request);
      }
      case AGENT_DEVICE_RPC_METHODS.deleteTurn: {
        const request = parameters as AgentDeviceRpcDeleteTurnRequest;
        if (!options.storage.appendLocalEvent || !options.localNodeId) {
          throw new Error('turn_control_store_unavailable');
        }
        const tombstone = await options.storage.appendLocalEvent({
          kind: 'tombstone',
          eventId: `rpc:tombstone:${remotePeerId}:${request.requestId}`,
          conversationId: request.conversationId,
          originNodeId: options.localNodeId,
          timestamp: Date.now(),
          targetTurnId: request.turnId,
          reason: request.reason ?? 'user-delete',
        });
        if (tombstone.kind !== 'tombstone') throw new Error('turn_control_store_invalid_event');
        return validatedResponse(method, {
          ok: true,
          conversationId: request.conversationId,
          turnId: request.turnId,
          requestId: request.requestId,
          tombstone,
        }, request);
      }
      case AGENT_DEVICE_RPC_METHODS.retryTurn: {
        const request = parameters as AgentDeviceRpcRetryTurnRequest;
        if (!options.retryTurn) throw new Error('turn_retry_runtime_unavailable');
        const result = await options.retryTurn(request, remotePeerId);
        return validatedResponse(method, {
          ok: true,
          ...result.handle,
          tombstone: result.tombstone,
          userEvent: result.userEvent,
        }, request);
      }
      case AGENT_DEVICE_RPC_METHODS.listConversations:
      case AGENT_DEVICE_RPC_METHODS.listTurns:
      case AGENT_DEVICE_RPC_METHODS.getTurnDetail:
        return handleProjectionRequest(options, method, parameters, presentedGrant, signal);
      case AGENT_DEVICE_RPC_METHODS.loadAround: {
        const request = parameters as AgentDeviceRpcRequest<typeof method>;
        const query: GetConversationMessageWindowAroundOptions = {
          focus: request.focus,
          expectedRevision: request.expectedRevision,
          maxMessages: request.maxMessages ?? AGENT_DEVICE_RPC_LIMITS.loadAroundMessages,
          maxBytes: request.maxBytes ?? AGENT_DEVICE_RPC_LIMITS.loadAroundDefaultBytes,
        };
        const page = await readConversationMessageWindowAround(
          options.storage,
          request.conversationId,
          query,
          { signal },
        );
        signal?.throwIfAborted();
        const response = page.reset
          ? page
          : {
            reset: false as const,
            conversationId: page.conversationId,
            revision: page.revision,
            focus: page.focus,
            recenterAnchor: page.recenterAnchor,
            items: page.items.map(item => projectConversationMessageForList(item, RPC_MESSAGE_PROJECTION_MAX_BYTES)),
            hasMoreBefore: page.hasMoreBefore,
            hasMoreAfter: page.hasMoreAfter,
            ...(page.hasMoreBefore && page.startCursor
              ? {
                previousCursor: encodeMessageCursor(page.startCursor, {
                  conversationId: page.conversationId,
                  revision: page.revision,
                  direction: 'backward',
                }),
              }
              : {}),
            ...(page.hasMoreAfter && page.endCursor
              ? {
                nextCursor: encodeMessageCursor(page.endCursor, {
                  conversationId: page.conversationId,
                  revision: page.revision,
                  direction: 'forward',
                }),
              }
              : {}),
          };
        return validatedResponse(method, response, request);
      }
      case AGENT_DEVICE_RPC_METHODS.getConversationTimelinePage: {
        const request = parameters as AgentDeviceRpcRequest<typeof method>;
        const normalized = {
          ...request,
          limit: request.limit ?? AGENT_DEVICE_RPC_LIMITS.timelinePage,
          maxBytes: request.maxBytes ?? AGENT_DEVICE_RPC_LIMITS.timelinePageDefaultBytes,
        };
        const { conversationId, ...query } = normalized;
        const page = await options.storage.getConversationTimelinePage(
          conversationId,
          query,
          { signal },
        );
        signal?.throwIfAborted();
        return validatedResponse(method, page, request);
      }
      case AGENT_DEVICE_RPC_METHODS.getConversationMeta: {
        const request = parameters as AgentDeviceRpcGetConversationMetaRequest;
        const meta = await options.storage.getConversationMeta(request.conversationId, { signal });
        signal?.throwIfAborted();
        return validatedResponse(method, {
          meta,
        }, request);
      }
      case AGENT_DEVICE_RPC_METHODS.getMessagePage: {
        const request = parameters as AgentDeviceRpcGetMessagePageRequest;
        const keyset = decodeMessageCursor(request.cursor, {
          conversationId: request.conversationId,
          ...(request.expectedRevision === undefined ? {} : { revision: request.expectedRevision }),
          direction: request.direction ?? 'backward',
        });
        const page = await readRequiredMessagePage(
          options.storage,
          request.conversationId,
          {
            limit: request.limit ?? AGENT_DEVICE_RPC_LIMITS.messagePage,
            ...(request.direction === 'forward' ? { after: keyset } : { before: keyset }),
            direction: request.direction,
            // The stored projection is already bounded; enforce the caller's
            // smaller wire budget below without re-projecting full messages.
            maxBytes: AGENT_DEVICE_RPC_LIMITS.projectionPageMaxBytes,
            ...(request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision }),
            signal,
          },
        );
        if (page.reset) return validatedResponse(method, page, request);
        return validatedResponse(
          method,
          await buildBoundedMessagePageResponse(options.storage, request, page, signal),
          request,
        );
      }
      case AGENT_DEVICE_RPC_METHODS.getMessageDetail: {
        const request = parameters as AgentDeviceRpcGetMessageDetailRequest;
        const range = await options.storage.readMessageDetailRange(
          request.conversationId,
          request.messageId,
          request.offset ?? 0,
          RPC_DETAIL_CHUNK_BYTES,
          { signal },
        );
        signal?.throwIfAborted();
        assertMessageDetailRange(range, request.offset ?? 0);
        if (!range.found) return validatedResponse(method, { found: false }, request);
        const nextOffset = range.offset + range.bytes.byteLength;
        return validatedResponse(method, {
          found: true,
          encoding: 'base64-json' as const,
          data: bytesToBase64(range.bytes),
          offset: range.offset,
          totalBytes: range.totalBytes,
          ...(nextOffset < range.totalBytes ? { nextOffset } : {}),
        }, request);
      }
      case AGENT_DEVICE_RPC_METHODS.getAttachmentChunk: {
        const request = parameters as AgentDeviceRpcGetAttachmentChunkRequest;
        if (
          !await options.storage.conversationReferencesAttachment(
            request.conversationId,
            request.contentHash,
            { signal },
          )
        ) {
          throw new Error('rpc_resource_not_found');
        }
        signal?.throwIfAborted();
        const reference = await options.storage.getAttachment(request.contentHash, { signal });
        signal?.throwIfAborted();
        if (!reference) return validatedResponse(method, { found: false }, request);
        const offset = request.offset ?? 0;
        if (offset > reference.size) throw new Error('invalid_rpc_params');
        const chunk = await options.storage.readAttachmentRange(
          request.contentHash,
          offset,
          RPC_ATTACHMENT_CHUNK_BYTES,
          { signal },
        );
        signal?.throwIfAborted();
        if (!chunk) throw new Error('rpc_resource_not_found');
        if (chunk.byteLength > RPC_ATTACHMENT_CHUNK_BYTES || offset + chunk.byteLength > reference.size) {
          throw new Error('attachment_range_reader_invalid');
        }
        return validatedResponse(method, {
          found: true,
          reference,
          encoding: 'base64',
          data: bytesToBase64(chunk),
          offset,
          totalBytes: reference.size,
          ...(offset + chunk.byteLength < reference.size
            ? { nextOffset: offset + chunk.byteLength }
            : {}),
        }, request);
      }
      case AGENT_DEVICE_RPC_METHODS.pullAgentRunLog: {
        const request = parameters as AgentDeviceRpcPullAgentRunLogRequest;
        const after = decodeMessageCursor(request.cursor, {
          conversationId: request.conversationId,
          direction: 'forward',
        });
        const page = await readRequiredFullContentMessagePage(options.storage, request.conversationId, {
          limit: request.limit ?? AGENT_DEVICE_RPC_LIMITS.runLogPage,
          ...(after ? { after } : {}),
          direction: 'forward',
          maxBytes: request.maxBytes ?? AGENT_DEVICE_RPC_LIMITS.runLogPageBytes,
          signal,
        });
        if (page.reset) throw new Error('conversation_message_page_unexpected_reset');
        return validatedResponse(
          method,
          buildBoundedRunLogResponse(request, page, durableRun),
          request,
        );
      }
      case AGENT_DEVICE_RPC_METHODS.beginAttachmentUpload: {
        if (!options.attachmentUploadStore) throw new Error('attachment_upload_store_unavailable');
        return validatedResponse(
          method,
          await options.attachmentUploadStore.beginAttachmentUpload(
            parameters as BeginAttachmentUploadRequest,
            { ownerPeerId: remotePeerId, signal },
          ),
          parameters as AgentDeviceRpcRequest<typeof method>,
        );
      }
      case AGENT_DEVICE_RPC_METHODS.uploadAttachmentChunk: {
        if (!options.attachmentUploadStore) throw new Error('attachment_upload_store_unavailable');
        if (!decodedAttachmentUploadChunk) throw new Error('invalid_rpc_params');
        const { request, data } = decodedAttachmentUploadChunk;
        await verifyAttachmentUploadChunkIntegrity(request, data);
        return validatedResponse(
          method,
          await options.attachmentUploadStore.writeAttachmentUploadChunk({
            requestId: request.requestId,
            conversationId: request.conversationId,
            uploadId: request.uploadId,
            offset: request.offset,
            byteLength: request.byteLength,
            sha256: request.sha256,
            data,
          }, { ownerPeerId: remotePeerId, signal }),
          request,
        );
      }
      case AGENT_DEVICE_RPC_METHODS.commitAttachmentUpload: {
        if (!options.attachmentUploadStore) throw new Error('attachment_upload_store_unavailable');
        return validatedResponse(
          method,
          await options.attachmentUploadStore.commitAttachmentUpload(
            parameters as CommitAttachmentUploadRequest,
            { ownerPeerId: remotePeerId, signal },
          ),
          parameters as AgentDeviceRpcRequest<typeof method>,
        );
      }
      case AGENT_DEVICE_RPC_METHODS.scheduleList:
      case AGENT_DEVICE_RPC_METHODS.scheduleGet:
      case AGENT_DEVICE_RPC_METHODS.scheduleCreate:
      case AGENT_DEVICE_RPC_METHODS.scheduleUpdate:
      case AGENT_DEVICE_RPC_METHODS.scheduleDelete:
      case AGENT_DEVICE_RPC_METHODS.scheduleCronPreview: {
        const scheduledRequest = parameters as AgentDeviceRpcRequest<typeof method>;
        const validatedInput = { remotePeerId, method, parameters: scheduledRequest, resources: claimedResources, signal } as ScheduledTaskRpcValidatedHandlerInput;
        const handle = options.scheduledTaskHandler.dispatchValidatedRequest ??
          options.scheduledTaskHandler;
        const response = validatedResponse(
          method,
          await handle(validatedInput),
          scheduledRequest,
        );
        assertScheduledTaskRpcResponseOrigin(method, response, remotePeerId);
        return response;
      }
    }
  };
}

async function readRequiredFullContentMessagePage(
  storage: AgentRuntimeRpcStorage,
  conversationId: string,
  options: GetFullContentMessagePageOptions & { maxBytes: number; signal?: AbortSignal },
) {
  options.signal?.throwIfAborted();
  const { signal, ...query } = options;
  const page = await storage.getFullContentMessagePage(conversationId, query, { signal });
  options.signal?.throwIfAborted();
  assertConversationFullContentMessagePage(page, conversationId, query);
  return page;
}

function assertMessageDetailRange(
  range: Awaited<ReturnType<AgentRuntimeRpcStorage['readMessageDetailRange']>>,
  requestedOffset: number,
): void {
  if (range === null || typeof range !== 'object' || Array.isArray(range)) {
    throw new Error('invalid_message_detail_range');
  }
  if (!range.found) {
    if (Reflect.ownKeys(range).length !== 1) throw new Error('invalid_message_detail_range');
    return;
  }
  if (
    Reflect.ownKeys(range).some(key => typeof key !== 'string' || !['found', 'offset', 'totalBytes', 'bytes'].includes(key)) ||
    !Number.isSafeInteger(range.offset) || range.offset !== requestedOffset ||
    !Number.isSafeInteger(range.totalBytes) || range.totalBytes < 0 ||
    range.totalBytes > AGENT_DEVICE_RPC_LIMITS.messageDetailBytes ||
    !(range.bytes instanceof Uint8Array) ||
    range.bytes.byteLength > RPC_DETAIL_CHUNK_BYTES ||
    range.offset + range.bytes.byteLength > range.totalBytes ||
    (range.offset < range.totalBytes && range.bytes.byteLength === 0)
  ) throw new Error('invalid_message_detail_range');
}

async function resolveDurableRunForRequest(
  options: AgentRuntimeDeviceRpcHandlerOptions,
  remotePeerId: string,
  resources: AgentDeviceRpcGrantResources,
  signal?: AbortSignal,
): Promise<MemeLoopRunStatus | undefined> {
  if (!resources.runId) return undefined;
  const run = await options.runtime.getRunStatus(resources.runId);
  signal?.throwIfAborted();
  if (!run || run.requestPeerId !== remotePeerId) throw new Error('rpc_resource_not_found');
  if (resources.conversationId !== undefined && run.conversationId !== resources.conversationId) {
    throw new Error('rpc_resource_not_found');
  }
  return run;
}

async function resolveAuthorizationResources(
  options: AgentRuntimeDeviceRpcHandlerOptions,
  method: AgentDeviceRpcMethod,
  claimed: AgentDeviceRpcGrantResources,
  durableRun: MemeLoopRunStatus | undefined,
  signal?: AbortSignal,
): Promise<{ conversationId?: string; definitionId?: string }> {
  if (claimed.runId) {
    return durableRun
      ? { conversationId: durableRun.conversationId, definitionId: durableRun.definitionId }
      : {};
  }
  if (!claimed.conversationId) return claimed;
  const metadata = await options.storage.getConversationMeta(claimed.conversationId, { signal });
  signal?.throwIfAborted();
  if (!metadata) {
    // Only explicit create/open operations may authorize a genuinely new
    // conversation from caller claims. Every other method targets durable
    // state and must make unknown resources indistinguishable.
    if (
      method === AGENT_DEVICE_RPC_METHODS.create ||
      method === AGENT_DEVICE_RPC_METHODS.runTurn
    ) return claimed;
    throw new Error('rpc_resource_not_found');
  }
  if (claimed.definitionId !== undefined && claimed.definitionId !== metadata.definitionId) {
    throw new Error('rpc_resource_not_found');
  }
  return { conversationId: claimed.conversationId, definitionId: metadata.definitionId };
}

async function authorizeRpc(
  options: AgentRuntimeDeviceRpcHandlerOptions,
  request: AgentRuntimeRpcAuthorizationRequest,
  preflight = false,
): Promise<void> {
  if (
    request.presentedGrant === undefined &&
    options.authorize === undefined &&
    options.trustedLocalOnly !== true
  ) throw new Error(`rpc_permission_denied:${request.method}`);
  if (
    request.presentedGrant !== undefined &&
    !deviceConnectionGrantAllowsRpc(request.presentedGrant, {
      method: request.method,
      conversationId: request.conversationId,
      definitionId: request.definitionId,
    })
  ) throw new Error(`rpc_permission_denied:${request.method}`);
  if (options.authorize && !await options.authorize(request)) {
    throw new Error(`rpc_permission_denied:${request.method}`);
  }
  if (preflight) return;
}

async function readRequiredMessagePage(
  storage: AgentRuntimeRpcStorage,
  conversationId: string,
  options: GetMessagePageOptions & { maxBytes: number; signal?: AbortSignal },
) {
  options.signal?.throwIfAborted();
  const { signal, ...query } = options;
  const page = await storage.getMessagePage(conversationId, query, { signal });
  options.signal?.throwIfAborted();
  assertConversationMessagePage(page, conversationId, query);
  return page;
}

async function handleProjectionRequest(
  options: AgentRuntimeDeviceRpcHandlerOptions,
  method:
    | typeof AGENT_DEVICE_RPC_METHODS.listConversations
    | typeof AGENT_DEVICE_RPC_METHODS.listTurns
    | typeof AGENT_DEVICE_RPC_METHODS.getTurnDetail,
  parameters: unknown,
  presentedGrant: AgentRuntimeRpcAuthorizationRequest['presentedGrant'],
  signal?: AbortSignal,
): Promise<unknown> {
  const projections = options.projections;
  const readContext: AgentRuntimeRpcReadContext = signal === undefined ? {} : { signal };
  switch (method) {
    case AGENT_DEVICE_RPC_METHODS.listConversations: {
      const request = parameters as AgentDeviceRpcRequest<typeof method>;
      const scope = collectionQueryContext(presentedGrant, signal);
      if (
        scope.allowedConversationIds?.length === 0 ||
        scope.allowedDefinitionIds?.length === 0
      ) {
        return validatedResponse(method, {
          items: [],
          hasMoreBefore: false,
          hasMoreAfter: false,
          ...(request.seenCursor === undefined ? {} : { seenCursorFound: false }),
        }, request);
      }
      const response = await projections.listConversations(request, scope);
      signal?.throwIfAborted();
      assertConversationsWithinGrant(method, response.items, presentedGrant);
      return validatedResponse(method, response, request);
    }
    case AGENT_DEVICE_RPC_METHODS.listTurns: {
      const request = parameters as AgentDeviceRpcRequest<typeof method>;
      const boundedRequest = withProjectionBudget(method, request);
      return validatedProjectionResponse(
        method,
        request,
        await projections.listTurns(boundedRequest, readContext),
        signal,
      );
    }
    case AGENT_DEVICE_RPC_METHODS.getTurnDetail: {
      const request = parameters as AgentDeviceRpcRequest<typeof method>;
      const boundedRequest = withProjectionBudget(method, request);
      return validatedProjectionResponse(
        method,
        request,
        await projections.getTurnDetail(boundedRequest, readContext),
        signal,
      );
    }
  }
}

function collectionQueryContext(
  grant: AgentRuntimeRpcAuthorizationRequest['presentedGrant'],
  signal?: AbortSignal,
): AgentRuntimeRpcCollectionQueryContext {
  const conversationIds = scopeIds(grant?.conversationScope);
  const definitionIds = scopeIds(grant?.definitionScope);
  const scopeKey = bytesToBase64(canonicalJsonBytes({
    accountId: grant?.accountId ?? 'trusted-local',
    subjectPeerId: grant?.subjectPeerId ?? 'trusted-local',
    conversations: conversationIds ?? 'all',
    definitions: definitionIds ?? 'all',
  }, {
    maxBytes: 1024 * 1024,
    maxStringBytes: 1024,
    maxStringCodeUnits: 1024,
  }));
  return {
    ...(conversationIds === undefined ? {} : { allowedConversationIds: conversationIds }),
    ...(definitionIds === undefined ? {} : { allowedDefinitionIds: definitionIds }),
    scopeKey,
    ...(signal === undefined ? {} : { signal }),
  };
}

function scopeIds(
  scope: DeviceConnectionGrantStringScope | undefined,
): readonly string[] | undefined {
  if (scope === undefined || scope.mode === 'all') return undefined;
  if (scope.mode === 'none') return [];
  return [...scope.ids];
}

function assertDefinitionsWithinGrant(
  method: string,
  definitions: readonly AgentDefinition[],
  grant: AgentRuntimeRpcAuthorizationRequest['presentedGrant'],
): void {
  if (grant === undefined) return;
  for (const definition of definitions) {
    if (!deviceConnectionGrantAllowsRpc(grant, { method, definitionId: definition.id })) {
      throw new Error('rpc_collection_scope_violation');
    }
  }
}

function assertConversationsWithinGrant(
  method: string,
  conversations: readonly { conversationId: string; definitionId?: string }[],
  grant: AgentRuntimeRpcAuthorizationRequest['presentedGrant'],
): void {
  if (grant === undefined) return;
  for (const conversation of conversations) {
    if (
      !deviceConnectionGrantAllowsRpc(grant, {
        method,
        conversationId: conversation.conversationId,
        definitionId: conversation.definitionId,
      })
    ) throw new Error('rpc_collection_scope_violation');
  }
}

function withProjectionBudget<
  M extends
    | typeof AGENT_DEVICE_RPC_METHODS.listTurns
    | typeof AGENT_DEVICE_RPC_METHODS.getTurnDetail,
>(
  method: M,
  request: AgentDeviceRpcRequest<M>,
): AgentDeviceRpcRequest<M> {
  const record = request as unknown as Record<string, unknown>;
  return {
    ...record,
    ...(method === AGENT_DEVICE_RPC_METHODS.listTurns
      ? { byteBudget: record.byteBudget ?? AGENT_DEVICE_RPC_LIMITS.projectionPageDefaultBytes }
      : {
        limit: record.limit ?? AGENT_DEVICE_RPC_LIMITS.turnDetailPage,
        maxBytes: record.maxBytes ?? AGENT_DEVICE_RPC_LIMITS.turnDetailDefaultBytes,
      }),
  } as AgentDeviceRpcRequest<M>;
}

function validatedProjectionResponse<
  M extends
    | typeof AGENT_DEVICE_RPC_METHODS.listTurns
    | typeof AGENT_DEVICE_RPC_METHODS.getTurnDetail,
>(
  method: M,
  request: AgentDeviceRpcRequest<M>,
  value: AgentDeviceRpcContract[M]['response'],
  signal?: AbortSignal,
): AgentDeviceRpcContract[M]['response'] {
  signal?.throwIfAborted();
  return validatedResponse(method, value, request);
}

function validatedResponse<M extends AgentDeviceRpcMethod>(
  method: M,
  value: unknown,
  request: AgentDeviceRpcRequest<M>,
): AgentDeviceRpcContract[M]['response'] {
  const response = parseAgentDeviceRpcResponse(method, value);
  assertAgentDeviceRpcResponseCorrelation(method, request, response);
  return response;
}

interface MessageCursorEnvelope {
  version: 2;
  kind: 'message';
  conversationId: string;
  revision?: string;
  direction: 'backward' | 'forward';
  cursor: ConversationMessageCursor;
}

interface MessageCursorScope {
  conversationId: string;
  revision?: string;
  direction: 'backward' | 'forward';
}

function encodeMessageCursor(cursor: ConversationMessageCursor, scope: MessageCursorScope): string {
  return bytesToBase64(canonicalJsonBytes(
    {
      version: 2,
      kind: 'message',
      conversationId: scope.conversationId,
      ...(scope.revision === undefined ? {} : { revision: scope.revision }),
      direction: scope.direction,
      cursor,
    } satisfies MessageCursorEnvelope,
    {
      maxBytes: 4096,
      maxStringBytes: 1024,
      maxStringCodeUnits: 1024,
    },
  ));
}

function decodeMessageCursor(
  value: string | undefined,
  expected: Partial<MessageCursorScope>,
): ConversationMessageCursor | undefined {
  if (value === undefined) return undefined;
  let envelope: unknown;
  try {
    envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64ToBytes(value)));
  } catch {
    throw new Error('invalid_rpc_params');
  }
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('invalid_rpc_params');
  }
  const record = envelope as Partial<MessageCursorEnvelope>;
  const cursor = record.cursor;
  if (
    Object.keys(record).some(key => !['version', 'kind', 'conversationId', 'revision', 'direction', 'cursor'].includes(key)) ||
    record.version !== 2 || record.kind !== 'message' || cursor === undefined ||
    typeof record.conversationId !== 'string' || record.conversationId.length === 0 ||
    (record.revision !== undefined && (typeof record.revision !== 'string' || record.revision.length === 0)) ||
    (record.direction !== 'backward' && record.direction !== 'forward') ||
    (expected.conversationId !== undefined && record.conversationId !== expected.conversationId) ||
    (expected.revision !== undefined && record.revision !== expected.revision) ||
    (record.revision !== undefined && expected.revision === undefined) ||
    (expected.direction !== undefined && record.direction !== expected.direction) ||
    cursor === null || typeof cursor !== 'object' || Array.isArray(cursor) ||
    Object.keys(cursor).some(key => !['timestamp', 'lamportClock', 'originNodeId', 'messageId'].includes(key)) ||
    !Number.isSafeInteger(cursor.timestamp) || cursor.timestamp < 0 ||
    !Number.isSafeInteger(cursor.lamportClock) || cursor.lamportClock < 0 ||
    typeof cursor.originNodeId !== 'string' || cursor.originNodeId.length === 0 ||
    typeof cursor.messageId !== 'string' || cursor.messageId.length === 0
  ) throw new Error('invalid_rpc_params');
  return cursor;
}

async function buildBoundedMessagePageResponse(
  storage: AgentRuntimeRpcStorage,
  request: AgentDeviceRpcGetMessagePageRequest,
  page: ConversationMessagePageSuccess,
  signal?: AbortSignal,
): Promise<AgentDeviceRpcContract[typeof AGENT_DEVICE_RPC_METHODS.getMessagePage]['response']> {
  const maximumBytes = request.maxBytes ?? AGENT_DEVICE_RPC_LIMITS.projectionPageDefaultBytes;
  const maximumItemBytes = Math.min(
    RPC_MESSAGE_PROJECTION_MAX_BYTES,
    Math.max(16 * 1024, Math.floor(maximumBytes / 4)),
  );
  const projected = page.items.map(source => ({
    source,
    // Storage already returned a lightweight projection. A remote caller may
    // request a smaller page budget, so derive a smaller projection without
    // ever materializing or casting it back to a full ChatMessage.
    item: projectConversationMessageForList(source, maximumItemBytes),
  }));
  const readingForward = request.direction === 'forward';
  const seenCursorFound = request.seenCursor === undefined
    ? undefined
    : await messageCursorExists(
      storage,
      request.conversationId,
      request.seenCursor,
      request.expectedRevision,
      signal,
    );
  const selected = [...projected];
  const response = () => {
    const truncated = selected.length < projected.length;
    const first = selected[0]?.source;
    const last = selected.at(-1)?.source;
    const hasMoreBefore = page.hasMoreBefore || (!readingForward && truncated);
    const hasMoreAfter = page.hasMoreAfter || (readingForward && truncated);
    return {
      reset: false as const,
      conversationId: page.conversationId,
      revision: page.revision,
      items: selected.map(entry => entry.item),
      hasMoreBefore,
      hasMoreAfter,
      ...(first && hasMoreBefore
        ? {
          previousCursor: encodeMessageCursor(messageCursor(first), {
            conversationId: request.conversationId,
            revision: page.revision,
            direction: 'backward',
          }),
        }
        : {}),
      ...(last && hasMoreAfter
        ? {
          nextCursor: encodeMessageCursor(messageCursor(last), {
            conversationId: request.conversationId,
            revision: page.revision,
            direction: 'forward',
          }),
        }
        : {}),
      ...(seenCursorFound === undefined ? {} : { seenCursorFound }),
    };
  };
  while (selected.length > 0 && jsonUtf8ByteLength(response()) > maximumBytes) {
    if (readingForward) selected.pop();
    else selected.shift();
  }
  if (projected.length > 0 && selected.length === 0) {
    throw new Error('rpc_projection_item_exceeds_byte_budget');
  }
  return response();
}

function buildBoundedRunLogResponse(
  request: AgentDeviceRpcPullAgentRunLogRequest,
  page: ConversationFullContentMessagePageSuccess,
  durableRun: MemeLoopRunStatus | undefined,
): AgentDeviceRpcContract[typeof AGENT_DEVICE_RPC_METHODS.pullAgentRunLog]['response'] {
  const maximumBytes = request.maxBytes ?? AGENT_DEVICE_RPC_LIMITS.runLogPageBytes;
  const matching = page.items
    .filter(message => message.turnId === durableRun?.turnId)
    .map(source => ({
      source,
      item: {
        messageId: source.messageId,
        role: source.role,
        content: utf8Prefix(source.content, AGENT_RUN_LOG_CONTENT_MAX_BYTES),
      },
    }));
  const selected = [...matching];
  const response = () => {
    const truncated = selected.length < matching.length;
    const continuation = truncated
      ? selected.at(-1)?.source && messageCursor(selected.at(-1)!.source)
      : page.endCursor;
    const hasMoreAfter = truncated || page.hasMoreAfter;
    return {
      messages: selected.map(entry => entry.item),
      ...(continuation && hasMoreAfter
        ? {
          nextCursor: encodeMessageCursor(continuation, {
            conversationId: request.conversationId,
            direction: 'forward',
          }),
        }
        : {}),
      hasMoreAfter,
      runStatus: durableRun ?? null,
    };
  };
  while (selected.length > 0 && jsonUtf8ByteLength(response()) > maximumBytes) selected.pop();
  if (matching.length > 0 && selected.length === 0) {
    throw new Error('rpc_projection_item_exceeds_byte_budget');
  }
  return response();
}

async function messageCursorExists(
  storage: AgentRuntimeRpcStorage,
  conversationId: string,
  encoded: string,
  revision?: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const cursor = decodeMessageCursor(encoded, {
    conversationId,
    ...(revision === undefined ? {} : { revision }),
  });
  if (!cursor) return false;
  const message = await storage.getMessageIdentity(conversationId, cursor.messageId, { signal });
  signal?.throwIfAborted();
  return message !== null &&
    message.timestamp === cursor.timestamp &&
    message.lamportClock === cursor.lamportClock &&
    message.originNodeId === cursor.originNodeId;
}

function base64ToBytes(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('invalid_rpc_params');
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function messageCursor(message: ChatMessage): ConversationMessageCursor {
  return {
    timestamp: message.timestamp,
    lamportClock: message.lamportClock,
    originNodeId: message.originNodeId,
    messageId: message.messageId,
  };
}

function jsonUtf8ByteLength(value: unknown): number {
  try {
    return canonicalJsonBytes(value, {
      maxBytes: AGENT_DEVICE_RPC_LIMITS.projectionPageMaxBytes,
      maxStringBytes: AGENT_DEVICE_RPC_LIMITS.projectionPageMaxBytes,
      maxStringCodeUnits: AGENT_DEVICE_RPC_LIMITS.projectionPageMaxBytes,
    }).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function utf8Prefix(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return '';
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maximumBytes) return value;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = Math.min(maximumBytes, encoded.byteLength); end > Math.max(0, maximumBytes - 4); end -= 1) {
    try {
      return decoder.decode(encoded.subarray(0, end));
    } catch {
      // UTF-8 code points are at most four bytes, so only the trailing prefix can fail.
    }
  }
  throw new Error('rpc_utf8_projection_failed');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const blockSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + blockSize));
  }
  return btoa(binary);
}
