import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  assertAtomicAgentRetryStoreConformance,
  createAtomicAgentRetryReplacementPayload,
  createMemeLoopRuntime,
  digestAtomicAgentRetryPayload,
  messageToConversationEvent,
} from 'memeloop';
import type { AgentFrameworkContext, AgentRunRecord, AtomicAgentRetryInput, ChatMessage, ConversationMessagePayload, ConversationMeta } from 'memeloop';

import { SQLiteAgentStorage } from '../sqliteStorage.js';

const sourceMessage: ChatMessage = {
  messageId: 'source-turn',
  turnId: 'source-turn',
  conversationId: 'retry-conversation',
  originNodeId: 'source-node',
  originSequence: 1,
  timestamp: 10,
  lamportClock: 1,
  role: 'user',
  content: 'retry this exact payload',
  attachments: [{
    contentHash: `sha256:${'a'.repeat(64)}`,
    filename: 'retry.txt',
    mimeType: 'text/plain',
    size: 5,
  }],
  metadata: { durable: true },
};

const replacementPayload = createAtomicAgentRetryReplacementPayload(
  sourceMessage,
  'replacement-turn',
);

function retryDigest(input: {
  conversationId: string;
  definitionId: string;
  sourceTurnId: string;
  newTurnId: string;
  replacementPayload: ConversationMessagePayload;
}): Promise<string> {
  return digestAtomicAgentRetryPayload({
    conversationId: input.conversationId,
    definitionId: input.definitionId,
    sourceTurnId: input.sourceTurnId,
    newTurnId: input.newTurnId,
    replacementPayload: input.replacementPayload,
  });
}

async function freshInput(overrides: {
  runId?: string;
  requestId?: string;
  definitionId?: string;
  acceptedAt?: number;
  expectedSourceMessage?: ChatMessage;
  replacement?: ConversationMessagePayload;
} = {}): Promise<Extract<AtomicAgentRetryInput, { mode: 'fresh' }>> {
  const definitionId = overrides.definitionId ?? 'definition-1';
  const replacement = overrides.replacement ?? replacementPayload;
  const candidateRun: AgentRunRecord = {
    runId: overrides.runId ?? 'retry-run-1',
    conversationId: sourceMessage.conversationId,
    definitionId,
    turnId: replacement.messageId,
    requestPeerId: 'request-peer',
    requestId: overrides.requestId ?? 'retry-request-1',
    payloadDigest: await retryDigest({
      conversationId: sourceMessage.conversationId,
      definitionId,
      sourceTurnId: sourceMessage.turnId,
      newTurnId: replacement.messageId,
      replacementPayload: replacement,
    }),
    retrySourceTurnId: sourceMessage.turnId,
    state: 'accepted',
    acceptedAt: overrides.acceptedAt ?? 100,
    updatedAt: overrides.acceptedAt ?? 100,
  };
  return {
    mode: 'fresh',
    candidateRun,
    sourceTurnId: sourceMessage.turnId,
    expectedSourceMessage: overrides.expectedSourceMessage ?? sourceMessage,
    replacementPayload: replacement,
    originNodeId: 'local-node',
  };
}

function replayInput(
  input: Extract<AtomicAgentRetryInput, { mode: 'fresh' }>,
  candidateRun: AgentRunRecord = input.candidateRun,
): Extract<AtomicAgentRetryInput, { mode: 'replay' }> {
  return {
    mode: 'replay',
    candidateRun,
    sourceTurnId: input.sourceTurnId,
    replacementPayload: input.replacementPayload,
    originNodeId: input.originNodeId,
  };
}

async function storageWithSource(): Promise<SQLiteAgentStorage> {
  const storage = new SQLiteAgentStorage();
  const meta: ConversationMeta = {
    conversationId: sourceMessage.conversationId,
    title: 'Retry conversation',
    lastMessagePreview: sourceMessage.content,
    lastMessageTimestamp: sourceMessage.timestamp,
    messageCount: 0,
    originNodeId: sourceMessage.originNodeId,
    originClock: 0,
    definitionId: 'definition-1',
    isUserInitiated: true,
  };
  await storage.upsertConversationMetadata(meta);
  await storage.insertEventsIfAbsent([messageToConversationEvent(sourceMessage)]);
  return storage;
}

