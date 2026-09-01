import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { CreateScheduledTaskInput, ScheduledTask } from '../../agent-management/types.js';
import {
  assertScheduledTaskRpcRequest,
  assertScheduledTaskRpcResponseCorrelation,
  bindScheduledTaskRpcClient,
  type CheckedScheduledTaskRpcCall,
  createScheduledTaskClientFromRpc,
  createScheduledTaskRpcClient,
  createScheduledTaskRpcHandler,
  parseScheduledTaskRpcGrantResources,
  parseScheduledTaskRpcResponse,
  SCHEDULED_TASK_RPC_DEFAULTS,
  SCHEDULED_TASK_RPC_LIMITS,
  SCHEDULED_TASK_RPC_METHODS,
  type ScheduledAgentTaskStore,
  type ScheduledTaskRpcCall,
  type ScheduledTaskRpcCallOptions,
  type ScheduledTaskRpcCreateInput,
  type ScheduledTaskRpcCreateRequest,
  type ScheduledTaskRpcCronPreviewRequest,
  type ScheduledTaskRpcDeleteRequest,
  type ScheduledTaskRpcDeleteResponse,
  type ScheduledTaskRpcGetRequest,
  type ScheduledTaskRpcListRequest,
  type ScheduledTaskRpcListResponse,
  type ScheduledTaskRpcUpdateRequest,
} from '../scheduledTaskRpc.js';

const createInput: ScheduledTaskRpcCreateInput = {
  agentInstanceId: 'conversation-1',
  agentDefinitionId: 'definition-1',
  name: 'Morning review',
  schedule: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'UTC' },
  payload: { message: 'Review pending work.' },
  activeHoursStart: '09:00',
  activeHoursEnd: '17:30',
  createdBy: 'agent-definition',
  enabled: true,
  executionNodeId: 'node-1',
  executionNodeLabel: 'Desktop',
};

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    agentInstanceId: createInput.agentInstanceId,
    agentDefinitionId: createInput.agentDefinitionId,
    name: createInput.name,
    schedule: createInput.schedule,
    payload: createInput.payload,
    activeHoursStart: createInput.activeHoursStart,
    activeHoursEnd: createInput.activeHoursEnd,
    enabled: true,
    createdBy: createInput.createdBy,
    state: 'active',
    executionNodeId: createInput.executionNodeId,
    executionNodeLabel: createInput.executionNodeLabel,
    originNodeId: 'caller-peer',
    updatedAt: '2026-08-25T01:00:00.000Z',
    ...overrides,
  };
}

function scopedTaskRequest() {
  return {
    taskId: 'task-1',
    agentInstanceId: 'conversation-1',
    agentDefinitionId: 'definition-1',
    executionNodeId: 'node-1',
  };
}

describe('scheduled task RPC client types', () => {
  it('preserves full and projected responses for each bound method', () => {
    const client = createScheduledTaskRpcClient({
      call: async () => {
        throw new Error('unused transport');
      },
    });

    expectTypeOf(client.list).toEqualTypeOf<
      (
        parameters: ScheduledTaskRpcListRequest,
        callOptions?: ScheduledTaskRpcCallOptions,
      ) => Promise<ScheduledTaskRpcListResponse>
    >();
    expectTypeOf(client.get).toEqualTypeOf<
      (
        parameters: ScheduledTaskRpcGetRequest,
        callOptions?: ScheduledTaskRpcCallOptions,
      ) => Promise<ScheduledTask | null>
    >();
    expectTypeOf(client.create).toEqualTypeOf<
      (
        parameters: ScheduledTaskRpcCreateRequest,
        callOptions?: ScheduledTaskRpcCallOptions,
      ) => Promise<ScheduledTask>
    >();
    expectTypeOf(client.update).toEqualTypeOf<
      (
        parameters: ScheduledTaskRpcUpdateRequest,
        callOptions?: ScheduledTaskRpcCallOptions,
      ) => Promise<ScheduledTask>
    >();
    expectTypeOf(client.delete).toEqualTypeOf<
      (
        parameters: ScheduledTaskRpcDeleteRequest,
        callOptions?: ScheduledTaskRpcCallOptions,
      ) => Promise<ScheduledTaskRpcDeleteResponse>
    >();
    expectTypeOf(client.cronPreview).toEqualTypeOf<
      (
        parameters: ScheduledTaskRpcCronPreviewRequest,
        callOptions?: ScheduledTaskRpcCallOptions,
      ) => Promise<string[]>
    >();
  });

  it('projects an already-checked response with one call and no second parse', async () => {
    const checked = vi.fn(async () => ({
      task: { ...task(), alreadyChecked: true },
    })) as unknown as CheckedScheduledTaskRpcCall;
    const client = bindScheduledTaskRpcClient(checked);

    await expect(client.get(scopedTaskRequest())).resolves.toMatchObject({
      id: 'task-1',
      alreadyChecked: true,
    });
    expect(checked).toHaveBeenCalledOnce();
    expect(checked).toHaveBeenCalledWith(
      SCHEDULED_TASK_RPC_METHODS.get,
      scopedTaskRequest(),
      {},
    );
  });
});

