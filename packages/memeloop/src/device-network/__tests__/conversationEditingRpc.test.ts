import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestStorage, type TestStorage } from '../../__tests__/testStorage.js';
import {
  conversationBranchIdentity,
  type ConversationBranchState,
  type ConversationEditingPort,
  type ConversationForkRequest,
  copyConversationBranchPrefix,
  createConversationBranchReplacement,
  createConversationEditingAdapter,
} from '../../agent-management/conversationEditing.js';
import { PromptPreviewAuditSessionStore } from '../../agent-management/PromptPreviewAuditSessionStore.js';
import type { AgentModelConfig } from '../../agent/types.js';
import type { ConversationEvent, ConversationEventDraft } from '../../conversation/index.js';
import { ChatSyncEngine, type ChatSyncPeer } from '../../sync/chatSyncEngine.js';
import type { ConversationMeta } from '../../sync/protocol.js';
import { createAgentDeviceRpcClient } from '../agentDeviceRpcClient.js';
import type { AgentPromptInspectionHost, ConversationModelParametersHost } from '../agentInspectionRpc.js';
import { type AgentRuntimeRpcAuthorizationRequest, type AgentRuntimeRpcStorage, createAgentRuntimeDeviceRpcHandler } from '../agentRuntimeRpcHandler.js';

const closeServers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closeServers.splice(0).map(close => close()));
});

/** Real loopback sockets exercise JSON serialization independently for each client. */
async function serve(call: (body: unknown) => Promise<unknown>) {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const result = await call(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.end(JSON.stringify({ result }));
      } catch (error) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    })();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  closeServers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close(error => {
        if (error) reject(error);
        else resolve();
      })
    );
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test address');
  return async (body: unknown, signal?: AbortSignal): Promise<unknown> => {
    const response = await fetch(`http://127.0.0.1:${address.port}`, {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    });
    const envelope = await response.json() as { result?: unknown; error?: string };
    if (!response.ok) throw new Error(envelope.error);
    return envelope.result;
  };
}

function branchStates(storage: TestStorage, conversationId: string, messageIds: readonly string[]): ConversationBranchState[] {
  return messageIds.flatMap(messageId => {
    const source = storage.state.messages.find(message => message.conversationId === conversationId && message.messageId === messageId);
    if (!source || source.role !== 'user') return [];
    const identity = conversationBranchIdentity(source);
    const alternatives = storage.state.messages.filter(message => message.role === 'user')
      .sort((left, right) => left.timestamp - right.timestamp || left.messageId.localeCompare(right.messageId))
      .map(conversationBranchIdentity)
      .filter(candidate => candidate.rootConversationId === identity.rootConversationId && candidate.rootMessageId === identity.rootMessageId)
      .filter((candidate, index, all) => all.findIndex(other => other.variantMessageId === candidate.variantMessageId) === index)
      .map(candidate => ({ conversationId: candidate.variantConversationId, messageId: candidate.variantMessageId }));
    return alternatives.length < 2 ? [] : [{
      messageId,
      selected: alternatives.findIndex(candidate => candidate.conversationId === identity.variantConversationId && candidate.messageId === identity.variantMessageId),
      alternatives,
    }];
  });
}

