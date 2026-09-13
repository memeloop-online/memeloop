import { describe, expect, it, vi } from 'vitest';

import type { ChatMessage, ConversationMessageEvent, ConversationTombstoneEvent } from '../../conversation/index.js';
import { canonicalJsonBytes } from '../../encoding/canonicalJson.js';
import type { MemeLoopRunStatus, MemeLoopRuntime } from '../../runtime.js';
import { projectConversationMessageForList } from '../../storage/conversationPaging.js';
import type { ConversationFullContentMessagePage, ConversationMessageListProjection, ConversationMessagePage } from '../../storage/ports.js';
import type { ConversationMeta } from '../../sync/protocol.js';
import type { FullAgentStorage } from '../../types.js';
import { AGENT_DEVICE_RPC_METHODS } from '../agentDeviceRpc.js';
import {
  type AgentRuntimeDeviceRpcHandlerOptions,
  type AgentRuntimeRpcProjectionStore,
  type AgentRuntimeRpcStorage,
  createAgentRuntimeDeviceRpcHandler,
} from '../agentRuntimeRpcHandler.js';
import { DEVICE_CONNECTION_GRANT_MAX_TTL_MS } from '../deviceGrantMessages.js';
import { SCHEDULED_TASK_RPC_LIMITS } from '../scheduledTaskRpc.js';
import type { DeviceConnectionGrant } from '../types.js';

const CONVERSATION_ID = 'conversation-1';
const DEFINITION_ID = 'assistant';
const REMOTE_PEER_ID = 'peer-a';

function grant(
  methods: DeviceConnectionGrant['rpcMethodScope'] = { mode: 'all' },
  scopes: Partial<Pick<DeviceConnectionGrant, 'conversationScope' | 'definitionScope'>> = {},
): DeviceConnectionGrant {
  return {
    issuer: 'memeloop-cloud',
    accountId: 'account-1',
    subjectPeerId: REMOTE_PEER_ID,
    allowedPeerIds: ['local-peer'],
    protocols: ['/memeloop/rpc/2.0.0'],
    rpcMethodScope: methods,
    conversationScope: scopes.conversationScope ?? { mode: 'all' },
    definitionScope: scopes.definitionScope ?? { mode: 'all' },
    issuedAt: 1,
    expiresAt: 1 + DEVICE_CONNECTION_GRANT_MAX_TTL_MS,
    signature: 'verified-by-transport',
  };
}

function metadata(): ConversationMeta {
  return {
    conversationId: CONVERSATION_ID,
    title: 'Conversation',
    lastMessagePreview: 'hello',
    lastMessageTimestamp: 1,
    messageCount: 1,
    originNodeId: 'node-a',
    originClock: 1,
    definitionId: DEFINITION_ID,
    isUserInitiated: true,
  };
}

