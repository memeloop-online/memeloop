import type { ScheduledTaskRpcStoreContext } from 'memeloop';
import { describe, expect, it } from 'vitest';

import { SQLiteAgentStorage } from '../sqliteStorage.js';

describe('SQLite scheduled task RPC adapters', () => {
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
