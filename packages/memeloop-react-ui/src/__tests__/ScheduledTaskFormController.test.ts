import type { AgentDefinition, ScheduledTask, ScheduledTaskClient } from 'memeloop';
import { describe, expect, it, vi } from 'vitest';

import type { ScheduledTaskEditorLabels } from '../agent/scheduling/coreTypes.js';
import { ScheduledTaskFormController } from '../agent/scheduling/ScheduledTaskFormController.js';

const labels: ScheduledTaskEditorLabels = {
  title: '计划唤醒',
  description: '定期唤醒',
  disabled: '停用',
  enabled: '启用',
  executionTarget: '执行设备',
  timezone: '时区',
  message: '消息',
  activeHoursStart: '开始',
  activeHoursEnd: '结束',
  save: '保存',
  update: '更新',
  saving: '保存中',
  taskSelection: '选择计划',
  newTask: '新计划',
  scheduleTitle: 'Cron',
  executionTargetUnavailable: '设备不可用',
  preview: '预览',
  previewLoading: '正在预览',
  invalidCron: 'Cron 无效',
  invalidTimezone: '时区无效',
  noPreview: '没有执行时间',
  operationFailed: '计划任务操作失败',
  sourceIncomplete: '部分来源不可用',
  sourceOnline: target => `${target} 在线`,
  sourceOffline: target => `${target} 离线`,
  sourceDegraded: target => `${target} 降级`,
  sourceCached: target => `${target} 使用缓存`,
  defaultTaskName: agentName => `${agentName} 的计划`,
  defaultMessage: '检查待办事项',
};

const definition = { id: 'definition', name: '助手' } as AgentDefinition;
const targets = [{ id: 'local-a', label: '本机 A' }, { id: 'local-b', label: '本机 B' }, { id: 'remote', label: '远端' }];

function client(
  list: ScheduledTaskClient['listScheduledTasksForAgent'] = vi.fn().mockResolvedValue({ items: [], hasMoreAfter: false, partial: false, sources: [] }),
): ScheduledTaskClient {
  return {
    listScheduledTasksForAgent: list,
    createScheduledTask: vi.fn().mockImplementation(async input => ({ id: 'task', ...input } as ScheduledTask)),
    updateScheduledTask: vi.fn().mockImplementation(async (_id, input) => ({ id: 'task', ...input } as ScheduledTask)),
    deleteScheduledTask: vi.fn().mockResolvedValue(undefined),
    getCronPreviewDates: vi.fn().mockResolvedValue(['2026-08-25T01:00:00.000Z']),
  };
}

function configuration(taskClient: ScheduledTaskClient, localNodeId = 'local-a') {
  return {
    agentDefinition: definition,
    agentInstanceId: 'agent-1',
    client: taskClient,
    executionTargets: targets,
    localNodeId,
    labels,
    previewDebounceMs: 0,
  };
}

function scheduledTask(id: string, executionNodeId = 'remote'): ScheduledTask {
  return {
    id,
    agentInstanceId: 'agent-1',
    agentDefinitionId: 'definition',
    name: id,
    schedule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
    enabled: true,
    state: 'active',
    executionNodeId,
    originNodeId: 'local-a',
  };
}

async function eventually(assertion: () => void): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  assertion();
}