async function fixture(options: {
  mainId?: string | null;
  authorize?: (request: AgentRuntimeRpcAuthorizationRequest) => Promise<boolean>;
  promptPreview?: AgentPromptInspectionHost;
  conversationModelParameters?: ConversationModelParametersHost;
} = {}) {
  const storage = eventStorage();
  await storage.appendLocalEvent({
    kind: 'metadataPatch',
    eventId: 'main-metadata',
    conversationId: 'main',
    originNodeId: 'host',
    timestamp: 1,
    patch: { definitionId: 'assistant', title: 'Configured main' },
  });
  for (
    const [index, [id, role, content, turnId]] of [
      ['u1', 'user', 'first', 'u1'],
      ['a1', 'assistant', 'answer', 'u1'],
      ['u2', 'user', 'original question', 'u2'],
      ['a2', 'assistant', 'original continuation', 'u2'],
    ].entries()
  ) {
    await storage.appendLocalEvent({
      kind: 'message',
      eventId: id,
      conversationId: 'main',
      originNodeId: 'host',
      timestamp: index + 2,
      message: { messageId: id, turnId, role: role as 'user' | 'assistant', content, parts: [{ type: 'text', text: content }] },
    });
  }
  // A more recently created unrelated conversation must never become main.
  await storage.appendLocalEvent({
    kind: 'metadataPatch',
    eventId: 'other-metadata',
    conversationId: 'other',
    originNodeId: 'host',
    timestamp: 500,
    patch: { definitionId: 'assistant', title: 'Unrelated latest' },
  });
  const drafts = new Map<string, { text: string | null; revision: number }>();
  const pending = new Map<string, ConversationForkRequest>();
  const source = (conversationId: string, messageId: string) => {
    const message = storage.state.messages.find(item => item.conversationId === conversationId && item.messageId === messageId);
    if (!message || message.role !== 'user') throw new Error('source_missing');
    return message;
  };
  const port: ConversationEditingPort = {
    loadConversationEditSource: async (conversationId, messageId) => {
      const message = source(conversationId, messageId);
      return { text: message.content, sourceRevision: message.messageId, draft: drafts.get(`${conversationId}:${messageId}`) ?? null };
    },
    saveConversationEditDraft: async input => {
      source(input.conversationId, input.messageId);
      const key = `${input.conversationId}:${input.messageId}`;
      if ((drafts.get(key)?.revision ?? 0) !== input.expectedRevision) throw new Error('conversation_draft_conflict');
      const revision = input.expectedRevision + 1;
      drafts.set(key, { text: input.text, revision });
      return revision;
    },
    forkConversation: async input => {
      const existing = pending.get(input.targetConversationId);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(input)) throw new Error('fork_conflict');
        return input.targetConversationId;
      }
      const original = source(input.conversationId, input.messageId);
      if (original.messageId !== input.sourceRevision) throw new Error('source_changed');
      const events: ConversationEventDraft[] = [{
        kind: 'metadataPatch',
        eventId: `${input.requestId}:metadata`,
        conversationId: input.targetConversationId,
        originNodeId: 'host',
        timestamp: 20,
        patch: { definitionId: 'assistant', title: 'Branch' },
      }];
      await copyConversationBranchPrefix({
        sourceConversationId: input.conversationId,
        targetConversationId: input.targetConversationId,
        originNodeId: 'host',
        messages: (async function*() {
          yield* storage.state.messages.filter(item => item.conversationId === input.conversationId && item.timestamp < original.timestamp);
        })(),
        createId: id => `${input.requestId}:${id}`,
        append: async draft => {
          events.push(draft);
        },
      });
      await storage.appendLocalEventsAtomic(events);
      pending.set(input.targetConversationId, input);
      return input.targetConversationId;
    },
    getPendingConversationBranchReplacement: async conversationId => {
      const request = pending.get(conversationId);
      return request ? createConversationBranchReplacement(source(request.conversationId, request.messageId), request) : null;
    },
    getConversationBranches: async (conversationId, messageIds) => branchStates(storage, conversationId, messageIds),
  };
  let mainId = options.mainId === undefined ? 'main' : options.mainId;
  const handler = createAgentRuntimeDeviceRpcHandler({
    storage: storage as AgentRuntimeRpcStorage,
    conversationEditing: port,
    promptPreview: options.promptPreview,
    conversationModelParameters: options.conversationModelParameters,
    getMainConversationId: async () => mainId,
    setMainConversationId: async id => {
      mainId = id;
    },
    authorize: options.authorize ?? (async () => true),
    scheduledTaskHandler: vi.fn(),
    runtime: {
      createAgent: vi.fn(),
      cancelRun: vi.fn(),
      getRunStatus: vi.fn(),
      sendMessage: async input => {
        const branch = pending.get(input.conversationId);
        if (!branch) throw new Error('missing pending branch');
        const original = source(branch.conversationId, branch.messageId);
        expect(input.userMessage).toEqual(createConversationBranchReplacement(original, branch));
        await storage.appendLocalEvent({
          kind: 'message',
          eventId: branch.replacementMessageId,
          conversationId: branch.targetConversationId,
          originNodeId: 'host',
          timestamp: 21,
          message: {
            messageId: branch.replacementMessageId,
            turnId: branch.replacementMessageId,
            role: 'user',
            content: branch.text,
            parts: [{ type: 'text', text: branch.text }],
            metadata: {
              memeloopBranch: {
                ...conversationBranchIdentity(original),
                variantConversationId: branch.targetConversationId,
                variantMessageId: branch.replacementMessageId,
              },
            },
          },
        });
        return {
          runId: 'run',
          requestId: input.requestId!,
          turnId: branch.replacementMessageId,
          conversationId: input.conversationId,
          state: 'accepted' as const,
        };
      },
    },
  });
  const transport = await serve(body => handler(body as Parameters<typeof handler>[0]));
  const client = (peer: string) =>
    createAgentDeviceRpcClient({
      peerId: 'host',
      sendRpc: (_peer, method, parameters, options) => transport({ remotePeerId: peer, method, parameters }, options?.signal),
    });
  return { storage, port, client };
}

