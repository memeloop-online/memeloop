import { type AgentFrameworkContext, ChatSyncEngine, type ChatSyncPeer, createMemeLoopRuntime } from 'memeloop';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { SQLiteAgentStorage } from '../sqliteStorage.js';

it('accepts an edited branch through the durable runtime and synchronizes SQLite replicas over sockets after reopening', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'memeloop-branch-sync-'));
  const host = new SQLiteAgentStorage({ filename: join(directory, 'host.sqlite') });
  let replica = new SQLiteAgentStorage({ filename: join(directory, 'replica.sqlite') });
  const operations: Pick<ChatSyncPeer, 'exchangeVersionFrontierPage' | 'pullMissingEvents' | 'pushEvents'> = {
    exchangeVersionFrontierPage: async (offered, after, includeRemote, conversationIds) => {
      const remotePage = includeRemote ? await host.getEventVersionFrontierPage({ limit: 128, after, conversationIds }) : { items: [] };
      const known = await host.getEventVersionFrontiersForKeys(offered);
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
      const page = await host.getConversationEventPage(conversationId, { limit: 128, direction: 'forward', ranges, after });
      return { items: page.items, ...(page.hasMoreAfter ? { nextCursor: page.endCursor } : {}) };
    },
    pushEvents: async events => {
      await host.insertEventsIfAbsent(events);
    },
  };
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const { method, parameters } = JSON.parse(Buffer.concat(chunks).toString()) as { method: keyof typeof operations; parameters: unknown[] };
        const operation = operations[method] as (...arguments_: unknown[]) => Promise<unknown>;
        response.end(JSON.stringify({ result: await operation(...parameters.map(item => item === null ? undefined : item)) }));
      } catch (error) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: String(error) }));
      }
    })();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing socket address');
  const call = async (method: string, parameters: unknown[]) => {
    const response = await fetch(`http://127.0.0.1:${address.port}`, { method: 'POST', body: JSON.stringify({ method, parameters }) });
    const body = await response.json() as { result: unknown; error?: string };
    if (!response.ok) throw new Error(body.error);
    return body.result;
  };
  const peer: ChatSyncPeer = {
    nodeId: 'host',
    exchangeVersionFrontierPage: (...args) => call('exchangeVersionFrontierPage', args) as ReturnType<ChatSyncPeer['exchangeVersionFrontierPage']>,
    pullMissingEvents: (...args) => call('pullMissingEvents', args) as ReturnType<NonNullable<ChatSyncPeer['pullMissingEvents']>>,
    pushEvents: async events => {
      await call('pushEvents', [events]);
    },
  };
  try {
    await host.appendLocalEvent({
      kind: 'metadataPatch',
      eventId: 'metadata',
      conversationId: 'source',
      originNodeId: 'host',
      timestamp: 1,
      patch: { definitionId: 'definition', title: 'Original' },
    });
    for (const [index, text] of ['prefix', 'original'].entries()) {
      await host.appendLocalEvent({
        kind: 'message',
        eventId: text,
        conversationId: 'source',
        originNodeId: 'host',
        timestamp: index + 2,
        message: { messageId: text, turnId: text, role: 'user', content: text, parts: [{ type: 'text', text }] },
      });
    }
    await host.saveConversationEditDraft({ conversationId: 'source', messageId: 'original', expectedRevision: 0, text: 'local draft' });
    const source = await host.loadConversationEditSource('source', 'original');
    await host.forkConversation({
      conversationId: 'source',
      messageId: 'original',
      sourceRevision: source.sourceRevision,
      text: 'edited',
      requestId: 'fork-request',
      targetConversationId: 'branch',
      replacementMessageId: 'replacement',
    }, 'host');
    const context: AgentFrameworkContext = {
      storage: host,
      localNodeId: 'host',
      llmProvider: { name: 'test', chat: async () => '' },
      tools: { registerTool() {}, getTool: () => undefined, listTools: () => [] },
      syncAdapters: [],
      network: { async start() {}, async stop() {} },
      runAgentToolLoop: async function*() {
        yield { type: 'thinking', data: 'accepted' };
      },
    };
    const runtime = createMemeLoopRuntime(context, { runStateStore: host });
    const pending = (await host.getPendingConversationBranchReplacement('branch'))!;
    const input = {
      conversationId: 'branch',
      definitionId: 'definition',
      turnId: 'replacement',
      requestId: 'accept-edit',
      requestPeerId: 'phone',
      message: 'edited',
      userMessage: pending,
    };
    const handle = await runtime.sendMessage(input);
    await vi.waitFor(async () => {
      expect((await host.get(handle.runId))?.state).toBe('completed');
    });
    expect((await runtime.sendMessage(input)).runId).toBe(handle.runId);
    const sync = () => new ChatSyncEngine({ nodeId: 'replica', storage: replica, peers: () => [peer], failOnMessageSyncError: true }).syncOnce();
    expect((await sync()).complete).toBe(true);
    expect(await replica.getConversationBranches('source', ['original'])).toEqual(await host.getConversationBranches('source', ['original']));
    expect((await replica.getMessageById('branch', 'replacement'))?.content).toBe('edited');
    expect((await replica.loadConversationEditSource('source', 'original')).draft).toBeNull();
    replica.close();
    replica = new SQLiteAgentStorage({ filename: join(directory, 'replica.sqlite') });
    await host.appendLocalEvent({
      kind: 'message',
      eventId: 'continuation',
      conversationId: 'branch',
      originNodeId: 'host',
      timestamp: Date.now(),
      message: { messageId: 'continuation', turnId: 'replacement', role: 'assistant', content: 'continued', parts: [{ type: 'text', text: 'continued' }] },
    });
    await sync();
    await sync();
    expect((await replica.getMessageById('branch', 'continuation'))?.content).toBe('continued');
    expect((await replica.getConversationEventPage('branch', { limit: 128 })).items).toEqual((await host.getConversationEventPage('branch', { limit: 128 })).items);
    expect((await host.getMessageById('source', 'original'))?.content).toBe('original');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve =>
      server.close(() => {
        resolve();
      })
    );
    host.close();
    replica.close();
  }
});
