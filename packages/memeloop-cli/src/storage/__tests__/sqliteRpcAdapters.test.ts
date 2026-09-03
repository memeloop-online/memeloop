import type { ConversationEvent, ScheduledTaskRpcStoreContext } from 'memeloop';
import { describe, expect, it } from 'vitest';

import { SQLiteAgentStorage } from '../sqliteStorage.js';

async function initialize(
  storage: SQLiteAgentStorage,
  conversationId: string,
  definitionId: string,
): Promise<void> {
  await storage.upsertConversationMetadata({
    conversationId,
    title: conversationId,
    lastMessagePreview: '',
    lastMessageTimestamp: 0,
    messageCount: 0,
    originNodeId: 'node-local',
    originClock: 0,
    definitionId,
    isUserInitiated: true,
  });
}

function turnEvents(conversationId: string, count: number): ConversationEvent[] {
  return Array.from({ length: count }, (_, index) => {
    const messageId = index === 0
      ? `${conversationId}-turn`
      : `${conversationId}-message-${index + 1}`;
    return {
      eventId: messageId,
      conversationId,
      originNodeId: 'node-source',
      originSequence: index + 1,
      lamportClock: index + 1,
      timestamp: index + 1,
      kind: 'message' as const,
      message: {
        messageId,
        turnId: `${conversationId}-turn`,
        role: index === 0 ? 'user' as const : 'assistant' as const,
        parts: [{ type: 'text', text: `message ${index + 1}` }],
        content: `message ${index + 1}`,
      },
    };
  });
}

describe('SQLite daemon RPC adapters', () => {
  it('applies collection grant filters before keyset paging and serializes exact message markers', async () => {
    const storage = new SQLiteAgentStorage();
    await initialize(storage, 'allowed', 'definition-allowed');
    await initialize(storage, 'denied-conversation', 'definition-allowed');
    await initialize(storage, 'denied-definition', 'definition-denied');
    await storage.insertEventsIfAbsent(turnEvents('allowed', 60));
    await storage.insertEventsIfAbsent(turnEvents('denied-conversation', 2));
    await storage.insertEventsIfAbsent(turnEvents('denied-definition', 2));
    const projections = storage.createAgentRuntimeRpcProjectionStore();

    const conversations = await projections.listConversations({ limit: 10 }, {
      allowedConversationIds: ['allowed', 'denied-definition'],
      allowedDefinitionIds: ['definition-allowed'],
      scopeKey: 'grant-scope',
    });
    expect(conversations.items.map(item => item.conversationId)).toEqual(['allowed']);

    const turns = await projections.listTurns({
      conversationId: 'allowed',
      limit: 10,
      byteBudget: 256 * 1024,
      renderLineBudget: 1_000,
    }, {});
    expect(turns.items).toHaveLength(10);
    expect(turns.items.every(item =>
      item.turnId === 'allowed-turn' &&
      item.responseCount === 1 &&
      item.detailState === 'summary' &&
      item.participantPreviews.length === 1
    )).toBe(true);
    expect(turns.items[0]?.participantPreviews[0]?.preview).toBe('message 51');
    expect(turns.items.at(-1)?.participantPreviews[0]?.preview).toBe('message 60');

    const newest = await projections.getTurnDetail({
      conversationId: 'allowed',
      turnId: 'allowed-turn',
      direction: 'backward',
      limit: 10,
      maxBytes: 256 * 1024,
    }, {});
    expect(newest.items).toHaveLength(10);
    expect(newest.items.every(item => item.turnId === 'allowed-turn')).toBe(true);
    expect(newest.hasMoreBefore).toBe(true);
    expect(newest.previousCursor).toBeDefined();

    const older = await projections.getTurnDetail({
      conversationId: 'allowed',
      turnId: 'allowed-turn',
      cursor: newest.previousCursor,
      direction: 'backward',
      limit: 10,
      maxBytes: 256 * 1024,
    }, {});
    expect(older.items).toHaveLength(10);
    expect(new Set([...older.items, ...newest.items].map(item => item.messageId)).size).toBe(20);
    storage.close();
  });

  it('persists scheduled tasks, enforces full identity, and CAS-fences execution updates', async () => {
    const storage = new SQLiteAgentStorage();
    const scheduled = storage.createScheduledTaskStore();
    const context: ScheduledTaskRpcStoreContext = {
      remotePeerId: 'peer-remote',
      localPeerId: 'peer-local',
    };
    const created = await scheduled.create({
      agentInstanceId: 'conversation-1',
      agentDefinitionId: 'definition-1',
      name: 'Every hour',
      schedule: { kind: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      payload: { message: 'scheduled message' },
      executionNodeId: 'peer-local',
      enabled: true,
    }, context);
    expect(created).toMatchObject({
      originNodeId: 'peer-remote',
      executionNodeId: 'peer-local',
      state: 'active',
      executionRevision: 0,
    });

    const page = await scheduled.list({
      agentInstanceId: 'conversation-1',
      executionNodeId: 'peer-local',
      states: ['active'],
      limit: 10,
      maxBytes: 256 * 1024,
    }, context);
    expect(page.items.map(item => item.id)).toEqual([created.id]);
    await expect(scheduled.get({
      taskId: created.id,
      agentInstanceId: 'wrong-conversation',
      agentDefinitionId: 'definition-1',
      executionNodeId: 'peer-local',
    }, context)).resolves.toBeUndefined();
    await expect(scheduled.get({
      taskId: created.id,
      agentInstanceId: created.agentInstanceId,
      agentDefinitionId: created.agentDefinitionId,
      executionNodeId: 'peer-other',
    }, context)).rejects.toThrow('scheduled_task_execution_target_mismatch');

    const identity = {
      taskId: created.id,
      agentInstanceId: created.agentInstanceId,
      agentDefinitionId: created.agentDefinitionId,
      executionNodeId: created.executionNodeId,
    };
    const scheduledFor = '2026-01-01T00:00:00.000Z';
    const accepted = await storage.updateExecution(identity, {
      nextRunAt: scheduledFor,
      occurrenceId: `scheduled:${'a'.repeat(64)}`,
      occurrenceScheduledFor: scheduledFor,
      occurrenceAttempt: 0,
      updatedAt: scheduledFor,
    }, { expectedExecutionRevision: 0 });
    expect(accepted?.executionRevision).toBe(1);
    await expect(storage.updateExecution(identity, {
      state: 'completed',
      updatedAt: scheduledFor,
    }, { expectedExecutionRevision: 0 })).resolves.toBeNull();
    storage.close();
  });
});