describe('portable conversation editing over serialized transport', () => {
  it('transports one exact preview through scoped pages/binary detail and saves only selected model parameters', async () => {
    let sequence = 0;
    const store = new PromptPreviewAuditSessionStore({
      createSessionId: () => `preview-${++sequence}`,
      createRevision: () => 'revision',
    });
    const scopes = new Map<string, string>();
    const cancel = vi.fn();
    const prepare = vi.fn(async (input: { conversationId: string }) => {
      const prepared = store.createSession({
        request: {
          providerId: 'provider',
          logicalModelId: 'model',
          wireModelId: 'wire',
          apiMode: 'responses',
          messages: [{ role: 'system', content: 'policy' }, { role: 'user', content: '历史问题 🚀' }],
        },
        provenance: [
          { source: 'prompt', promptPath: [{ id: 'policy', fieldPaths: ['prompts', 'policy'] }] },
          { source: 'conversation-message', messageId: 'u2' },
        ],
      });
      scopes.set(prepared.sessionId, input.conversationId);
      return prepared;
    });
    let selection: AgentModelConfig = { providerId: 'provider', modelId: 'model', parameters: { topP: 0.9, temperature: 0.5 } };
    const model = { id: 'model', name: 'Model', attachment: false, reasoning: true, toolCall: true, reasoningEfforts: ['low', 'high'] as const };
    const set = vi.fn(async (_conversationId: string, next: AgentModelConfig) => {
      selection = next;
      return { selection, model };
    });
    const { client } = await fixture({
      promptPreview: {
        prepare,
        getSessionConversationId: id => {
          const conversationId = scopes.get(id);
          if (!conversationId) throw new Error('session_missing');
          return conversationId;
        },
        getAuditPage: request => store.getPage(request),
        getAuditDetail: request => store.getDetail(request),
        release: request => {
          store.release(request);
        },
        cancel,
      },
      conversationModelParameters: { get: async () => ({ selection, model }), set },
    });
    const caller = client('phone');
    const execution = await caller.preparePromptPreviewExecutionModelRequest({ conversationId: 'main', requestId: 'preview-request' });
    expect(execution.initialPage.items[0].promptPath?.[0].fieldPaths).toEqual(['prompts', 'policy']);
    const pageRequest = {
      conversationId: 'main',
      sessionId: execution.sessionId,
      expectedRevision: execution.revision,
      mode: 'around' as const,
      entryIndex: 1,
      limit: 2,
      maxBytes: 4_096,
    };
    const page = await caller.getPromptPreviewAuditPage(pageRequest);
    const entry = page.items.find(item => item.entryIndex === 1)!;
    const chunk = await caller.getPromptPreviewAuditDetail({
      conversationId: 'main',
      sessionId: execution.sessionId,
      expectedRevision: execution.revision,
      target: { kind: 'entry', entryId: entry.entryId, entryIndex: entry.entryIndex },
      maxBytes: 4_096,
    });
    expect(chunk.canonicalUtf8).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(new TextDecoder().decode(chunk.canonicalUtf8))).toEqual({ role: 'user', content: '历史问题 🚀' });
    await expect(caller.getPromptPreviewAuditPage({ ...pageRequest, conversationId: 'other' })).rejects.toThrow('resource_not_found');
    expect(prepare).toHaveBeenCalledTimes(1);
    await caller.cancelPromptPreview({ conversationId: 'main', requestId: 'cancel-preview-request' });
    expect(cancel).toHaveBeenCalledWith({ conversationId: 'main', requestId: 'cancel-preview-request' });
    await caller.releasePromptPreviewAuditSession({
      conversationId: 'main',
      sessionId: execution.sessionId,
      expectedRevision: execution.revision,
    });
    await expect(caller.getPromptPreviewAuditPage(pageRequest)).rejects.toThrow();

    const current = await caller.getConversationModelParameters({ conversationId: 'main' });
    expect(current.model?.reasoningEfforts).toEqual(['low', 'high']);
    const changed = { ...current.selection, parameters: { ...current.selection.parameters, reasoningEffort: 'high' as const } };
    expect((await caller.setConversationModelParameters({ conversationId: 'main', selection: changed })).selection).toEqual(changed);
    expect((await client('another-window').getConversationModelParameters({ conversationId: 'main' })).selection.parameters?.topP).toBe(0.9);
    await expect(caller.setConversationModelParameters({
      conversationId: 'main',
      selection: { ...changed, modelId: 'different-model' },
    })).rejects.toThrow('selection_changed');
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('returns no arbitrary main and persists an explicit existing-conversation choice', async () => {
    const { client } = await fixture({ mainId: null });
    const chooser = client('phone');
    expect(await chooser.getMainConversation()).toEqual({ conversation: null });
    await expect(chooser.setMainConversation({ conversationId: 'missing' })).rejects.toThrow('resource_not_found');
    await chooser.setMainConversation({ conversationId: 'main' });
    expect((await client('reconnected').getMainConversation()).conversation?.conversationId).toBe('main');
  });

  it('authorizes the selected main and fork target before any durable change', async () => {
    const { client, storage } = await fixture({
      authorize: async request => request.conversationId !== 'other' && request.conversationId !== 'forbidden-branch',
    });
    const caller = client('limited');
    await expect(caller.setMainConversation({ conversationId: 'other' })).rejects.toThrow('permission_denied');
    expect((await caller.getMainConversation()).conversation?.conversationId).toBe('main');
    await expect(caller.forkConversation({
      conversationId: 'main',
      messageId: 'u2',
      sourceRevision: 'u2',
      text: 'edit',
      requestId: 'denied-fork',
      targetConversationId: 'forbidden-branch',
      replacementMessageId: 'denied-root',
    })).rejects.toThrow('permission_denied');
    expect(storage.state.events.some(event => event.conversationId === 'forbidden-branch')).toBe(false);
  });

  it('shares drafts, CAS conflicts, accepted branches and configured main across two clients and reconnect', async () => {
    const { storage, client } = await fixture();
    const first = client('phone');
    const second = client('desktop');
    expect((await first.getMainConversation()).conversation?.conversationId).toBe('main');
    await second.setMainConversation({ conversationId: 'other' });
    expect((await first.getMainConversation()).conversation?.conversationId).toBe('other');
    await first.setMainConversation({ conversationId: 'main' });
    const { source } = await first.loadConversationEditSource({ conversationId: 'main', messageId: 'u2' });
    expect(source.text).toBe('original question');
    expect(await first.saveConversationEditDraft({ conversationId: 'main', messageId: 'u2', text: 'edited', expectedRevision: 0 })).toEqual({ revision: 1 });
    expect((await second.loadConversationEditSource({ conversationId: 'main', messageId: 'u2' })).source.draft).toEqual({ text: 'edited', revision: 1 });
    await expect(second.saveConversationEditDraft({ conversationId: 'main', messageId: 'u2', text: 'stale', expectedRevision: 0 })).rejects.toThrow('conflict');
    const fork = {
      conversationId: 'main',
      messageId: 'u2',
      sourceRevision: source.sourceRevision,
      text: 'edited',
      requestId: 'fork-1',
      targetConversationId: 'branch',
      replacementMessageId: 'replacement',
    };
    await first.forkConversation(fork);
    await second.forkConversation(fork);
    expect((await second.getConversationBranches({ conversationId: 'main', messageIds: ['u2'] })).branches).toEqual([]);
    await second.send({ requestId: 'send-edit', turnId: 'replacement', conversationId: 'branch', message: 'edited' });
    const reconnected = client('phone-reconnected');
    const branches = (await reconnected.getConversationBranches({ conversationId: 'main', messageIds: ['u2'] })).branches;
    expect(branches[0]?.alternatives).toEqual([
      { conversationId: 'main', messageId: 'u2' },
      { conversationId: 'branch', messageId: 'replacement' },
    ]);
    expect((await reconnected.loadConversationEditSource({ conversationId: 'branch', messageId: 'replacement' })).source.text).toBe('edited');
    expect(storage.state.messages.filter(item => item.conversationId === 'main').map(item => item.content))
      .toEqual(['first', 'answer', 'original question', 'original continuation']);
    expect(storage.state.messages.filter(item => item.conversationId === 'branch').map(item => item.content))
      .toEqual(['first', 'answer', 'edited']);
  });

  it('replicates canonical fork events to an independent peer store, then converges after reconnect', async () => {
    const { storage: host, client } = await fixture();
    const remote = client('phone');
    const fork = {
      conversationId: 'main',
      messageId: 'u2',
      sourceRevision: 'u2',
      text: 'peer edit',
      requestId: 'peer-fork',
      targetConversationId: 'branch',
      replacementMessageId: 'replacement',
    };
    await remote.forkConversation(fork);
    await remote.send({ requestId: 'send-peer-edit', turnId: 'replacement', conversationId: 'branch', message: 'peer edit' });
    const replica = eventStorage();
    const peer = await syncPeer(host);
    const engine = new ChatSyncEngine({ nodeId: 'replica', storage: replica, peers: () => [peer], failOnMessageSyncError: true });
    expect((await engine.syncOnce()).complete).toBe(true);
    expect(replica.state.events).toEqual(expect.arrayContaining(host.state.events));
    expect(branchStates(replica, 'main', ['u2'])).toEqual(branchStates(host, 'main', ['u2']));
    expect(replica.state.messages.filter(item => item.conversationId === 'branch').map(item => item.content))
      .toEqual(['first', 'answer', 'peer edit']);

    await host.appendLocalEvent({
      kind: 'message',
      eventId: 'continued',
      conversationId: 'branch',
      originNodeId: 'host',
      timestamp: 22,
      message: { messageId: 'continued', turnId: 'replacement', role: 'assistant', content: 'continued edit', parts: [{ type: 'text', text: 'continued edit' }] },
    });
    // A new engine/client has no transient cursor state; durable frontiers catch it up.
    const reconnected = new ChatSyncEngine({ nodeId: 'replica', storage: replica, peers: () => [peer], failOnMessageSyncError: true });
    await reconnected.syncOnce();
    await reconnected.syncOnce();
    expect(replica.state.events).toHaveLength(host.state.events.length);
    expect(replica.state.messages.filter(item => item.conversationId === 'branch').at(-1)?.content).toBe('continued edit');
  });

  it('reuses the pending fork identity when accepting the replacement is interrupted', async () => {
    const { port } = await fixture();
    const fork = vi.spyOn(port, 'forkConversation');
    const accepted = vi.fn().mockRejectedValueOnce(new Error('disconnected')).mockResolvedValueOnce(undefined);
    let sequence = 0;
    const adapter = createConversationEditingAdapter({
      conversationId: 'main',
      port,
      branches: [],
      createId: () => `id-${++sequence}`,
      acceptBranch: accepted,
      switchBranch: vi.fn(),
    });
    await expect(adapter.submit('u2', 'edited', 'u2', 1)).rejects.toThrow('disconnected');
    await adapter.submit('u2', 'edited', 'u2', 1);
    expect(fork.mock.calls[1][0]).toEqual(fork.mock.calls[0][0]);
    expect(sequence).toBe(3);
  });
});

function eventStorage(): TestStorage {
  const storage = createTestStorage();
  storage.getConversationMeta = async id => {
    const value = storage.state.conversations.get(id);
    return value === undefined ? null : JSON.parse(JSON.stringify(value)) as ConversationMeta;
  };
  const originalFrontiers = storage.getEventVersionFrontierPage;
  storage.getEventVersionFrontierPage = async options => {
    const page = await originalFrontiers({ ...options, after: undefined, limit: 256 });
    const rows = page.items.sort((left, right) =>
      left.conversationId < right.conversationId ? -1 : left.conversationId > right.conversationId
        ? 1
        : left.originNodeId < right.originNodeId
        ? -1
        : left.originNodeId > right.originNodeId
        ? 1
        : 0
    ).filter(item =>
      !options.after || item.conversationId > options.after.conversationId ||
      item.conversationId === options.after.conversationId && item.originNodeId > options.after.originNodeId
    );
    return { items: rows.slice(0, options.limit) };
  };
  return storage;
}

async function syncPeer(storage: TestStorage): Promise<ChatSyncPeer> {
  const implementations: Pick<ChatSyncPeer, 'exchangeVersionFrontierPage' | 'pullMissingEvents' | 'pushEvents'> = {
    exchangeVersionFrontierPage: async (offered, after, includeRemote, conversationIds) => {
      const remotePage = includeRemote ? await storage.getEventVersionFrontierPage({ limit: 128, after, conversationIds }) : { items: [] };
      const known = await storage.getEventVersionFrontiersForKeys(offered);
      return {
        remotePage,
        missingForRemote: offered.flatMap(frontier => {
          const current = known.find(item => item.conversationId === frontier.conversationId && item.originNodeId === frontier.originNodeId)?.maxContiguousOriginSequence ?? 0;
          return current < frontier.maxContiguousOriginSequence
            ? [{ conversationId: frontier.conversationId, originNodeId: frontier.originNodeId, fromExclusive: current, toInclusive: frontier.maxContiguousOriginSequence }]
            : [];
        }),
      };
    },
    pullMissingEvents: async (conversationId, ranges, after) => {
      const page = await storage.getConversationEventPage(conversationId, { limit: 128, direction: 'forward', ranges, after });
      return { items: page.items, ...(page.hasMoreAfter ? { nextCursor: page.endCursor } : {}) };
    },
    pushEvents: async events => {
      await storage.insertEventsIfAbsent(events);
    },
  };
  const transport = await serve(async raw => {
    const { method, parameters } = raw as { method: keyof typeof implementations; parameters: unknown[] };
    const operation = implementations[method] as (...arguments_: unknown[]) => Promise<unknown>;
    return operation(...parameters.map(parameter => parameter === null ? undefined : parameter));
  });
  return {
    nodeId: 'host',
    exchangeVersionFrontierPage: (offered, after, includeRemote, ids) =>
      transport({ method: 'exchangeVersionFrontierPage', parameters: [offered, after ?? undefined, includeRemote, ids] }) as ReturnType<
        ChatSyncPeer['exchangeVersionFrontierPage']
      >,
    pullMissingEvents: (conversationId, ranges, after) =>
      transport({ method: 'pullMissingEvents', parameters: [conversationId, ranges, after] }) as ReturnType<NonNullable<ChatSyncPeer['pullMissingEvents']>>,
    pushEvents: async (events: ConversationEvent[]) => {
      await transport({ method: 'pushEvents', parameters: [events] });
    },
  };
}