describe('ScheduledTaskFormController', () => {
  it('keeps every task selectable and publishes deeply immutable page provenance', async () => {
    const scheduledTasks: ScheduledTask[] = ['local-a', 'remote'].map((executionNodeId, index) => ({
      id: `task-${index}`,
      agentInstanceId: 'agent-1',
      agentDefinitionId: 'definition',
      name: `Task ${index}`,
      schedule: { kind: 'cron', expression: `${index} 9 * * *`, timezone: 'UTC' },
      enabled: true,
      state: 'active',
      executionNodeId,
      executionNodeLabel: executionNodeId === 'remote' ? '远端设备' : '本机 A',
      originNodeId: 'local-a',
    }));
    const taskClient = client(
      vi.fn().mockResolvedValue({
        items: scheduledTasks,
        hasMoreAfter: false,
        partial: false,
        sources: [
          { executionNodeId: 'local-a', state: 'online', fromCache: false },
          { executionNodeId: 'remote', state: 'degraded', fromCache: true },
        ],
      }),
    );
    const controller = new ScheduledTaskFormController(configuration(taskClient));
    await eventually(() => {
      expect(controller.getSnapshot().tasks).toHaveLength(2);
    });
    controller.selectTask('task-1');
    const snapshot = controller.getSnapshot();
    expect(snapshot.selectedTaskId).toBe('task-1');
    expect(snapshot.value.executionNodeId).toBe('remote');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.value)).toBe(true);
    expect(Object.isFrozen(snapshot.tasks)).toBe(true);
    expect(Object.isFrozen(snapshot.tasks[1])).toBe(true);
    expect(Object.isFrozen(snapshot.pageStatus)).toBe(true);
    expect(Object.isFrozen(snapshot.pageStatus.sources)).toBe(true);
    expect(Object.isFrozen(snapshot.pageStatus.sources[1])).toBe(true);
    controller.dispose();
  });

  it('isolates listeners and caller configuration mutation from persistence', async () => {
    const taskClient = client();
    const mutableDefinition = { id: 'definition', name: 'Original Agent' } as AgentDefinition;
    const mutableTargets = [{ id: 'local-a', label: 'Original Device' }];
    const listenerError = vi.fn();
    const healthyListener = vi.fn();
    const controller = new ScheduledTaskFormController({
      ...configuration(taskClient),
      agentDefinition: mutableDefinition,
      executionTargets: mutableTargets,
      onListenerError: listenerError,
    });
    controller.subscribe(() => {
      throw new Error('listener failure');
    });
    controller.subscribe(healthyListener);
    mutableDefinition.name = 'Mutated Agent';
    mutableTargets[0].label = 'Mutated Device';
    await eventually(() => {
      expect(controller.getSnapshot().loading).toBe(false);
    });
    controller.setValue({ enabled: true });
    await eventually(() => {
      expect(controller.getSnapshot().preview.status).toBe('ready');
    });
    await controller.save();
    expect(taskClient.createScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Original Agent 的计划', executionNodeLabel: 'Original Device' }),
      { signal: expect.any(AbortSignal) },
    );
    expect(healthyListener).toHaveBeenCalled();
    expect(listenerError).toHaveBeenCalled();
    controller.dispose();
  });

  it('follows async local identity until a user explicitly selects a target', async () => {
    const taskClient = client();
    const controller = new ScheduledTaskFormController(configuration(taskClient));
    await eventually(() => {
      expect(controller.getSnapshot().loading).toBe(false);
    });
    controller.setConfiguration(configuration(taskClient, 'local-b'));
    expect(controller.getSnapshot().value.executionNodeId).toBe('local-b');
    controller.setValue({ executionNodeId: 'remote' }, { manualExecutionTarget: true });
    controller.setConfiguration(configuration(taskClient, 'local-a'));
    expect(controller.getSnapshot().value.executionNodeId).toBe('remote');
    controller.dispose();
  });

  it('uses only server preview dates and localized default persisted data', async () => {
    const taskClient = client();
    const controller = new ScheduledTaskFormController(configuration(taskClient));
    await eventually(() => {
      expect(controller.getSnapshot().loading).toBe(false);
    });
    controller.setValue({ enabled: true });
    await eventually(() => {
      expect(controller.getSnapshot().preview.status).toBe('ready');
    });
    expect(taskClient.getCronPreviewDates).toHaveBeenCalledWith('0 9 * * 1-5', expect.any(String), 3, { signal: expect.any(AbortSignal) });
    await controller.save();
    expect(taskClient.createScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '助手 的计划',
        payload: { message: '检查待办事项' },
      }),
      { signal: expect.any(AbortSignal) },
    );
    controller.dispose();
  });

  it('prevents an old agent load from overwriting a newer generation', async () => {
    let resolveOld: ((page: { items: ScheduledTask[]; hasMoreAfter: false; partial: false; sources: [] }) => void) | undefined;
    let oldSignal: AbortSignal | undefined;
    const oldClient = client(
      vi.fn().mockImplementation((_agentId, options) =>
        new Promise<{ items: ScheduledTask[]; hasMoreAfter: false; partial: false; sources: [] }>(resolve => {
          oldSignal = options?.signal;
          resolveOld = resolve;
        })
      ),
    );
    const nextClient = client();
    const controller = new ScheduledTaskFormController(configuration(oldClient));
    controller.setConfiguration({ ...configuration(nextClient, 'local-b'), agentInstanceId: 'agent-2' });
    expect(oldSignal?.aborted).toBe(true);
    await eventually(() => {
      expect(controller.getSnapshot().loading).toBe(false);
    });
    resolveOld?.({
      items: [{
        id: 'old-task',
        agentInstanceId: 'agent-1',
        agentDefinitionId: 'definition',
        name: 'old',
        schedule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
        enabled: true,
        state: 'active',
        executionNodeId: 'remote',
        originNodeId: 'local-a',
      }],
      hasMoreAfter: false,
      partial: false,
      sources: [],
    });
    await Promise.resolve();
    expect(controller.getSnapshot().existingTask).toBeUndefined();
    expect(controller.getSnapshot().value.executionNodeId).toBe('local-b');
    controller.dispose();
  });

  it('keeps partial provenance visible and refuses mutations based on an incomplete page', async () => {
    const createScheduledTask = vi.fn();
    const taskClient = {
      ...client(
        vi.fn().mockResolvedValue({
          items: [],
          hasMoreAfter: false,
          partial: true,
          sources: [
            { executionNodeId: 'remote', state: 'offline' as const, fromCache: true },
            { executionNodeId: 'local-a', state: 'degraded' as const, fromCache: false },
          ],
        }),
      ),
      createScheduledTask,
    };
    const controller = new ScheduledTaskFormController(configuration(taskClient));
    await eventually(() => {
      expect(controller.getSnapshot().loading).toBe(false);
    });
    expect(controller.getSnapshot().pageStatus).toEqual({
      partial: true,
      sources: [
        { executionNodeId: 'remote', state: 'offline', fromCache: true },
        { executionNodeId: 'local-a', state: 'degraded', fromCache: false },
      ],
    });
    controller.setValue({ enabled: true });
    await eventually(() => {
      expect(controller.getSnapshot().preview.status).toBe('ready');
    });
    await controller.save();
    expect(controller.getSnapshot().error).toBe('部分来源不可用');
    expect(createScheduledTask).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('continues bounded source pages so a task on the ninth device is visible', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({
        items: [],
        hasMoreAfter: true,
        nextCursor: 'source-page-2',
        partial: false,
        sources: Array.from({ length: 8 }, (_, index) => ({ executionNodeId: `node-${index}`, state: 'online' as const, fromCache: false })),
      })
      .mockResolvedValueOnce({
        items: [scheduledTask('task-on-ninth-device', 'node-8')],
        hasMoreAfter: false,
        partial: false,
        sources: [{ executionNodeId: 'node-8', state: 'online' as const, fromCache: false }],
      });
    const controller = new ScheduledTaskFormController(configuration(client(list)));
    await eventually(() => {
      expect(controller.getSnapshot().loading).toBe(false);
    });

    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1]?.[1]).toMatchObject({ cursor: 'source-page-2', limit: 64, signal: expect.any(AbortSignal) });
    expect(controller.getSnapshot().tasks.map(task => task.id)).toEqual(['task-on-ninth-device']);
    expect(controller.getSnapshot().pageStatus.sources).toHaveLength(9);
    expect(controller.getSnapshot().pageStatus.partial).toBe(false);
    controller.dispose();
  });

  it('keeps at most 64 tasks and fails closed when another page exceeds the resident bound', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({
        items: Array.from({ length: 63 }, (_, index) => scheduledTask(`task-${index}`)),
        hasMoreAfter: true,
        nextCursor: 'overflow-page',
        partial: false,
        sources: [],
      })
      .mockResolvedValueOnce({
        items: [scheduledTask('task-63'), scheduledTask('task-64')],
        hasMoreAfter: false,
        partial: false,
        sources: [],
      });
    const controller = new ScheduledTaskFormController(configuration(client(list)));
    await eventually(() => {
      expect(controller.getSnapshot().loading).toBe(false);
    });

    expect(controller.getSnapshot().tasks).toHaveLength(64);
    expect(controller.getSnapshot().pageStatus.partial).toBe(true);
    expect(list.mock.calls[1]?.[1]).toMatchObject({ cursor: 'overflow-page', limit: 1 });
    controller.dispose();
  });

  it('detects a repeated cursor and stops without an unbounded reload loop', async () => {
    const list = vi.fn().mockResolvedValue({
      items: [],
      hasMoreAfter: true,
      nextCursor: 'same-cursor',
      partial: false,
      sources: [],
    });
    const controller = new ScheduledTaskFormController(configuration(client(list)));
    await eventually(() => {
      expect(controller.getSnapshot().loading).toBe(false);
    });

    expect(list).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().pageStatus.partial).toBe(true);
    controller.dispose();
  });
});