function runStatus(overrides: Partial<MemeLoopRunStatus> = {}): MemeLoopRunStatus {
  return {
    runId: 'run-1',
    conversationId: CONVERSATION_ID,
    definitionId: DEFINITION_ID,
    turnId: 'turn-1',
    requestPeerId: REMOTE_PEER_ID,
    requestId: 'request-1',
    payloadDigest: 'digest-1',
    state: 'running',
    acceptedAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function message(index: number, turnId = 'turn-1'): ChatMessage {
  return {
    messageId: `message-${index}`,
    turnId,
    conversationId: CONVERSATION_ID,
    originNodeId: 'node-a',
    originSequence: index,
    timestamp: index,
    lamportClock: index,
    // These RPC paging fixtures belong to an already-created user-root turn.
    // Non-root messages cannot use the user role because canonical user
    // messages require messageId === turnId.
    role: 'assistant',
    content: `message ${index}`,
    parts: [],
  };
}

function tombstone(turnId = 'turn-old'): ConversationTombstoneEvent {
  return {
    eventId: `tombstone-${turnId}`,
    conversationId: CONVERSATION_ID,
    originNodeId: 'node-a',
    originSequence: 10,
    lamportClock: 10,
    timestamp: 10,
    kind: 'tombstone',
    targetTurnId: turnId,
    reason: 'user-delete',
  };
}

function userEvent(turnId = 'turn-new'): ConversationMessageEvent {
  return {
    eventId: turnId,
    conversationId: CONVERSATION_ID,
    originNodeId: 'node-a',
    originSequence: 11,
    lamportClock: 11,
    timestamp: 11,
    kind: 'message',
    message: {
      messageId: turnId,
      turnId,
      role: 'user',
      content: 'retry',
      parts: [],
    },
  };
}

function storage(overrides: Partial<FullAgentStorage> = {}): AgentRuntimeRpcStorage {
  return {
    getConversationMeta: vi.fn().mockResolvedValue(metadata()),
    conversationReferencesAttachment: vi.fn().mockResolvedValue(true),
    getMessagePage: vi.fn().mockResolvedValue({
      reset: false,
      conversationId: CONVERSATION_ID,
      revision: 'revision-1',
      items: [],
      hasMoreBefore: false,
      hasMoreAfter: false,
    }),
    getFullContentMessagePage: vi.fn().mockResolvedValue({
      reset: false,
      conversationId: CONVERSATION_ID,
      revision: 'revision-1',
      items: [],
      hasMoreBefore: false,
      hasMoreAfter: false,
    }),
    getMessageIdentity: vi.fn().mockResolvedValue(null),
    readMessageDetailRange: vi.fn().mockResolvedValue({ found: false }),
    getMessageWindowAround: vi.fn().mockResolvedValue({
      reset: true,
      conversationId: CONVERSATION_ID,
      revision: 'revision-1',
    }),
    getConversationTimelinePage: vi.fn().mockResolvedValue({ reset: true, revision: 'revision-1' }),
    readAttachmentRange: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as AgentRuntimeRpcStorage;
}

function projections(overrides: Partial<AgentRuntimeRpcProjectionStore> = {}): AgentRuntimeRpcProjectionStore {
  return {
    listConversations: vi.fn().mockResolvedValue({ items: [], hasMoreBefore: false, hasMoreAfter: false }),
    listTurns: vi.fn().mockResolvedValue({
      items: [],
      hasMoreBefore: false,
      hasMoreAfter: false,
      budget: { bytes: 0, renderLines: 0, truncated: false },
    }),
    getTurnDetail: vi.fn(async request => ({
      turnId: request.turnId,
      items: [],
      hasMoreBefore: false,
      hasMoreAfter: false,
    })),
    ...overrides,
  };
}

function runtime(overrides: Partial<MemeLoopRuntime> = {}): AgentRuntimeDeviceRpcHandlerOptions['runtime'] {
  return {
    createAgent: vi.fn().mockResolvedValue({ conversationId: CONVERSATION_ID }),
    sendMessage: vi.fn().mockResolvedValue({
      runId: 'run-1',
      requestId: 'request-1',
      turnId: 'turn-1',
      conversationId: CONVERSATION_ID,
      state: 'accepted',
    }),
    getRunStatus: vi.fn().mockResolvedValue(undefined),
    cancelRun: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

function createTrustedHandler(
  options: Omit<AgentRuntimeDeviceRpcHandlerOptions, 'trustedLocalOnly' | 'projections' | 'scheduledTaskHandler'> & {
    projections?: AgentRuntimeRpcProjectionStore;
    scheduledTaskHandler?: AgentRuntimeDeviceRpcHandlerOptions['scheduledTaskHandler'];
  },
) {
  return createAgentRuntimeDeviceRpcHandler({
    ...options,
    projections: options.projections ?? projections(),
    scheduledTaskHandler: options.scheduledTaskHandler ?? vi.fn(),
    trustedLocalOnly: true,
  });
}

describe('agent runtime RPC handler', () => {
  it('returns a durable run handle immediately and binds the request to the authenticated peer', async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      runId: 'run-1',
      requestId: 'request-1',
      turnId: 'turn-1',
      conversationId: CONVERSATION_ID,
      state: 'accepted',
    });
    const handler = createTrustedHandler({
      runtime: runtime({ sendMessage }),
      storage: storage(),
    });

    await expect(handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.send,
      parameters: {
        requestId: 'request-1',
        turnId: 'turn-1',
        conversationId: CONVERSATION_ID,
        definitionId: DEFINITION_ID,
        message: 'hello',
      },
    })).resolves.toEqual({
      ok: true,
      runId: 'run-1',
      requestId: 'request-1',
      turnId: 'turn-1',
      conversationId: CONVERSATION_ID,
      state: 'accepted',
    });
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      requestPeerId: REMOTE_PEER_ID,
      requestId: 'request-1',
      turnId: 'turn-1',
    }));
  });

  it('rejects a valid-shaped runtime response that belongs to another request', async () => {
    const handler = createTrustedHandler({
      runtime: runtime({
        sendMessage: vi.fn().mockResolvedValue({
          runId: 'run-1',
          requestId: 'another-request',
          turnId: 'turn-1',
          conversationId: CONVERSATION_ID,
          state: 'accepted',
        }),
      }),
      storage: storage(),
    });

    await expect(handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.send,
      parameters: {
        requestId: 'request-1',
        turnId: 'turn-1',
        conversationId: CONVERSATION_ID,
        definitionId: DEFINITION_ID,
        message: 'hello',
      },
    })).rejects.toThrow('response.requestId');
  });

  it('passes committed attachments to the local causal event allocator unchanged', async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      runId: 'run-1',
      requestId: 'request-1',
      turnId: 'turn-1',
      conversationId: CONVERSATION_ID,
      state: 'accepted',
    });
    const reference = {
      contentHash: `sha256:${'a'.repeat(64)}`,
      filename: 'context.txt',
      mimeType: 'text/plain',
      size: 5,
    };
    const handler = createTrustedHandler({ runtime: runtime({ sendMessage }), storage: storage() });

    await handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.send,
      parameters: {
        requestId: 'request-1',
        turnId: 'turn-1',
        conversationId: CONVERSATION_ID,
        message: 'hello',
        userMessage: { content: 'hello', parts: [], attachments: [reference] },
      },
    });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      requestPeerId: REMOTE_PEER_ID,
      userMessage: { content: 'hello', parts: [], attachments: [reference] },
    }));
  });

  it('opens the caller-selected conversation before accepting a remote runTurn', async () => {
    const createAgent = vi.fn().mockResolvedValue({ conversationId: CONVERSATION_ID });
    const sendMessage = vi.fn().mockResolvedValue({
      runId: 'run-1',
      requestId: 'request-1',
      turnId: 'turn-1',
      conversationId: CONVERSATION_ID,
      state: 'accepted',
    });
    const handler = createTrustedHandler({
      runtime: runtime({ createAgent, sendMessage }),
      storage: storage(),
    });

    await handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.runTurn,
      parameters: {
        requestId: 'request-1',
        turnId: 'turn-1',
        conversationId: CONVERSATION_ID,
        definitionId: DEFINITION_ID,
        message: 'hello',
      },
    });

    expect(createAgent).toHaveBeenCalledWith({
      definitionId: DEFINITION_ID,
      conversationId: CONVERSATION_ID,
    });
    expect(createAgent.mock.invocationCallOrder[0]).toBeLessThan(sendMessage.mock.invocationCallOrder[0] ?? 0);
  });

  it('loads run status durably and rejects status/cancel access from another peer', async () => {
    let current = runStatus();
    const getRunStatus = vi.fn(async () => current);
    const cancelRun = vi.fn(async () => {
      current = runStatus({ state: 'cancelled', updatedAt: 3, finishedAt: 3 });
      return true;
    });
    const handler = createTrustedHandler({
      runtime: runtime({ getRunStatus, cancelRun }),
      storage: storage(),
    });

    await expect(handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.getRunStatus,
      parameters: { runId: 'run-1' },
    })).resolves.toMatchObject({ status: { runId: 'run-1', state: 'running' } });
    await expect(handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.cancel,
      parameters: { runId: 'run-1' },
    })).resolves.toMatchObject({ ok: true, status: { state: 'cancelled' } });
    await expect(handler({
      remotePeerId: 'peer-b',
      method: AGENT_DEVICE_RPC_METHODS.getRunStatus,
      parameters: { runId: 'run-1' },
    })).rejects.toThrow('rpc_resource_not_found');
  });

  it('denies the claimed method before any runtime or storage lookup', async () => {
    const getRunStatus = vi.fn();
    const getConversationMeta = vi.fn();
    const handler = createAgentRuntimeDeviceRpcHandler({
      runtime: runtime({ getRunStatus }),
      storage: storage({ getConversationMeta }),
      projections: projections(),
      scheduledTaskHandler: vi.fn(),
    });

    await expect(handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.getRunStatus,
      parameters: { runId: 'secret-run' },
      presentedGrant: grant({ mode: 'none' }),
    })).rejects.toThrow(`rpc_permission_denied:${AGENT_DEVICE_RPC_METHODS.getRunStatus}`);
    expect(getRunStatus).not.toHaveBeenCalled();
    expect(getConversationMeta).not.toHaveBeenCalled();
  });

  it('uses the same safe error for an unknown run and another peer run', async () => {
    const getRunStatus = vi.fn(async (runId: string) => runId === 'known-run' ? runStatus({ runId: 'known-run' }) : undefined);
    const handler = createTrustedHandler({ runtime: runtime({ getRunStatus }), storage: storage() });

    for (const [remotePeerId, runId] of [['peer-b', 'known-run'], [REMOTE_PEER_ID, 'unknown-run']] as const) {
      await expect(handler({
        remotePeerId,
        method: AGENT_DEVICE_RPC_METHODS.getRunStatus,
        parameters: { runId },
      })).rejects.toThrow('rpc_resource_not_found');
    }
  });

  it('appends a canonical tombstone instead of deleting storage rows', async () => {
    const event = tombstone();
    const appendLocalEvent = vi.fn().mockResolvedValue(event);
    const handler = createTrustedHandler({
      runtime: runtime(),
      storage: storage({ appendLocalEvent }),
      localNodeId: 'node-a',
    });

    await expect(handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.deleteTurn,
      parameters: {
        conversationId: CONVERSATION_ID,
        turnId: 'turn-old',
        requestId: 'delete-1',
        reason: 'user-delete',
      },
    })).resolves.toMatchObject({ ok: true, tombstone: event });
    expect(appendLocalEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'tombstone',
      eventId: `rpc:tombstone:${REMOTE_PEER_ID}:delete-1`,
      targetTurnId: 'turn-old',
    }));
  });

  it('delegates retry to one atomic store/runtime operation', async () => {
    const retryTurn = vi.fn().mockResolvedValue({
      handle: {
        runId: 'run-new',
        requestId: 'retry-1',
        turnId: 'turn-new',
        conversationId: CONVERSATION_ID,
        state: 'accepted',
      },
      tombstone: tombstone(),
      userEvent: userEvent(),
    });
    const handler = createTrustedHandler({
      runtime: runtime(),
      storage: storage(),
      retryTurn,
    });
    const parameters = {
      conversationId: CONVERSATION_ID,
      definitionId: DEFINITION_ID,
      turnId: 'turn-old',
      newTurnId: 'turn-new',
      requestId: 'retry-1',
    } as const;

    await expect(handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.retryTurn,
      parameters,
    })).resolves.toMatchObject({
      runId: 'run-new',
      turnId: 'turn-new',
      tombstone: { targetTurnId: 'turn-old' },
      userEvent: { message: { content: 'retry' } },
    });
    expect(retryTurn).toHaveBeenCalledWith(parameters, REMOTE_PEER_ID);
  });

  it('serves turn lists only through the required scalable projection', async () => {
    const listTurns = vi.fn().mockResolvedValue({
      items: [],
      hasMoreBefore: false,
      hasMoreAfter: false,
      budget: { bytes: 0, renderLines: 0, truncated: false },
    });
    const handler = createTrustedHandler({
      runtime: runtime(),
      storage: storage(),
      projections: projections({ listTurns }),
    });

    await expect(handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.listTurns,
      parameters: { conversationId: CONVERSATION_ID },
    })).resolves.toMatchObject({ items: [], hasMoreBefore: false, hasMoreAfter: false });
    expect(listTurns).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      byteBudget: 256 * 1024,
    }, {});
  });

  it('serves one atomic load-around read and scopes opaque continuation cursors', async () => {
    const focusMessage = message(1, 'turn-1');
    const trailingMessage = message(2, 'turn-1');
    const getMessageWindowAround = vi.fn().mockResolvedValue({
      reset: false,
      conversationId: CONVERSATION_ID,
      revision: 'revision-1',
      focus: {
        kind: 'message',
        messageId: focusMessage.messageId,
        turnId: 'turn-1',
      },
      recenterAnchor: { messageId: focusMessage.messageId, turnId: 'turn-1' },
      items: [focusMessage, trailingMessage].map(item => projectConversationMessageForList(item, 128 * 1024)),
      hasMoreBefore: true,
      hasMoreAfter: true,
      startCursor: messagePageCursor(focusMessage),
      endCursor: messagePageCursor(trailingMessage),
    });
    const getMessagePage = vi.fn().mockResolvedValue({
      reset: false,
      conversationId: CONVERSATION_ID,
      revision: 'revision-1',
      items: [],
      hasMoreBefore: false,
      hasMoreAfter: false,
    });
    const getConversationMeta = vi.fn(async (conversationId: string) => ({
      ...metadata(),
      conversationId,
    }));
    const handler = createTrustedHandler({
      runtime: runtime(),
      storage: storage({ getConversationMeta, getMessageWindowAround, getMessagePage }),
    });
    const result = await handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.loadAround,
      parameters: {
        conversationId: CONVERSATION_ID,
        focus: { kind: 'message', messageId: focusMessage.messageId, turnId: 'turn-1' },
        expectedRevision: 'revision-1',
        maxMessages: 2,
        maxBytes: 256 * 1024,
      },
    }) as { reset: false; previousCursor: string; nextCursor: string };
    expect(result).toMatchObject({
      reset: false,
      previousCursor: expect.any(String),
      nextCursor: expect.any(String),
    });
    expect(getMessageWindowAround).toHaveBeenCalledOnce();

    await expect(handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.getMessagePage,
      parameters: {
        conversationId: CONVERSATION_ID,
        cursor: result.nextCursor,
        direction: 'forward',
        expectedRevision: 'revision-1',
      },
    })).resolves.toMatchObject({ reset: false, revision: 'revision-1' });
    expect(getMessagePage).toHaveBeenCalledOnce();

    for (
      const parameters of [
        {
          conversationId: CONVERSATION_ID,
          cursor: result.nextCursor,
          direction: 'forward' as const,
          expectedRevision: 'revision-2',
        },
        {
          conversationId: 'another-conversation',
          cursor: result.nextCursor,
          direction: 'forward' as const,
          expectedRevision: 'revision-1',
        },
        {
          conversationId: CONVERSATION_ID,
          cursor: result.nextCursor,
          direction: 'backward' as const,
          expectedRevision: 'revision-1',
        },
        {
          conversationId: CONVERSATION_ID,
          cursor: `${result.nextCursor.slice(0, -2)}AA`,
          direction: 'forward' as const,
          expectedRevision: 'revision-1',
        },
      ]
    ) {
      await expect(handler({
        remotePeerId: REMOTE_PEER_ID,
        method: AGENT_DEVICE_RPC_METHODS.getMessagePage,
        parameters,
      })).rejects.toThrow('invalid_rpc_params');
    }
    expect(getMessagePage).toHaveBeenCalledOnce();
  });

  it('propagates cancellation through projection queries and emits no late response', async () => {
    const controller = new AbortController();
    let completed = false;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const listTurns = vi.fn(async (
      _request: Parameters<AgentRuntimeRpcProjectionStore['listTurns']>[0],
      context: Parameters<AgentRuntimeRpcProjectionStore['listTurns']>[1],
    ) => {
      markStarted();
      await new Promise<void>((_resolve, reject) => {
        context.signal?.addEventListener('abort', () => {
          const reason = context.signal?.reason;
          reject(reason instanceof Error ? reason : new Error('aborted'));
        }, { once: true });
      });
      completed = true;
      return {
        items: [],
        hasMoreBefore: false,
        hasMoreAfter: false,
        budget: { bytes: 0, renderLines: 0, truncated: false },
      };
    });
    const handler = createTrustedHandler({
      runtime: runtime(),
      storage: storage(),
      projections: projections({ listTurns }),
    });
    const pending = handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.listTurns,
      parameters: { conversationId: CONVERSATION_ID },
      signal: controller.signal,
    });
    await started;
    controller.abort(new Error('cancelled-projection'));

    await expect(pending).rejects.toThrow('cancelled-projection');
    expect(completed).toBe(false);
    expect(listTurns.mock.calls[0]?.[1].signal).toBe(controller.signal);
  });

  it('pushes grant predicates into collection queries before pagination or payload reads', async () => {
    const allowedConversation = { ...metadata(), conversationId: 'conversation-allowed' };
    const listConversations = vi.fn(async (_request, context) => {
      expect(context).toMatchObject({
        allowedConversationIds: ['conversation-allowed'],
        allowedDefinitionIds: [DEFINITION_ID],
        scopeKey: expect.any(String),
      });
      return {
        items: [allowedConversation],
        hasMoreBefore: false,
        hasMoreAfter: false,
      };
    });
    const getAgentDefinitions = vi.fn(async context => {
      expect(context).toMatchObject({
        allowedDefinitionIds: [DEFINITION_ID],
        scopeKey: expect.any(String),
      });
      return [{
        id: DEFINITION_ID,
        name: 'Assistant',
        description: 'Allowed',
        systemPrompt: 'Be helpful.',
        tools: [],
        version: '1',
      }];
    });
    const presentedGrant = grant({ mode: 'all' }, {
      conversationScope: { mode: 'ids', ids: ['conversation-allowed'] },
      definitionScope: { mode: 'ids', ids: [DEFINITION_ID] },
    });
    const handler = createAgentRuntimeDeviceRpcHandler({
      runtime: runtime(),
      storage: storage(),
      projections: projections({ listConversations }),
      scheduledTaskHandler: vi.fn(),
      getAgentDefinitions,
    });

    await expect(handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.listConversations,
      parameters: { limit: 10 },
      presentedGrant,
    })).resolves.toMatchObject({ items: [allowedConversation] });
    await expect(handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.getDefinitions,
      parameters: {},
      presentedGrant,
    })).resolves.toMatchObject({ definitions: [{ id: DEFINITION_ID }] });
    expect(listConversations).toHaveBeenCalledOnce();
    expect(getAgentDefinitions).toHaveBeenCalledOnce();
  });

  it('does not query collections for a none resource scope and rejects adapter scope leaks', async () => {
    const listConversations = vi.fn();
    const getAgentDefinitions = vi.fn();
    const noneGrant = grant({ mode: 'all' }, {
      conversationScope: { mode: 'none' },
      definitionScope: { mode: 'none' },
    });
    const noQueryHandler = createAgentRuntimeDeviceRpcHandler({
      runtime: runtime(),
      storage: storage(),
      projections: projections({ listConversations }),
      scheduledTaskHandler: vi.fn(),
      getAgentDefinitions,
    });

    await expect(noQueryHandler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.listConversations,
      parameters: {},
      presentedGrant: noneGrant,
    })).resolves.toEqual({ items: [], hasMoreBefore: false, hasMoreAfter: false });
    await expect(noQueryHandler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.getDefinitions,
      parameters: {},
      presentedGrant: noneGrant,
    })).resolves.toEqual({ definitions: [] });
    expect(listConversations).not.toHaveBeenCalled();
    expect(getAgentDefinitions).not.toHaveBeenCalled();

    const leakingHandler = createAgentRuntimeDeviceRpcHandler({
      runtime: runtime(),
      storage: storage(),
      projections: projections({
        listConversations: vi.fn().mockResolvedValue({
          items: [{ ...metadata(), conversationId: 'conversation-forbidden' }],
          hasMoreBefore: false,
          hasMoreAfter: false,
        }),
      }),
      scheduledTaskHandler: vi.fn(),
    });
    await expect(leakingHandler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.listConversations,
      parameters: {},
      presentedGrant: grant({ mode: 'all' }, {
        conversationScope: { mode: 'ids', ids: ['conversation-allowed'] },
      }),
    })).rejects.toThrow('rpc_collection_scope_violation');
  });

  it('resolves the durable definition before every existing-conversation payload access', async () => {
    const getConversationMeta = vi.fn().mockResolvedValue({
      ...metadata(),
      definitionId: 'definition-forbidden',
    });
    const getMessagePage = vi.fn();
    const sendMessage = vi.fn();
    const retryTurn = vi.fn();
    const scheduledTaskHandler = vi.fn();
    const beginAttachmentUpload = vi.fn();
    const handler = createAgentRuntimeDeviceRpcHandler({
      runtime: runtime({ sendMessage }),
      storage: storage({ getConversationMeta, getMessagePage }),
      projections: projections(),
      retryTurn,
      scheduledTaskHandler,
      attachmentUploadStore: {
        beginAttachmentUpload,
        writeAttachmentUploadChunk: vi.fn(),
        commitAttachmentUpload: vi.fn(),
      },
    });
    const presentedGrant = grant({ mode: 'all' }, {
      conversationScope: { mode: 'all' },
      definitionScope: { mode: 'ids', ids: [DEFINITION_ID] },
    });
    const cases = [
      [AGENT_DEVICE_RPC_METHODS.getMessagePage, { conversationId: CONVERSATION_ID }],
      [AGENT_DEVICE_RPC_METHODS.send, {
        requestId: 'request-1',
        turnId: 'turn-1',
        conversationId: CONVERSATION_ID,
        message: 'hello',
      }],
      [AGENT_DEVICE_RPC_METHODS.retryTurn, {
        requestId: 'retry-1',
        turnId: 'turn-old',
        newTurnId: 'turn-new',
        conversationId: CONVERSATION_ID,
      }],
      [AGENT_DEVICE_RPC_METHODS.scheduleList, {
        agentInstanceId: CONVERSATION_ID,
        executionNodeId: 'node-1',
        maxBytes: SCHEDULED_TASK_RPC_LIMITS.listPageDefaultBytes,
      }],
      [AGENT_DEVICE_RPC_METHODS.beginAttachmentUpload, {
        requestId: 'upload-1',
        conversationId: CONVERSATION_ID,
        filename: 'note.txt',
        mimeType: 'text/plain',
        totalBytes: 1,
      }],
    ] as const;
    for (const [method, parameters] of cases) {
      await expect(handler({
        remotePeerId: REMOTE_PEER_ID,
        method,
        parameters,
        presentedGrant,
      })).rejects.toThrow(`rpc_permission_denied:${method}`);
    }
    expect(getConversationMeta).toHaveBeenCalledTimes(cases.length);
    expect(getMessagePage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(retryTurn).not.toHaveBeenCalled();
    expect(scheduledTaskHandler).not.toHaveBeenCalled();
    expect(beginAttachmentUpload).not.toHaveBeenCalled();
  });

  it('treats a claimed-definition mismatch and an unknown conversation alike', async () => {
    const createAgent = vi.fn();
    const getConversationMeta = vi.fn(async (conversationId: string) => conversationId === 'known' ? { ...metadata(), conversationId, definitionId: 'actual' } : null);
    const handler = createAgentRuntimeDeviceRpcHandler({
      runtime: runtime({ createAgent }),
      storage: storage({ getConversationMeta }),
      projections: projections(),
      scheduledTaskHandler: vi.fn(),
      trustedLocalOnly: true,
    });
    for (const conversationId of ['known', 'unknown']) {
      await expect(handler({
        remotePeerId: REMOTE_PEER_ID,
        method: AGENT_DEVICE_RPC_METHODS.send,
        parameters: {
          requestId: 'request-1',
          turnId: 'turn-1',
          conversationId,
          definitionId: 'claimed',
          message: 'hello',
        },
      })).rejects.toThrow('rpc_resource_not_found');
    }
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('pulls a bounded opaque-cursor run-log page without materializing the conversation', async () => {
    const messages = [message(1), message(2, 'another-turn'), message(3)];
    const page: ConversationFullContentMessagePage = {
      reset: false,
      conversationId: CONVERSATION_ID,
      revision: 'revision-1',
      items: messages,
      hasMoreBefore: false,
      hasMoreAfter: true,
      startCursor: {
        timestamp: 1,
        lamportClock: 1,
        originNodeId: 'node-a',
        messageId: 'message-1',
      },
      endCursor: {
        timestamp: 3,
        lamportClock: 3,
        originNodeId: 'node-a',
        messageId: 'message-3',
      },
    };
    const getFullContentMessagePage = vi.fn().mockResolvedValue(page);
    const handler = createTrustedHandler({
      runtime: runtime({ getRunStatus: vi.fn().mockResolvedValue(runStatus()) }),
      storage: storage({ getFullContentMessagePage }),
    });

    const result = await handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.pullAgentRunLog,
      parameters: {
        conversationId: CONVERSATION_ID,
        runId: 'run-1',
      },
    });

    expect(getFullContentMessagePage).toHaveBeenCalledWith(CONVERSATION_ID, {
      limit: 50,
      direction: 'forward',
      maxBytes: 256 * 1024,
    }, { signal: undefined });
    expect(result).toMatchObject({
      messages: [
        { messageId: 'message-1', content: 'message 1' },
        { messageId: 'message-3', content: 'message 3' },
      ],
      nextCursor: expect.any(String),
      hasMoreAfter: true,
      runStatus: { runId: 'run-1' },
    });
  });

  it('rejects malformed opaque cursors before reading a message page', async () => {
    const getMessagePage = vi.fn();
    const handler = createTrustedHandler({
      runtime: runtime({ getRunStatus: vi.fn().mockResolvedValue(runStatus()) }),
      storage: storage({ getMessagePage }),
    });

    await expect(handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.pullAgentRunLog,
      parameters: {
        conversationId: CONVERSATION_ID,
        runId: 'run-1',
        cursor: 'not-an-envelope',
      },
    })).rejects.toThrow('invalid_rpc_params');
    expect(getMessagePage).not.toHaveBeenCalled();
  });

  it('trims fifty large Unicode projections by UTF-8 bytes and continues without gaps', async () => {
    const messages = Array.from({ length: 50 }, (_, index) => ({
      ...message(index + 1),
      content: '界'.repeat(43_000),
    }));
    const getMessagePage = vi.fn(async (
      _conversationId: string,
      options: { after?: { messageId: string }; limit: number },
    ): Promise<ConversationMessagePage> => {
      const afterIndex = options.after
        ? messages.findIndex(item => item.messageId === options.after?.messageId) + 1
        : 0;
      // Simulate a conforming on-demand store: one bounded lazy projection,
      // never a raw multi-megabyte page that the RPC layer must rescue.
      const items = messages
        .slice(afterIndex, afterIndex + Math.min(options.limit, 1))
        .map(item => projectConversationMessageForList(item, 128 * 1024));
      return {
        reset: false,
        conversationId: CONVERSATION_ID,
        revision: 'revision-1',
        items,
        hasMoreBefore: afterIndex > 0,
        hasMoreAfter: afterIndex + items.length < messages.length,
        ...(items[0] ? { startCursor: messagePageCursor(items[0]) } : {}),
        ...(items.at(-1) ? { endCursor: messagePageCursor(items.at(-1)!) } : {}),
      };
    });
    const handler = createTrustedHandler({
      runtime: runtime(),
      storage: storage({
        getMessagePage,
        getMessageIdentity: vi.fn(async (_conversationId, id) => {
          const item = messages.find(message => message.messageId === id);
          return item ? messagePageCursor(item) : null;
        }),
      }),
    });
    const first = await handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.getMessagePage,
      parameters: {
        conversationId: CONVERSATION_ID,
        direction: 'forward',
        limit: 50,
        maxBytes: 64 * 1024,
      },
    }) as { items: ConversationMessageListProjection[]; nextCursor?: string; hasMoreAfter: boolean };

    expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.items.length).toBeLessThan(50);
    expect(first.items[0]?.metadata).toMatchObject({
      displayTruncation: { truncated: true, capability: 'detail' },
    });
    expect(first.hasMoreAfter).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.getMessagePage,
      parameters: {
        conversationId: CONVERSATION_ID,
        direction: 'forward',
        limit: 50,
        maxBytes: 64 * 1024,
        cursor: first.nextCursor,
        expectedRevision: 'revision-1',
      },
    }) as { items: ConversationMessageListProjection[] };
    const firstLast = Number(first.items.at(-1)!.messageId.split('-')[1]);
    const secondFirst = Number(second.items[0].messageId.split('-')[1]);
    expect(secondFirst).toBe(firstLast + 1);
    expect(new Set([...first.items, ...second.items].map(item => item.messageId)).size)
      .toBe(first.items.length + second.items.length);
    expect(getMessagePage).toHaveBeenLastCalledWith(
      CONVERSATION_ID,
      expect.objectContaining({
        maxBytes: 256 * 1024,
        after: expect.objectContaining({ messageId: first.items.at(-1)!.messageId }),
      }),
      { signal: undefined },
    );
  });

  it('returns an oversized single message as a lazy projection while preserving detail reads', async () => {
    const large = { ...message(1), content: '🌍'.repeat(80_000) };
    const lazyLarge = projectConversationMessageForList(large, 128 * 1024);
    const handler = createTrustedHandler({
      runtime: runtime(),
      storage: storage({
        getMessagePage: vi.fn().mockResolvedValue({
          reset: false,
          conversationId: CONVERSATION_ID,
          revision: 'revision-1',
          items: [lazyLarge],
          hasMoreBefore: false,
          hasMoreAfter: false,
          startCursor: messagePageCursor(lazyLarge),
          endCursor: messagePageCursor(lazyLarge),
        }),
        readMessageDetailRange: vi.fn(async (_conversationId: string, _messageId: string, offset: number, maxBytes: number) => {
          const bytes = canonicalJsonBytes(large);
          return {
            found: true as const,
            offset,
            totalBytes: bytes.byteLength,
            bytes: bytes.subarray(offset, Math.min(bytes.byteLength, offset + maxBytes)),
          };
        }),
      }),
    });

    const page = await handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.getMessagePage,
      parameters: { conversationId: CONVERSATION_ID, maxBytes: 64 * 1024 },
    }) as { items: ConversationMessageListProjection[] };
    const detail = await handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.getMessageDetail,
      parameters: { conversationId: CONVERSATION_ID, messageId: large.messageId },
    }) as { found: boolean; totalBytes: number };

    expect(page.items).toHaveLength(1);
    expect(page.items[0].metadata).toMatchObject({
      displayTruncation: { truncated: true, capability: 'detail' },
    });
    expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(detail).toMatchObject({ found: true });
    expect(detail.totalBytes).toBeGreaterThan(new TextEncoder().encode(JSON.stringify(page.items[0])).byteLength);
  });

  it('uses the storage ownership index before reading attachment metadata or bytes', async () => {
    const getAttachment = vi.fn();
    const readAttachmentRange = vi.fn();
    const conversationReferencesAttachment = vi.fn().mockResolvedValue(false);
    const handler = createTrustedHandler({
      runtime: runtime(),
      storage: storage({ conversationReferencesAttachment, getAttachment, readAttachmentRange }),
    });

    await expect(handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.getAttachmentChunk,
      parameters: { conversationId: CONVERSATION_ID, contentHash: 'sha256:secret' },
    })).rejects.toThrow('rpc_resource_not_found');
    expect(conversationReferencesAttachment).toHaveBeenCalledWith(
      CONVERSATION_ID,
      'sha256:secret',
      { signal: undefined },
    );
    expect(getAttachment).not.toHaveBeenCalled();
    expect(readAttachmentRange).not.toHaveBeenCalled();
  });

  it('reads attachment chunks by bounded range and never materializes the complete blob', async () => {
    const readAttachmentData = vi.fn().mockRejectedValue(new Error('must not full-read'));
    const readAttachmentRange = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    const handler = createTrustedHandler({
      runtime: runtime(),
      storage: storage({
        getAttachment: vi.fn().mockResolvedValue({
          contentHash: `sha256:${'a'.repeat(64)}`,
          filename: 'large.bin',
          mimeType: 'application/octet-stream',
          size: 64 * 1024 * 1024,
        }),
        readAttachmentData,
        readAttachmentRange,
      }),
    });

    await expect(handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.getAttachmentChunk,
      parameters: {
        conversationId: CONVERSATION_ID,
        contentHash: `sha256:${'a'.repeat(64)}`,
        offset: 10,
      },
    })).resolves.toMatchObject({ found: true, offset: 10, nextOffset: 13 });
    expect(readAttachmentRange).toHaveBeenCalledWith(
      `sha256:${'a'.repeat(64)}`,
      10,
      3 * 1024 * 1024,
      { signal: undefined },
    );
    expect(readAttachmentData).not.toHaveBeenCalled();
  });

  it('routes upload begin through the conversation-scoped durable upload store', async () => {
    const beginAttachmentUpload = vi.fn().mockResolvedValue({
      ok: true,
      requestId: 'upload-request-1',
      conversationId: CONVERSATION_ID,
      uploadId: 'upload-1',
      totalBytes: 10,
      maxChunkBytes: 1024,
    });
    const handler = createTrustedHandler({
      runtime: runtime(),
      storage: storage(),
      attachmentUploadStore: {
        beginAttachmentUpload,
        writeAttachmentUploadChunk: vi.fn(),
        commitAttachmentUpload: vi.fn(),
      },
    });
    const parameters = {
      requestId: 'upload-request-1',
      conversationId: CONVERSATION_ID,
      filename: 'note.txt',
      mimeType: 'text/plain',
      totalBytes: 10,
    };

    await expect(handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.beginAttachmentUpload,
      parameters,
    })).resolves.toMatchObject({ uploadId: 'upload-1' });
    expect(beginAttachmentUpload).toHaveBeenCalledWith(parameters, { ownerPeerId: REMOTE_PEER_ID });

    beginAttachmentUpload.mockResolvedValueOnce({
      ok: true,
      requestId: 'another-request',
      conversationId: CONVERSATION_ID,
      uploadId: 'upload-2',
      totalBytes: 10,
      maxChunkBytes: 1024,
    });
    await expect(handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.beginAttachmentUpload,
      parameters,
    })).rejects.toMatchObject({ field: 'response' });
  });

  it('strictly decodes and verifies an upload chunk once before writing its bytes', async () => {
    const writeAttachmentUploadChunk = vi.fn().mockResolvedValue({
      ok: true,
      requestId: 'chunk-request-1',
      conversationId: CONVERSATION_ID,
      uploadId: 'upload-1',
      offset: 4,
      byteLength: 3,
    });
    const handler = createTrustedHandler({
      runtime: runtime(),
      storage: storage(),
      attachmentUploadStore: {
        beginAttachmentUpload: vi.fn(),
        writeAttachmentUploadChunk,
        commitAttachmentUpload: vi.fn(),
      },
    });
    const parameters = {
      requestId: 'chunk-request-1',
      conversationId: CONVERSATION_ID,
      uploadId: 'upload-1',
      offset: 4,
      byteLength: 3,
      encoding: 'base64' as const,
      data: 'AQID',
      sha256: 'sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
    };

    await expect(handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.uploadAttachmentChunk,
      parameters,
    })).resolves.toMatchObject({ ok: true, byteLength: 3 });
    expect(writeAttachmentUploadChunk).toHaveBeenCalledWith({
      requestId: parameters.requestId,
      conversationId: parameters.conversationId,
      uploadId: parameters.uploadId,
      offset: parameters.offset,
      byteLength: parameters.byteLength,
      sha256: parameters.sha256,
      data: new Uint8Array([1, 2, 3]),
    }, { ownerPeerId: REMOTE_PEER_ID });

    writeAttachmentUploadChunk.mockClear();
    await expect(handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.uploadAttachmentChunk,
      parameters: {
        ...parameters,
        requestId: 'chunk-request-2',
        sha256: `sha256:${'0'.repeat(64)}`,
      },
    })).rejects.toThrow('request.sha256');
    expect(writeAttachmentUploadChunk).not.toHaveBeenCalled();
  });

  it('uses the already-validated scheduled dispatcher exactly once', async () => {
    const rawHandler = vi.fn(async () => {
      throw new Error('raw_schedule_boundary_must_not_run');
    });
    const dispatchValidatedRequest = vi.fn(async () => ({
      items: [],
      hasMoreAfter: false,
    }));
    const scheduledTaskHandler = Object.assign(rawHandler, { dispatchValidatedRequest });
    const handler = createTrustedHandler({
      runtime: runtime(),
      storage: storage(),
      scheduledTaskHandler,
    });
    const parameters = {
      agentInstanceId: CONVERSATION_ID,
      executionNodeId: 'node-1',
      maxBytes: SCHEDULED_TASK_RPC_LIMITS.listPageDefaultBytes,
    };

    await expect(handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.scheduleList,
      parameters,
    })).resolves.toEqual({ items: [], hasMoreAfter: false });
    expect(rawHandler).not.toHaveBeenCalled();
    expect(dispatchValidatedRequest).toHaveBeenCalledOnce();
    expect(dispatchValidatedRequest).toHaveBeenCalledWith({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.scheduleList,
      parameters,
      resources: {
        conversationId: CONVERSATION_ID,
        executionNodeId: 'node-1',
      },
      signal: undefined,
    });
  });

  it('fails closed when neither a verified grant nor an explicit host authorizer exists', async () => {
    const sendMessage = vi.fn();
    const handler = createAgentRuntimeDeviceRpcHandler({
      runtime: runtime({ sendMessage }),
      storage: storage(),
      projections: projections(),
      scheduledTaskHandler: vi.fn(),
    });

    await expect(handler({
      remotePeerId: REMOTE_PEER_ID,
      method: AGENT_DEVICE_RPC_METHODS.send,
      parameters: {
        requestId: 'request-1',
        turnId: 'turn-1',
        conversationId: CONVERSATION_ID,
        definitionId: DEFINITION_ID,
        message: 'hello',
      },
    })).rejects.toThrow(`rpc_permission_denied:${AGENT_DEVICE_RPC_METHODS.send}`);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

function messagePageCursor(value: ChatMessage) {
  return {
    timestamp: value.timestamp,
    lamportClock: value.lamportClock,
    originNodeId: value.originNodeId,
    messageId: value.messageId,
  };
}