function store(overrides: Partial<ScheduledAgentTaskStore> = {}): ScheduledAgentTaskStore {
  return {
    list: vi.fn(async () => ({ items: [task()], hasMoreAfter: false })),
    get: vi.fn(async () => task()),
    create: vi.fn(async () => task()),
    update: vi.fn(async () => task()),
    delete: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('scheduled task RPC contract', () => {
  it('extracts conversation, definition, and non-authoritative execution target scope', () => {
    expect(parseScheduledTaskRpcGrantResources(
      SCHEDULED_TASK_RPC_METHODS.list,
      {
        agentInstanceId: 'conversation-1',
        executionNodeId: 'node-1',
        states: ['active'],
        limit: 20,
        maxBytes: SCHEDULED_TASK_RPC_LIMITS.listPageDefaultBytes,
      },
    )).toEqual({ conversationId: 'conversation-1', executionNodeId: 'node-1' });
    expect(parseScheduledTaskRpcGrantResources(
      SCHEDULED_TASK_RPC_METHODS.create,
      { input: createInput },
    )).toEqual({
      conversationId: 'conversation-1',
      definitionId: 'definition-1',
      executionNodeId: 'node-1',
    });
    expect(parseScheduledTaskRpcGrantResources(
      SCHEDULED_TASK_RPC_METHODS.delete,
      scopedTaskRequest(),
    )).toEqual({
      conversationId: 'conversation-1',
      definitionId: 'definition-1',
      executionNodeId: 'node-1',
    });
    expect(parseScheduledTaskRpcGrantResources(
      SCHEDULED_TASK_RPC_METHODS.cronPreview,
      { expression: '0 9 * * *', count: 3 },
    )).toEqual({});
  });

  it('rejects unbounded, ambiguous, and smuggled request fields', () => {
    expect(() => {
      assertScheduledTaskRpcRequest(
        SCHEDULED_TASK_RPC_METHODS.list,
        {
          agentInstanceId: 'conversation-1',
          executionNodeId: 'node-1',
          limit: SCHEDULED_TASK_RPC_LIMITS.listPage + 1,
          maxBytes: SCHEDULED_TASK_RPC_LIMITS.listPageDefaultBytes,
        },
      );
    }).toThrow('request.limit');
    expect(() => {
      assertScheduledTaskRpcRequest(
        SCHEDULED_TASK_RPC_METHODS.list,
        {
          agentInstanceId: 'conversation-1',
          executionNodeId: 'node-1',
          states: ['active', 'active'],
          maxBytes: SCHEDULED_TASK_RPC_LIMITS.listPageDefaultBytes,
        },
      );
    }).toThrow('request.states');
    expect(() => {
      assertScheduledTaskRpcRequest(
        SCHEDULED_TASK_RPC_METHODS.list,
        {
          agentInstanceId: 'conversation-1',
          executionNodeId: 'node-1',
        },
      );
    }).toThrow('request.maxBytes');
    expect(() => {
      assertScheduledTaskRpcRequest(
        SCHEDULED_TASK_RPC_METHODS.list,
        {
          agentInstanceId: 'conversation-1',
          executionNodeId: 'node-1',
          maxBytes: SCHEDULED_TASK_RPC_LIMITS.listPageMaxBytes + 1,
        },
      );
    }).toThrow('request.maxBytes');
    expect(() => {
      assertScheduledTaskRpcRequest(
        SCHEDULED_TASK_RPC_METHODS.create,
        { input: { ...createInput, originNodeId: 'attacker' } },
      );
    }).toThrow('request.input');
    expect(() => {
      assertScheduledTaskRpcRequest(
        SCHEDULED_TASK_RPC_METHODS.update,
        { ...scopedTaskRequest(), patch: {} },
      );
    }).toThrow('request.patch');
    expect(() => {
      assertScheduledTaskRpcRequest(
        SCHEDULED_TASK_RPC_METHODS.cronPreview,
        { expression: 'x'.repeat(SCHEDULED_TASK_RPC_LIMITS.cronExpressionCharacters + 1) },
      );
    }).toThrow('request.expression');
  });

  it('uses the same trim and ASCII-control identifier policy as Agent RPC', () => {
    const request = {
      agentInstanceId: 'conversation-1',
      executionNodeId: 'node-1',
      maxBytes: SCHEDULED_TASK_RPC_LIMITS.listPageDefaultBytes,
    };
    for (
      const invalid of [
        '',
        '   ',
        ' conversation-1',
        'conversation-1 ',
        'conversation\t1',
        'conversation\n1',
        `conversation${String.fromCharCode(127)}1`,
        'x'.repeat(SCHEDULED_TASK_RPC_LIMITS.identifierCharacters + 1),
      ]
    ) {
      expect(() => {
        assertScheduledTaskRpcRequest(SCHEDULED_TASK_RPC_METHODS.list, {
          ...request,
          agentInstanceId: invalid,
        });
      }).toThrow('request.agentInstanceId');
    }
    expect(() => {
      assertScheduledTaskRpcRequest(SCHEDULED_TASK_RPC_METHODS.list, {
        ...request,
        agentInstanceId: 'x'.repeat(SCHEDULED_TASK_RPC_LIMITS.identifierCharacters),
      });
    }).not.toThrow();
  });

  it('enforces the caller list byte budget on server and client responses', () => {
    const request = {
      agentInstanceId: 'conversation-1',
      executionNodeId: 'node-1',
      maxBytes: 64,
    };
    expect(() => {
      assertScheduledTaskRpcResponseCorrelation(
        SCHEDULED_TASK_RPC_METHODS.list,
        request,
        { items: [task()], hasMoreAfter: false },
      );
    }).toThrow('response.maxBytes');
  });

  it('strictly validates task responses and request correlation', () => {
    expect(parseScheduledTaskRpcResponse(
      SCHEDULED_TASK_RPC_METHODS.create,
      { task: task() },
    )).toEqual({ task: task() });
    expect(() =>
      parseScheduledTaskRpcResponse(
        SCHEDULED_TASK_RPC_METHODS.get,
        { task: { ...task(), serverSecret: true } },
      )
    ).toThrow('response.task');
    expect(() => {
      assertScheduledTaskRpcResponseCorrelation(
        SCHEDULED_TASK_RPC_METHODS.get,
        scopedTaskRequest(),
        { task: task({ agentInstanceId: 'conversation-other' }) },
      );
    }).toThrow('response.task');
    expect(() => {
      assertScheduledTaskRpcResponseCorrelation(
        SCHEDULED_TASK_RPC_METHODS.cronPreview,
        { expression: '0 9 * * *', count: 1 },
        {
          dates: [
            '2026-08-25T01:00:00.000Z',
            '2026-08-26T01:00:00.000Z',
          ],
        },
      );
    }).toThrow('response.dates');
    expect(() =>
      parseScheduledTaskRpcResponse(
        SCHEDULED_TASK_RPC_METHODS.cronPreview,
        {
          dates: [
            '2026-08-26T01:00:00.000Z',
            '2026-08-25T01:00:00.000Z',
          ],
        },
      )
    ).toThrow('response.dates');
  });

  it('fails closed before store access for missing adapters and target mismatch', async () => {
    const scheduledStore = store();
    const withoutStore = createScheduledTaskRpcHandler({ localPeerId: 'node-1' });
    const wrongTarget = createScheduledTaskRpcHandler({
      localPeerId: 'node-1',
      store: scheduledStore,
    });

    await expect(withoutStore({
      remotePeerId: 'caller-peer',
      method: SCHEDULED_TASK_RPC_METHODS.get,
      parameters: scopedTaskRequest(),
    })).rejects.toThrow('scheduled_task_store_unavailable');
    await expect(wrongTarget({
      remotePeerId: 'caller-peer',
      method: SCHEDULED_TASK_RPC_METHODS.get,
      parameters: { ...scopedTaskRequest(), executionNodeId: 'node-other' },
    })).rejects.toThrow('scheduled_task_execution_target_mismatch');

    expect(scheduledStore.get).not.toHaveBeenCalled();
  });

  it('rejects an already-aborted request before any schedule query', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled-before-query'));
    const scheduledStore = store();
    const handler = createScheduledTaskRpcHandler({
      localPeerId: 'node-1',
      store: scheduledStore,
    });

    await expect(handler({
      remotePeerId: 'caller-peer',
      method: SCHEDULED_TASK_RPC_METHODS.list,
      parameters: {
        agentInstanceId: 'conversation-1',
        executionNodeId: 'node-1',
        maxBytes: SCHEDULED_TASK_RPC_LIMITS.listPageDefaultBytes,
      },
      signal: controller.signal,
    })).rejects.toThrow('cancelled-before-query');
    expect(scheduledStore.list).not.toHaveBeenCalled();
  });

  it('propagates cancellation through a running query and emits no late response', async () => {
    const controller = new AbortController();
    let completed = false;
    const list = vi.fn(async (
      _request: Parameters<ScheduledAgentTaskStore['list']>[0],
      context: Parameters<ScheduledAgentTaskStore['list']>[1],
    ) => {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const reason = context.signal?.reason;
          reject(reason instanceof Error ? reason : new Error('aborted'));
        };
        context.signal?.addEventListener('abort', onAbort, { once: true });
        queueMicrotask(() => {
          if (!context.signal?.aborted) resolve();
        });
      });
      context.signal?.throwIfAborted();
      completed = true;
      return { items: [task()], hasMoreAfter: false };
    });
    const handler = createScheduledTaskRpcHandler({
      localPeerId: 'node-1',
      store: store({ list }),
    });
    const pending = handler({
      remotePeerId: 'caller-peer',
      method: SCHEDULED_TASK_RPC_METHODS.list,
      parameters: {
        agentInstanceId: 'conversation-1',
        executionNodeId: 'node-1',
        maxBytes: SCHEDULED_TASK_RPC_LIMITS.listPageDefaultBytes,
      },
      signal: controller.signal,
    });
    controller.abort(new Error('cancelled-while-query'));

    await expect(pending).rejects.toThrow('cancelled-while-query');
    expect(list).toHaveBeenCalledOnce();
    expect(completed).toBe(false);
    expect(list.mock.calls[0]?.[1].signal).toBe(controller.signal);
  });

  it('binds create origin to the authenticated caller and validates store results', async () => {
    const validStore = store();
    const handler = createScheduledTaskRpcHandler({
      localPeerId: 'node-1',
      store: validStore,
    });

    await expect(handler({
      remotePeerId: 'caller-peer',
      method: SCHEDULED_TASK_RPC_METHODS.create,
      parameters: { input: createInput },
    })).resolves.toEqual({ task: task() });
    expect(validStore.create).toHaveBeenCalledWith(createInput, {
      remotePeerId: 'caller-peer',
      localPeerId: 'node-1',
    });

    const invalidOrigin = createScheduledTaskRpcHandler({
      localPeerId: 'node-1',
      store: store({ create: vi.fn(async () => task({ originNodeId: 'forged-peer' })) }),
    });
    await expect(invalidOrigin({
      remotePeerId: 'caller-peer',
      method: SCHEDULED_TASK_RPC_METHODS.create,
      parameters: { input: createInput },
    })).rejects.toThrow('scheduled_task_origin_peer_mismatch');
  });

  it('delegates cron calculation and rejects missing or malformed preview adapters', async () => {
    const withoutPreview = createScheduledTaskRpcHandler({ localPeerId: 'node-1' });
    await expect(withoutPreview({
      remotePeerId: 'caller-peer',
      method: SCHEDULED_TASK_RPC_METHODS.cronPreview,
      parameters: { expression: '0 9 * * *', timezone: 'UTC', count: 2 },
    })).rejects.toThrow('scheduled_task_cron_previewer_unavailable');

    const preview = vi.fn(async () => [
      '2026-08-25T01:00:00.000Z',
      '2026-08-26T01:00:00.000Z',
    ]);
    const handler = createScheduledTaskRpcHandler({
      localPeerId: 'node-1',
      cronPreviewer: { preview },
    });
    await expect(handler({
      remotePeerId: 'caller-peer',
      method: SCHEDULED_TASK_RPC_METHODS.cronPreview,
      parameters: { expression: '0 9 * * *', timezone: 'UTC', count: 2 },
    })).resolves.toEqual({
      dates: [
        '2026-08-25T01:00:00.000Z',
        '2026-08-26T01:00:00.000Z',
      ],
    });
    expect(preview).toHaveBeenCalledOnce();
  });

  it('validates client requests before transport and rejects cross-resource responses', async () => {
    const call = vi.fn(async () => ({ task: task({ agentInstanceId: 'conversation-other' }) }));
    const client = createScheduledTaskRpcClient({ call: call as ScheduledTaskRpcCall });

    await expect(client.get(scopedTaskRequest())).rejects.toThrow('response.task');
    expect(call).toHaveBeenCalledOnce();

    await expect(client.list({
      agentInstanceId: '',
      executionNodeId: 'node-1',
      maxBytes: SCHEDULED_TASK_RPC_LIMITS.listPageDefaultBytes,
    })).rejects.toThrow('request.agentInstanceId');
    expect(call).toHaveBeenCalledOnce();
  });

  it('passes the exact AbortSignal to transport and rejects a late response', async () => {
    const controller = new AbortController();
    let resolveCall!: (value: unknown) => void;
    const call = vi.fn((_method, _parameters, callOptions) => {
      expect(callOptions?.signal).toBe(controller.signal);
      return new Promise<unknown>(resolve => {
        resolveCall = resolve;
      });
    });
    const client = createScheduledTaskRpcClient({ call: call as ScheduledTaskRpcCall });
    const pending = client.list({
      agentInstanceId: 'conversation-1',
      executionNodeId: 'node-1',
      maxBytes: SCHEDULED_TASK_RPC_LIMITS.listPageDefaultBytes,
    }, { signal: controller.signal });
    await Promise.resolve();
    controller.abort(new Error('cancelled-before-response'));
    resolveCall({ items: [task()], hasMoreAfter: false });

    await expect(pending).rejects.toThrow('cancelled-before-response');
    expect(call).toHaveBeenCalledOnce();
  });

  it('adapts the editor contract without authorizing a bare task id', async () => {
    const rpc = {
      list: vi.fn(async () => ({ items: [task()], hasMoreAfter: false })),
      create: vi.fn(async () => task()),
      update: vi.fn(async () => task({ activeHoursStart: undefined })),
      delete: vi.fn(async () => ({ deleted: true as const, taskId: 'task-1' })),
      cronPreview: vi.fn(async () => ['2026-08-25T01:00:00.000Z']),
    } as unknown as ReturnType<typeof createScheduledTaskRpcClient>;
    const editorClient = createScheduledTaskClientFromRpc({
      rpc,
      executionNodeId: 'node-1',
      originNodeId: 'caller-peer',
    });

    await expect(editorClient.deleteScheduledTask('unknown')).rejects.toThrow(
      'scheduled_task_scope_unavailable',
    );
    expect(rpc.delete).not.toHaveBeenCalled();

    await expect(editorClient.listScheduledTasksForAgent('conversation-1', { states: ['active'] }))
      .resolves.toEqual({
        items: [task()],
        hasMoreAfter: false,
        partial: false,
        sources: [{ executionNodeId: 'node-1', state: 'online', fromCache: false }],
      });
    expect(rpc.list).toHaveBeenCalledWith({
      agentInstanceId: 'conversation-1',
      executionNodeId: 'node-1',
      states: ['active'],
      limit: SCHEDULED_TASK_RPC_LIMITS.listPage,
      maxBytes: SCHEDULED_TASK_RPC_LIMITS.listPageDefaultBytes,
    });
    await expect(editorClient.listScheduledTasksForAgent('conversation-1', {
      executionNodeIds: ['another-node'],
    })).resolves.toEqual({
      items: [],
      hasMoreAfter: false,
      partial: false,
      sources: [],
    });
    await expect(editorClient.listScheduledTasksForAgent('conversation-1', {
      executionNodeIds: ['node-1', 'node-1'],
    })).rejects.toThrow('options.executionNodeIds');
    await expect(editorClient.listScheduledTasksForAgent('conversation-1', {
      executionNodeIds: Array.from({ length: 65 }, (_, index) => `node-${index}`),
    })).rejects.toThrow('options.executionNodeIds');
    expect(rpc.list).toHaveBeenCalledTimes(1);
    await editorClient.updateScheduledTask('task-1', {
      ...createInput,
      scheduleKind: 'cron',
      originNodeId: 'caller-peer',
      activeHoursStart: undefined,
    } as CreateScheduledTaskInput);
    expect(rpc.update).toHaveBeenCalledWith({
      ...scopedTaskRequest(),
      patch: expect.objectContaining({
        activeHoursStart: null,
        executionNodeId: 'node-1',
      }),
    });

    await editorClient.deleteScheduledTask('task-1');
    expect(rpc.delete).toHaveBeenCalledWith(scopedTaskRequest());

    await editorClient.getCronPreviewDates('0 9 * * *');
    expect(rpc.cronPreview.mock.calls[0]?.[0]).toEqual({
      expression: '0 9 * * *',
      count: SCHEDULED_TASK_RPC_DEFAULTS.cronPreviewCount,
    });
    expect(Object.values(rpc.cronPreview.mock.calls[0]?.[0] ?? {})).not.toContain(undefined);

    await expect(editorClient.createScheduledTask({
      ...createInput,
      scheduleKind: 'cron',
      originNodeId: 'caller-peer',
      executionNodeId: 'node-other',
    })).rejects.toThrow('input.executionNodeId');
    expect(rpc.create).not.toHaveBeenCalled();
  });
});