describe('SQLiteAgentStorage AtomicAgentRetryStore', () => {
  it('migrates an existing run table with the immutable retry source column', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'memeloop-atomic-retry-migration-'));
    const filename = join(directory, 'storage.db');
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE agent_runs (
        runId TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        definitionId TEXT NOT NULL,
        turnId TEXT NOT NULL,
        requestPeerId TEXT NOT NULL,
        requestId TEXT NOT NULL,
        payloadDigest TEXT NOT NULL,
        state TEXT NOT NULL,
        acceptedAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        startedAt INTEGER,
        finishedAt INTEGER,
        cancelRequestedAt INTEGER,
        error TEXT,
        UNIQUE(requestPeerId, requestId)
      );
    `);
    legacy.close();

    const storage = new SQLiteAgentStorage({ filename });
    const record: AgentRunRecord = {
      runId: 'migrated-run',
      conversationId: 'migrated-conversation',
      definitionId: 'definition-1',
      turnId: 'migrated-replacement',
      requestPeerId: 'request-peer',
      requestId: 'migrated-request',
      payloadDigest: 'migrated-digest',
      retrySourceTurnId: 'migrated-source',
      state: 'accepted',
      acceptedAt: 1,
      updatedAt: 1,
    };
    expect(await storage.createOrGet(record)).toEqual(record);
    expect(await storage.get('migrated-run')).toEqual(record);
    storage.close();
  });

  it('commits one physical retry transaction under concurrent fresh calls and replays it exactly', async () => {
    const storage = await storageWithSource();
    const firstInput = await freshInput();
    const competingInput = await freshInput({ runId: 'retry-run-competing', acceptedAt: 200 });

    const results = await Promise.all([
      storage.retryTurnAtomic(firstInput),
      storage.retryTurnAtomic(competingInput),
    ]);

    expect(results.filter(result => result.created)).toHaveLength(1);
    expect(new Set(results.map(result => result.run.runId))).toEqual(new Set(['retry-run-1']));
    expect(results[0]?.tombstone.eventId).toBe('tombstone:retry:retry-run-1');
    expect(results[0]?.userEvent.message).toEqual(replacementPayload);
    expect(await storage.getMessageById(sourceMessage.conversationId, sourceMessage.messageId))
      .toBeNull();
    expect(await storage.getMessageById(sourceMessage.conversationId, replacementPayload.messageId))
      .toMatchObject(replacementPayload);

    const replay = await storage.retryTurnAtomic(replayInput(firstInput, {
      ...firstInput.candidateRun,
      runId: 'new-candidate-on-replay',
      acceptedAt: 300,
      updatedAt: 300,
    }));
    expect(replay.created).toBe(false);
    expect(replay.run.runId).toBe('retry-run-1');
    expect(replay.tombstone).toEqual(results[0]?.tombstone);
    expect(replay.userEvent).toEqual(results[0]?.userEvent);
    storage.close();
  });

  it('passes the shared Core concurrent-fresh/replay/drift conformance contract', async () => {
    const storage = await storageWithSource();
    const input = await freshInput({
      requestId: 'shared-conformance-request',
      runId: 'shared-conformance-run',
    });

    await expect(assertAtomicAgentRetryStoreConformance(storage, input)).resolves.toMatchObject({
      created: true,
      run: { runId: 'shared-conformance-run' },
    });
    storage.close();
  });

  it('executes once across two runtime-local maps through the physical SQLite claim', async () => {
    const storage = await storageWithSource();
    let executions = 0;
    const runtimeContext = (): AgentFrameworkContext => ({
      storage,
      localNodeId: 'local-node',
      llmProvider: { name: 'test', chat: async () => '' },
      tools: {
        registerTool() {},
        getTool: () => undefined,
        listTools: () => [],
      },
      syncAdapters: [],
      network: { async start() {}, async stop() {} },
      runAgentToolLoop: async function*() {
        executions += 1;
        yield { type: 'thinking', data: 'executed' };
      },
    });
    const firstRuntime = createMemeLoopRuntime(runtimeContext(), { runStateStore: storage });
    const secondRuntime = createMemeLoopRuntime(runtimeContext(), { runStateStore: storage });
    const request = {
      conversationId: sourceMessage.conversationId,
      turnId: sourceMessage.turnId,
      newTurnId: replacementPayload.turnId,
      requestId: 'two-runtime-request',
      requestPeerId: 'request-peer',
      definitionId: 'definition-1',
    };

    const [first, second] = await Promise.all([
      firstRuntime.retryTurn(request),
      secondRuntime.retryTurn(request),
    ]);

    expect(second.handle.runId).toBe(first.handle.runId);
    await vi.waitFor(async () => {
      expect((await storage.get(first.handle.runId))?.state).toBe('completed');
    });
    expect(executions).toBe(1);
    storage.close();
  });

  it('rejects request, source, and replacement drift without partial writes', async () => {
    const storage = await storageWithSource();
    const input = await freshInput();
    await storage.retryTurnAtomic(input);

    const definitionId = 'definition-drift';
    const driftCandidate: AgentRunRecord = {
      ...input.candidateRun,
      runId: 'drift-run',
      definitionId,
      payloadDigest: await retryDigest({
        conversationId: input.candidateRun.conversationId,
        definitionId,
        sourceTurnId: input.sourceTurnId,
        newTurnId: input.candidateRun.turnId,
        replacementPayload: input.replacementPayload,
      }),
    };
    await expect(storage.retryTurnAtomic(replayInput(input, driftCandidate)))
      .rejects.toThrow('payload drift');

    const sourceDrift = await freshInput({
      runId: 'source-drift-run',
      requestId: 'source-drift-request',
      expectedSourceMessage: { ...sourceMessage, content: 'drifted source' },
    });
    await expect(storage.retryTurnAtomic(sourceDrift)).rejects.toThrow('source_drift');
    expect(await storage.getByRequest('request-peer', 'source-drift-request')).toBeUndefined();

    const replacementDrift = await freshInput({
      runId: 'replacement-drift-run',
      requestId: 'replacement-drift-request',
      replacement: { ...replacementPayload, content: 'drifted replacement' },
    });
    await expect(storage.retryTurnAtomic(replacementDrift))
      .rejects.toThrow('replacement_source_drift');
    expect(await storage.getByRequest('request-peer', 'replacement-drift-request')).toBeUndefined();
    storage.close();
  });

  it('rolls back run, tombstone, replacement, and projections when projection fails', async () => {
    const storage = await storageWithSource();
    const input = await freshInput({ requestId: 'rollback-request', runId: 'rollback-run' });
    const internals = storage as unknown as {
      db: Database.Database;
      refreshConversationProjectionV2(conversationId: string): void;
    };
    internals.refreshConversationProjectionV2 = () => {
      throw new Error('forced_projection_failure');
    };

    await expect(storage.retryTurnAtomic(input)).rejects.toThrow('forced_projection_failure');

    expect(await storage.getByRequest('request-peer', 'rollback-request')).toBeUndefined();
    expect(await storage.getMessageById(sourceMessage.conversationId, sourceMessage.messageId))
      .toMatchObject(sourceMessage);
    expect(await storage.getMessageById(sourceMessage.conversationId, replacementPayload.messageId))
      .toBeNull();
    expect(
      internals.db.prepare(`
      SELECT COUNT(*) AS count FROM conversation_turn_tombstones
      WHERE conversationId = ? AND turnId = ?
    `).get(sourceMessage.conversationId, sourceMessage.turnId),
    ).toEqual({ count: 0 });
    expect(
      internals.db.prepare(`
      SELECT COUNT(*) AS count FROM conversation_events
      WHERE eventId IN (?, ?)
    `).get('tombstone:retry:rollback-run', replacementPayload.messageId),
    ).toEqual({ count: 0 });
    storage.close();
  });
});
