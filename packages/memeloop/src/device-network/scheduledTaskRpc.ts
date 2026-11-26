import type { CreateScheduledTaskInput, ListScheduledTasksOptions, ScheduledTask, ScheduledTaskClient, ScheduledTaskState } from '../agent-management/types.js';
import { canonicalJsonBytes } from '../encoding/canonicalJson.js';
import { bindRpcMethod, createRpcContractClient } from './rpcContractBinder.js';

export const SCHEDULED_TASK_RPC_METHODS = Object.freeze(
  {
    list: 'memeloop.schedule.list',
    get: 'memeloop.schedule.get',
    create: 'memeloop.schedule.create',
    update: 'memeloop.schedule.update',
    delete: 'memeloop.schedule.delete',
    cronPreview: 'memeloop.schedule.cronPreview',
  } as const,
);

export type ScheduledTaskRpcMethod = typeof SCHEDULED_TASK_RPC_METHODS[keyof typeof SCHEDULED_TASK_RPC_METHODS];

export const SCHEDULED_TASK_RPC_LIMITS = Object.freeze(
  {
    identifierCharacters: 512,
    nameCharacters: 256,
    labelCharacters: 256,
    creatorCharacters: 256,
    cronExpressionCharacters: 256,
    timezoneCharacters: 128,
    messageCharacters: 32 * 1024,
    cursorCharacters: 2_048,
    listPage: 100,
    listPageDefaultBytes: 256 * 1024,
    listPageMaxBytes: 256 * 1024,
    /** Maximum number of task records retained for task-scoped editor writes. */
    knownTaskCacheEntries: 1_024,
    executionNodeFilters: 64,
    cronPreviewDates: 10,
  } as const,
);

export const SCHEDULED_TASK_RPC_DEFAULTS = Object.freeze({
  listStates: Object.freeze(['active', 'paused'] as const satisfies readonly ScheduledTaskState[]),
  listLimit: SCHEDULED_TASK_RPC_LIMITS.listPage,
  listMaxBytes: SCHEDULED_TASK_RPC_LIMITS.listPageDefaultBytes,
  cronPreviewCount: 3,
});

export type ScheduledTaskRpcSchedule = CreateScheduledTaskInput['schedule'];

export interface ScheduledTaskRpcCreateInput {
  agentInstanceId: string;
  agentDefinitionId: string;
  name: string;
  schedule: ScheduledTaskRpcSchedule;
  payload?: { message: string };
  activeHoursStart?: string;
  activeHoursEnd?: string;
  createdBy?: string;
  enabled?: boolean;
  /** Must equal the authenticated node receiving this RPC. */
  executionNodeId: string;
  executionNodeLabel?: string;
}

export interface ScheduledTaskRpcUpdatePatch {
  name?: string;
  schedule?: ScheduledTaskRpcSchedule;
  payload?: { message: string } | null;
  activeHoursStart?: string | null;
  activeHoursEnd?: string | null;
  enabled?: boolean;
  /** Repeated deliberately so a transfer cannot be hidden in an update. */
  executionNodeId?: string;
  executionNodeLabel?: string | null;
}

export interface ScheduledTaskRpcListRequest {
  /** Agent instances are conversation-scoped resources. */
  agentInstanceId: string;
  /** Per-device RPCs may enumerate only the authenticated execution node. */
  executionNodeId: string;
  states?: ScheduledTaskState[];
  cursor?: string;
  limit?: number;
  /** Required storage and transport scan budget for the complete response. */
  maxBytes: number;
}

export interface ScheduledTaskRpcListResponse {
  items: ScheduledTask[];
  nextCursor?: string;
  hasMoreAfter: boolean;
}

export interface ScheduledTaskRpcScopedTaskRequest {
  taskId: string;
  agentInstanceId: string;
  agentDefinitionId: string;
  executionNodeId: string;
}

export type ScheduledTaskRpcGetRequest = ScheduledTaskRpcScopedTaskRequest;

export interface ScheduledTaskRpcGetResponse {
  task: ScheduledTask | null;
}

export interface ScheduledTaskRpcCreateRequest {
  input: ScheduledTaskRpcCreateInput;
}

export interface ScheduledTaskRpcCreateResponse {
  task: ScheduledTask;
}

export interface ScheduledTaskRpcUpdateRequest extends ScheduledTaskRpcScopedTaskRequest {
  patch: ScheduledTaskRpcUpdatePatch;
}

export interface ScheduledTaskRpcUpdateResponse {
  task: ScheduledTask;
}

export type ScheduledTaskRpcDeleteRequest = ScheduledTaskRpcScopedTaskRequest;

export interface ScheduledTaskRpcDeleteResponse {
  deleted: true;
  taskId: string;
}

export interface ScheduledTaskRpcCronPreviewRequest {
  expression: string;
  timezone?: string;
  count?: number;
}

export interface ScheduledTaskRpcCronPreviewResponse {
  dates: string[];
}

export interface ScheduledTaskRpcContract {
  [SCHEDULED_TASK_RPC_METHODS.list]: {
    request: ScheduledTaskRpcListRequest;
    response: ScheduledTaskRpcListResponse;
  };
  [SCHEDULED_TASK_RPC_METHODS.get]: {
    request: ScheduledTaskRpcGetRequest;
    response: ScheduledTaskRpcGetResponse;
  };
  [SCHEDULED_TASK_RPC_METHODS.create]: {
    request: ScheduledTaskRpcCreateRequest;
    response: ScheduledTaskRpcCreateResponse;
  };
  [SCHEDULED_TASK_RPC_METHODS.update]: {
    request: ScheduledTaskRpcUpdateRequest;
    response: ScheduledTaskRpcUpdateResponse;
  };
  [SCHEDULED_TASK_RPC_METHODS.delete]: {
    request: ScheduledTaskRpcDeleteRequest;
    response: ScheduledTaskRpcDeleteResponse;
  };
  [SCHEDULED_TASK_RPC_METHODS.cronPreview]: {
    request: ScheduledTaskRpcCronPreviewRequest;
    response: ScheduledTaskRpcCronPreviewResponse;
  };
}

export type ScheduledTaskRpcRequest<M extends ScheduledTaskRpcMethod> = ScheduledTaskRpcContract[M]['request'];
export type ScheduledTaskRpcResponse<M extends ScheduledTaskRpcMethod> = ScheduledTaskRpcContract[M]['response'];

const SCHEDULED_TASK_RPC_METHOD_SET = new Set<string>(
  Object.values(SCHEDULED_TASK_RPC_METHODS),
);

export function isScheduledTaskRpcMethod(value: unknown): value is ScheduledTaskRpcMethod {
  return typeof value === 'string' && SCHEDULED_TASK_RPC_METHOD_SET.has(value);
}

export class ScheduledTaskRpcProtocolError extends Error {
  readonly code = 'invalid_scheduled_task_rpc' as const;

  constructor(readonly field: string) {
    super(`Invalid scheduled task RPC ${field}`);
    this.name = 'ScheduledTaskRpcProtocolError';
  }
}

/** Validate every caller-controlled request before authorization or dispatch. */
export function assertScheduledTaskRpcRequest<M extends ScheduledTaskRpcMethod>(
  method: M,
  value: unknown,
): asserts value is ScheduledTaskRpcRequest<M> {
  const request = asRecord(value, 'request');
  switch (method) {
    case SCHEDULED_TASK_RPC_METHODS.list:
      assertOnlyKeys(request, [
        'agentInstanceId',
        'executionNodeId',
        'states',
        'cursor',
        'limit',
        'maxBytes',
      ], 'request');
      assertIdentifier(request.agentInstanceId, 'request.agentInstanceId');
      assertIdentifier(request.executionNodeId, 'request.executionNodeId');
      optionalStateList(request.states, 'request.states');
      optionalBoundedString(
        request.cursor,
        'request.cursor',
        SCHEDULED_TASK_RPC_LIMITS.cursorCharacters,
      );
      optionalInteger(
        request.limit,
        'request.limit',
        1,
        SCHEDULED_TASK_RPC_LIMITS.listPage,
      );
      if (request.maxBytes === undefined) fail('request.maxBytes');
      optionalInteger(
        request.maxBytes,
        'request.maxBytes',
        64,
        SCHEDULED_TASK_RPC_LIMITS.listPageMaxBytes,
      );
      return;
    case SCHEDULED_TASK_RPC_METHODS.get:
    case SCHEDULED_TASK_RPC_METHODS.delete:
      assertScopedTaskRequest(request, 'request');
      return;
    case SCHEDULED_TASK_RPC_METHODS.create:
      assertOnlyKeys(request, ['input'], 'request');
      assertCreateInput(request.input, 'request.input');
      return;
    case SCHEDULED_TASK_RPC_METHODS.update:
      assertOnlyKeys(request, [
        'taskId',
        'agentInstanceId',
        'agentDefinitionId',
        'executionNodeId',
        'patch',
      ], 'request');
      assertIdentifier(request.taskId, 'request.taskId');
      assertIdentifier(request.agentInstanceId, 'request.agentInstanceId');
      assertIdentifier(request.agentDefinitionId, 'request.agentDefinitionId');
      assertIdentifier(request.executionNodeId, 'request.executionNodeId');
      assertUpdatePatch(request.patch, 'request.patch');
      return;
    case SCHEDULED_TASK_RPC_METHODS.cronPreview:
      assertOnlyKeys(request, ['expression', 'timezone', 'count'], 'request');
      assertBoundedString(
        request.expression,
        'request.expression',
        SCHEDULED_TASK_RPC_LIMITS.cronExpressionCharacters,
      );
      optionalBoundedString(
        request.timezone,
        'request.timezone',
        SCHEDULED_TASK_RPC_LIMITS.timezoneCharacters,
      );
      optionalInteger(
        request.count,
        'request.count',
        1,
        SCHEDULED_TASK_RPC_LIMITS.cronPreviewDates,
      );
      return;
  }
}

/** Parse and bound every untrusted server/store response. */
export function parseScheduledTaskRpcResponse<M extends ScheduledTaskRpcMethod>(
  method: M,
  value: unknown,
): ScheduledTaskRpcResponse<M>;
export function parseScheduledTaskRpcResponse(
  method: ScheduledTaskRpcMethod,
  value: unknown,
): ScheduledTaskRpcResponse<ScheduledTaskRpcMethod> {
  const response = asRecord(value, 'response');
  switch (method) {
    case SCHEDULED_TASK_RPC_METHODS.list:
      assertOnlyKeys(response, ['items', 'nextCursor', 'hasMoreAfter'], 'response');
      assertArray(response.items, 'response.items');
      if (response.items.length > SCHEDULED_TASK_RPC_LIMITS.listPage) {
        fail('response.items');
      }
      for (const task of response.items) assertScheduledTask(task, 'response.items[]');
      optionalBoundedString(
        response.nextCursor,
        'response.nextCursor',
        SCHEDULED_TASK_RPC_LIMITS.cursorCharacters,
      );
      if (
        typeof response.hasMoreAfter !== 'boolean' ||
        response.hasMoreAfter !== (response.nextCursor !== undefined)
      ) fail('response.hasMoreAfter');
      if (response.nextCursor !== undefined) {
        assertBoundedString(
          response.nextCursor,
          'response.nextCursor',
          SCHEDULED_TASK_RPC_LIMITS.cursorCharacters,
        );
      }
      return {
        items: response.items.map((task, index) => {
          assertScheduledTask(task, `response.items[${index}]`);
          return task;
        }),
        ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }),
        hasMoreAfter: response.hasMoreAfter,
      };
    case SCHEDULED_TASK_RPC_METHODS.get:
      assertOnlyKeys(response, ['task'], 'response');
      if (response.task === null) return { task: null };
      assertScheduledTask(response.task, 'response.task');
      return { task: response.task };
    case SCHEDULED_TASK_RPC_METHODS.create:
    case SCHEDULED_TASK_RPC_METHODS.update:
      assertOnlyKeys(response, ['task'], 'response');
      assertScheduledTask(response.task, 'response.task');
      return { task: response.task };
    case SCHEDULED_TASK_RPC_METHODS.delete:
      assertOnlyKeys(response, ['deleted', 'taskId'], 'response');
      if (response.deleted !== true) fail('response.deleted');
      assertIdentifier(response.taskId, 'response.taskId');
      return { deleted: true, taskId: response.taskId };
    case SCHEDULED_TASK_RPC_METHODS.cronPreview:
      assertOnlyKeys(response, ['dates'], 'response');
      assertArray(response.dates, 'response.dates');
      if (response.dates.length > SCHEDULED_TASK_RPC_LIMITS.cronPreviewDates) {
        fail('response.dates');
      }
      assertCanonicalDates(response.dates, 'response.dates');
      return {
        dates: response.dates.map((date, index) => {
          assertCanonicalDate(date, `response.dates[${index}]`);
          return date;
        }),
      };
  }
}

export interface ScheduledTaskRpcGrantResources {
  conversationId?: string;
  definitionId?: string;
  /** This is a transport target check, never a Cloud-grant authority claim. */
  executionNodeId?: string;
}

/** Validate and extract the resource tuple consumed by the shared grant check. */
export function parseScheduledTaskRpcGrantResources(
  method: string,
  parameters: unknown,
): ScheduledTaskRpcGrantResources {
  if (!isScheduledTaskRpcMethod(method)) fail('method');
  assertScheduledTaskRpcRequest(method, parameters);
  return getScheduledTaskRpcGrantResources(method, parameters);
}

/** Extract resources from a request that has already crossed a validation boundary. */
export function getScheduledTaskRpcGrantResources(
  method: ScheduledTaskRpcMethod,
  parameters: ScheduledTaskRpcRequest<ScheduledTaskRpcMethod>,
): ScheduledTaskRpcGrantResources {
  switch (method) {
    case SCHEDULED_TASK_RPC_METHODS.list:
      assertScheduledTaskRpcRequest(SCHEDULED_TASK_RPC_METHODS.list, parameters);
      return {
        conversationId: parameters.agentInstanceId,
        executionNodeId: parameters.executionNodeId,
      };
    case SCHEDULED_TASK_RPC_METHODS.get:
    case SCHEDULED_TASK_RPC_METHODS.delete:
      assertScheduledTaskRpcRequest(method, parameters);
      return scopedTaskResources(parameters);
    case SCHEDULED_TASK_RPC_METHODS.create: {
      assertScheduledTaskRpcRequest(SCHEDULED_TASK_RPC_METHODS.create, parameters);
      const input = parameters.input;
      return {
        conversationId: input.agentInstanceId,
        definitionId: input.agentDefinitionId,
        executionNodeId: input.executionNodeId,
      };
    }
    case SCHEDULED_TASK_RPC_METHODS.update:
      assertScheduledTaskRpcRequest(SCHEDULED_TASK_RPC_METHODS.update, parameters);
      return scopedTaskResources(parameters);
    case SCHEDULED_TASK_RPC_METHODS.cronPreview:
      return {};
  }
}

export interface ScheduledTaskRpcStoreContext {
  /** Authenticated libp2p caller; stores must use this as origin on create. */
  remotePeerId: string;
  /** Authenticated node handling and executing this task. */
  localPeerId: string;
  /**
   * End-to-end RPC cancellation. Durable adapters must observe this before
   * committing a write and must stop bounded reads as soon as it aborts.
   */
  signal?: AbortSignal;
}

/**
 * Narrow durable port. Update/delete implementations MUST atomically match the
 * complete taskId+agentInstanceId+agentDefinitionId+executionNodeId tuple.
 */
export interface ScheduledAgentTaskStore {
  /** Keyset read that must stop scanning before `request.maxBytes` is exceeded. */
  list(
    request: ScheduledTaskRpcListRequest,
    context: ScheduledTaskRpcStoreContext,
  ): Promise<ScheduledTaskRpcListResponse>;
  get(
    request: ScheduledTaskRpcGetRequest,
    context: ScheduledTaskRpcStoreContext,
  ): Promise<ScheduledTask | undefined>;
  create(
    input: ScheduledTaskRpcCreateInput,
    context: ScheduledTaskRpcStoreContext,
  ): Promise<ScheduledTask>;
  update(
    request: ScheduledTaskRpcUpdateRequest,
    context: ScheduledTaskRpcStoreContext,
  ): Promise<ScheduledTask>;
  delete(
    request: ScheduledTaskRpcDeleteRequest,
    context: ScheduledTaskRpcStoreContext,
  ): Promise<void>;
}

export interface ScheduledTaskCronPreviewer {
  preview(
    request: ScheduledTaskRpcCronPreviewRequest,
    context: ScheduledTaskRpcStoreContext,
  ): Promise<readonly string[]>;
}

export interface ScheduledTaskRpcHandlerOptions {
  localPeerId: string;
  store?: ScheduledAgentTaskStore;
  cronPreviewer?: ScheduledTaskCronPreviewer;
}

export interface ScheduledTaskRpcHandlerInput {
  remotePeerId: string;
  method: ScheduledTaskRpcMethod;
  parameters: unknown;
  signal?: AbortSignal;
}

export type ScheduledTaskRpcValidatedHandlerInput = {
  [M in ScheduledTaskRpcMethod]: {
    remotePeerId: string;
    method: M;
    parameters: ScheduledTaskRpcRequest<M>;
    resources: ScheduledTaskRpcGrantResources;
    signal?: AbortSignal;
  };
}[ScheduledTaskRpcMethod];

export type ScheduledTaskRpcValidatedHandler = (
  input: ScheduledTaskRpcValidatedHandlerInput,
) => Promise<unknown>;

export interface ScheduledTaskRpcHandler {
  (input: ScheduledTaskRpcHandlerInput): Promise<unknown>;
  /**
   * Embedded trust boundary for a request already checked by Agent RPC. The
   * embedding boundary remains responsible for parsing and correlating the
   * returned value.
   */
  dispatchValidatedRequest: ScheduledTaskRpcValidatedHandler;
}

/** Optional adapter used by the main RPC handler after its shared grant check. */
export function createScheduledTaskRpcHandler(options: ScheduledTaskRpcHandlerOptions): ScheduledTaskRpcHandler {
  assertIdentifier(options.localPeerId, 'options.localPeerId');

  const dispatchValidatedRequest: ScheduledTaskRpcValidatedHandler = async input => {
    input.signal?.throwIfAborted();
    assertIdentifier(input.remotePeerId, 'input.remotePeerId');
    if (
      input.resources.executionNodeId !== undefined &&
      input.resources.executionNodeId !== options.localPeerId
    ) {
      throw new Error('scheduled_task_execution_target_mismatch');
    }
    const context: ScheduledTaskRpcStoreContext = {
      remotePeerId: input.remotePeerId,
      localPeerId: options.localPeerId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    let response: unknown;
    switch (input.method) {
      case SCHEDULED_TASK_RPC_METHODS.list:
        response = await requireStore(options).list(input.parameters, context);
        break;
      case SCHEDULED_TASK_RPC_METHODS.get: {
        const task = await requireStore(options).get(input.parameters, context);
        response = { task: task ?? null };
        break;
      }
      case SCHEDULED_TASK_RPC_METHODS.create: {
        response = { task: await requireStore(options).create(input.parameters.input, context) };
        break;
      }
      case SCHEDULED_TASK_RPC_METHODS.update:
        response = {
          task: await requireStore(options).update(input.parameters, context),
        };
        break;
      case SCHEDULED_TASK_RPC_METHODS.delete: {
        await requireStore(options).delete(input.parameters, context);
        response = { deleted: true, taskId: input.parameters.taskId };
        break;
      }
      case SCHEDULED_TASK_RPC_METHODS.cronPreview: {
        if (!options.cronPreviewer) {
          throw new Error('scheduled_task_cron_previewer_unavailable');
        }
        const dates = await options.cronPreviewer.preview(input.parameters, context);
        response = { dates: [...dates] };
        break;
      }
    }
    input.signal?.throwIfAborted();
    return response;
  };

  const handler = async (input: ScheduledTaskRpcHandlerInput): Promise<unknown> => {
    assertScheduledTaskRpcRequest(input.method, input.parameters);
    const parameters = input.parameters;
    const validatedInput = {
      ...input,
      parameters,
      resources: getScheduledTaskRpcGrantResources(input.method, parameters),
    } as ScheduledTaskRpcValidatedHandlerInput;
    const response = await dispatchValidatedRequest(validatedInput);
    const parsed = parseCorrelatedScheduledTaskRpcResponse(
      input.method,
      input.parameters,
      response,
    );
    assertScheduledTaskRpcResponseOrigin(input.method, parsed, input.remotePeerId);
    return parsed;
  };

  return Object.assign(handler, { dispatchValidatedRequest });
}

export interface ScheduledTaskRpcCallOptions {
  signal?: AbortSignal;
}

export type ScheduledTaskRpcCall = <M extends ScheduledTaskRpcMethod>(
  method: M,
  parameters: ScheduledTaskRpcRequest<M>,
  options?: ScheduledTaskRpcCallOptions,
) => Promise<unknown>;

export type CheckedScheduledTaskRpcCall = <M extends ScheduledTaskRpcMethod>(
  method: M,
  parameters: ScheduledTaskRpcRequest<M>,
  options?: ScheduledTaskRpcCallOptions,
) => Promise<ScheduledTaskRpcResponse<M>>;

export function createScheduledTaskRpcClient(options: { call: ScheduledTaskRpcCall }) {
  const client = createRpcContractClient<ScheduledTaskRpcContract, ScheduledTaskRpcCallOptions>({
    descriptor: {
      validateRequest: assertScheduledTaskRpcRequest,
      parseResponse: parseScheduledTaskRpcResponse,
      assertCorrelation: assertScheduledTaskRpcResponseCorrelation,
    },
    call: options.call,
    throwIfAborted: callOptions => callOptions?.signal?.throwIfAborted(),
  });

  return bindScheduledTaskRpcClient((method, request, callOptions) => client.request(method, request, callOptions));
}

/** Bind method names and projections to an already-checked embedded contract. */
export function bindScheduledTaskRpcClient(call: CheckedScheduledTaskRpcCall) {
  const bind = <M extends ScheduledTaskRpcMethod>(method: M) => {
    // The method variable is generic; spell out its key so the contract map
    // keeps the request/response pair correlated through this binder.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments
    const checked = bindRpcMethod<ScheduledTaskRpcContract, ScheduledTaskRpcCallOptions, M>(call, method);
    return (request: ScheduledTaskRpcRequest<M>, options: ScheduledTaskRpcCallOptions = {}) => checked(request, options);
  };

  function bindProjected<M extends ScheduledTaskRpcMethod, R>(
    method: M,
    project: (response: ScheduledTaskRpcResponse<M>) => R,
  ) {
    return async (
      parameters: ScheduledTaskRpcRequest<M>,
      callOptions: ScheduledTaskRpcCallOptions = {},
    ): Promise<R> => project(await call(method, parameters, callOptions));
  }

  return {
    request: call,
    list: bind(SCHEDULED_TASK_RPC_METHODS.list),
    get: bindProjected(SCHEDULED_TASK_RPC_METHODS.get, response => response.task),
    create: bindProjected(SCHEDULED_TASK_RPC_METHODS.create, response => response.task),
    update: bindProjected(SCHEDULED_TASK_RPC_METHODS.update, response => response.task),
    delete: bind(SCHEDULED_TASK_RPC_METHODS.delete),
    cronPreview: bindProjected(
      SCHEDULED_TASK_RPC_METHODS.cronPreview,
      response => response.dates,
    ),
  };
}

export type ScheduledTaskRpcClient = ReturnType<typeof createScheduledTaskRpcClient>;

/**
 * Adapt the typed RPC client to the existing editor contract. Task-scoped
 * writes require a task previously returned by list/create/update, so a bare
 * attacker-controlled task id can never become an authorization hint.
 */
export function createScheduledTaskClientFromRpc(options: {
  rpc: ScheduledTaskRpcClient;
  executionNodeId: string;
  originNodeId: string;
}): ScheduledTaskClient {
  assertIdentifier(options.executionNodeId, 'options.executionNodeId');
  assertIdentifier(options.originNodeId, 'options.originNodeId');
  const knownTasks = new Map<string, ScheduledTask>();

  const remember = (task: ScheduledTask): ScheduledTask => {
    // Keep the newest records available for task-scoped writes without allowing
    // an unbounded sequence of list/create responses to retain every task.
    knownTasks.delete(task.id);
    if (knownTasks.size >= SCHEDULED_TASK_RPC_LIMITS.knownTaskCacheEntries) {
      const oldest = knownTasks.keys().next().value;
      if (typeof oldest === 'string') knownTasks.delete(oldest);
    }
    knownTasks.set(task.id, task);
    return task;
  };

  return {
    async listScheduledTasksForAgent(
      agentInstanceId: string,
      listOptions: ListScheduledTasksOptions = {},
    ) {
      listOptions.signal?.throwIfAborted();
      if (listOptions.executionNodeIds !== undefined) {
        if (
          listOptions.executionNodeIds.length > SCHEDULED_TASK_RPC_LIMITS.executionNodeFilters ||
          new Set(listOptions.executionNodeIds).size !== listOptions.executionNodeIds.length
        ) throw new ScheduledTaskRpcProtocolError('options.executionNodeIds');
        for (const executionNodeId of listOptions.executionNodeIds) {
          assertIdentifier(executionNodeId, 'options.executionNodeIds[]');
        }
      }
      if (
        listOptions.executionNodeIds !== undefined &&
        !listOptions.executionNodeIds.includes(options.executionNodeId)
      ) {
        return {
          items: [],
          hasMoreAfter: false,
          partial: false,
          sources: [],
        };
      }
      if (
        listOptions.executionNodeIds?.some(nodeId => nodeId !== options.executionNodeId)
      ) {
        throw new ScheduledTaskRpcProtocolError('options.executionNodeIds');
      }
      const request: ScheduledTaskRpcListRequest = {
        agentInstanceId,
        executionNodeId: options.executionNodeId,
        states: listOptions.states ?? [...SCHEDULED_TASK_RPC_DEFAULTS.listStates],
        ...(listOptions.cursor === undefined ? {} : { cursor: listOptions.cursor }),
        limit: listOptions.limit ?? SCHEDULED_TASK_RPC_DEFAULTS.listLimit,
        maxBytes: listOptions.maxBytes ?? SCHEDULED_TASK_RPC_DEFAULTS.listMaxBytes,
      };
      const response = listOptions.signal === undefined
        ? await options.rpc.list(request)
        : await options.rpc.list(request, { signal: listOptions.signal });
      listOptions.signal?.throwIfAborted();
      for (const task of response.items) remember(task);
      return {
        ...response,
        partial: false,
        sources: [{ executionNodeId: options.executionNodeId, state: 'online', fromCache: false }],
      };
    },

    async createScheduledTask(input: CreateScheduledTaskInput, callOptions = {}): Promise<ScheduledTask> {
      callOptions.signal?.throwIfAborted();
      assertEditorInputIdentity(input, options);
      const request = { input: createInputFromEditor(input) };
      const task = callOptions.signal === undefined
        ? await options.rpc.create(request)
        : await options.rpc.create(request, callOptions);
      callOptions.signal?.throwIfAborted();
      return remember(task);
    },

    async updateScheduledTask(
      taskId: string,
      input: Partial<CreateScheduledTaskInput>,
      callOptions = {},
    ): Promise<ScheduledTask> {
      callOptions.signal?.throwIfAborted();
      const task = requireKnownTask(knownTasks, taskId);
      assertEditorPatchIdentity(input, task, options);
      const patch = updatePatchFromEditor(input);
      const request = {
        taskId,
        agentInstanceId: task.agentInstanceId,
        agentDefinitionId: task.agentDefinitionId,
        executionNodeId: task.executionNodeId,
        patch,
      };
      return remember(
        callOptions.signal === undefined
          ? await options.rpc.update(request)
          : await options.rpc.update(request, callOptions),
      );
    },

    async deleteScheduledTask(taskId: string, callOptions = {}): Promise<void> {
      callOptions.signal?.throwIfAborted();
      const task = requireKnownTask(knownTasks, taskId);
      const request = {
        taskId,
        agentInstanceId: task.agentInstanceId,
        agentDefinitionId: task.agentDefinitionId,
        executionNodeId: task.executionNodeId,
      };
      if (callOptions.signal === undefined) await options.rpc.delete(request);
      else await options.rpc.delete(request, callOptions);
      callOptions.signal?.throwIfAborted();
      knownTasks.delete(taskId);
    },

    getCronPreviewDates: (expression, timezone, count, callOptions) =>
      options.rpc.cronPreview({
        expression,
        ...(timezone === undefined ? {} : { timezone }),
        count: count ?? SCHEDULED_TASK_RPC_DEFAULTS.cronPreviewCount,
      }, callOptions),
  };
}

function parseCorrelatedScheduledTaskRpcResponse<M extends ScheduledTaskRpcMethod>(
  method: M,
  request: ScheduledTaskRpcRequest<M>,
  responseValue: unknown,
): ScheduledTaskRpcResponse<M> {
  const response = parseScheduledTaskRpcResponse(method, responseValue);
  assertScheduledTaskRpcResponseCorrelation(method, request, response);
  return response;
}

export function assertScheduledTaskRpcResponseCorrelation<M extends ScheduledTaskRpcMethod>(
  method: M,
  requestValue: ScheduledTaskRpcRequest<M>,
  response: ScheduledTaskRpcResponse<M>,
): void {
  const request = asRecord(requestValue, 'request');
  switch (method) {
    case SCHEDULED_TASK_RPC_METHODS.list: {
      const listRequest = requestValue as ScheduledTaskRpcListRequest;
      const listResponse = response as ScheduledTaskRpcListResponse;
      const limit = listRequest.limit ?? SCHEDULED_TASK_RPC_DEFAULTS.listLimit;
      if (listResponse.items.length > limit) fail('response.items');
      try {
        canonicalJsonBytes(listResponse, {
          maxDepth: 16,
          maxNodes: 20_000,
          maxStringCodeUnits: SCHEDULED_TASK_RPC_LIMITS.messageCharacters,
          maxStringBytes: SCHEDULED_TASK_RPC_LIMITS.messageCharacters * 4,
          maxBytes: listRequest.maxBytes,
        });
      } catch {
        fail('response.maxBytes');
      }
      const seen = new Set<string>();
      for (const task of listResponse.items) {
        if (
          task.agentInstanceId !== listRequest.agentInstanceId ||
          task.executionNodeId !== listRequest.executionNodeId ||
          (listRequest.states !== undefined && !listRequest.states.includes(task.state)) ||
          seen.has(task.id)
        ) fail('response.items');
        seen.add(task.id);
      }
      return;
    }
    case SCHEDULED_TASK_RPC_METHODS.get: {
      const task = (response as ScheduledTaskRpcGetResponse).task;
      if (task) assertTaskMatchesScopedRequest(task, request, 'response.task');
      return;
    }
    case SCHEDULED_TASK_RPC_METHODS.create: {
      const input = request.input as ScheduledTaskRpcCreateInput;
      const task = (response as ScheduledTaskRpcCreateResponse).task;
      if (
        task.agentInstanceId !== input.agentInstanceId ||
        task.agentDefinitionId !== input.agentDefinitionId ||
        task.executionNodeId !== input.executionNodeId
      ) fail('response.task');
      return;
    }
    case SCHEDULED_TASK_RPC_METHODS.update:
      assertTaskMatchesScopedRequest(
        (response as ScheduledTaskRpcUpdateResponse).task,
        request,
        'response.task',
      );
      return;
    case SCHEDULED_TASK_RPC_METHODS.delete:
      if ((response as ScheduledTaskRpcDeleteResponse).taskId !== request.taskId) {
        fail('response.taskId');
      }
      return;
    case SCHEDULED_TASK_RPC_METHODS.cronPreview: {
      const previewRequest = requestValue as ScheduledTaskRpcCronPreviewRequest;
      if (
        (response as ScheduledTaskRpcCronPreviewResponse).dates.length >
          (previewRequest.count ?? SCHEDULED_TASK_RPC_DEFAULTS.cronPreviewCount)
      ) fail('response.dates');
      return;
    }
  }
}

/** The durable create adapter must stamp the authenticated caller as origin. */
export function assertScheduledTaskRpcResponseOrigin<M extends ScheduledTaskRpcMethod>(
  method: M,
  response: ScheduledTaskRpcResponse<M>,
  remotePeerId: string,
): void {
  if (
    method === SCHEDULED_TASK_RPC_METHODS.create &&
    (response as ScheduledTaskRpcCreateResponse).task.originNodeId !== remotePeerId
  ) {
    throw new Error('scheduled_task_origin_peer_mismatch');
  }
}

function requireStore(options: ScheduledTaskRpcHandlerOptions): ScheduledAgentTaskStore {
  if (!options.store) throw new Error('scheduled_task_store_unavailable');
  return options.store;
}

function scopedTaskResources(request: ScheduledTaskRpcScopedTaskRequest): ScheduledTaskRpcGrantResources {
  return {
    conversationId: request.agentInstanceId,
    definitionId: request.agentDefinitionId,
    executionNodeId: request.executionNodeId,
  };
}

function assertScopedTaskRequest(value: Record<string, unknown>, field: string): void {
  assertOnlyKeys(value, [
    'taskId',
    'agentInstanceId',
    'agentDefinitionId',
    'executionNodeId',
  ], field);
  assertIdentifier(value.taskId, `${field}.taskId`);
  assertIdentifier(value.agentInstanceId, `${field}.agentInstanceId`);
  assertIdentifier(value.agentDefinitionId, `${field}.agentDefinitionId`);
  assertIdentifier(value.executionNodeId, `${field}.executionNodeId`);
}

function assertCreateInput(value: unknown, field: string): asserts value is ScheduledTaskRpcCreateInput {
  const input = asRecord(value, field);
  assertOnlyKeys(input, [
    'agentInstanceId',
    'agentDefinitionId',
    'name',
    'schedule',
    'payload',
    'activeHoursStart',
    'activeHoursEnd',
    'createdBy',
    'enabled',
    'executionNodeId',
    'executionNodeLabel',
  ], field);
  assertIdentifier(input.agentInstanceId, `${field}.agentInstanceId`);
  assertIdentifier(input.agentDefinitionId, `${field}.agentDefinitionId`);
  assertBoundedString(input.name, `${field}.name`, SCHEDULED_TASK_RPC_LIMITS.nameCharacters);
  assertSchedule(input.schedule, `${field}.schedule`);
  optionalPayload(input.payload, `${field}.payload`, false);
  optionalActiveHour(input.activeHoursStart, `${field}.activeHoursStart`, false);
  optionalActiveHour(input.activeHoursEnd, `${field}.activeHoursEnd`, false);
  optionalBoundedString(
    input.createdBy,
    `${field}.createdBy`,
    SCHEDULED_TASK_RPC_LIMITS.creatorCharacters,
  );
  optionalBoolean(input.enabled, `${field}.enabled`);
  assertIdentifier(input.executionNodeId, `${field}.executionNodeId`);
  optionalBoundedString(
    input.executionNodeLabel,
    `${field}.executionNodeLabel`,
    SCHEDULED_TASK_RPC_LIMITS.labelCharacters,
  );
}

function assertUpdatePatch(value: unknown, field: string): asserts value is ScheduledTaskRpcUpdatePatch {
  const patch = asRecord(value, field);
  assertOnlyKeys(patch, [
    'name',
    'schedule',
    'payload',
    'activeHoursStart',
    'activeHoursEnd',
    'enabled',
    'executionNodeId',
    'executionNodeLabel',
  ], field);
  if (Object.keys(patch).length === 0) fail(field);
  optionalBoundedString(
    patch.name,
    `${field}.name`,
    SCHEDULED_TASK_RPC_LIMITS.nameCharacters,
  );
  if (patch.schedule !== undefined) assertSchedule(patch.schedule, `${field}.schedule`);
  optionalPayload(patch.payload, `${field}.payload`, true);
  optionalActiveHour(patch.activeHoursStart, `${field}.activeHoursStart`, true);
  optionalActiveHour(patch.activeHoursEnd, `${field}.activeHoursEnd`, true);
  optionalBoolean(patch.enabled, `${field}.enabled`);
  if (patch.executionNodeId !== undefined) {
    assertIdentifier(patch.executionNodeId, `${field}.executionNodeId`);
  }
  optionalNullableBoundedString(
    patch.executionNodeLabel,
    `${field}.executionNodeLabel`,
    SCHEDULED_TASK_RPC_LIMITS.labelCharacters,
  );
}

function assertScheduledTask(value: unknown, field: string): asserts value is ScheduledTask {
  const task = asRecord(value, field);
  assertOnlyKeys(task, [
    'id',
    'agentInstanceId',
    'agentDefinitionId',
    'name',
    'schedule',
    'payload',
    'activeHoursStart',
    'activeHoursEnd',
    'enabled',
    'createdBy',
    'state',
    'executionNodeId',
    'executionNodeLabel',
    'originNodeId',
    'updatedAt',
    'nextRunAt',
    'lastRunAt',
    'lastRunStatus',
    'lastError',
    'lastFailureAt',
    'consecutiveFailures',
    'nextRetryAt',
    'runCount',
    'maxRuns',
    'deleteAfterRun',
    'executionRevision',
    'occurrenceId',
    'occurrenceScheduledFor',
    'occurrenceAttempt',
  ], field);
  assertIdentifier(task.id, `${field}.id`);
  assertIdentifier(task.agentInstanceId, `${field}.agentInstanceId`);
  assertIdentifier(task.agentDefinitionId, `${field}.agentDefinitionId`);
  assertBoundedString(task.name, `${field}.name`, SCHEDULED_TASK_RPC_LIMITS.nameCharacters);
  assertSchedule(task.schedule, `${field}.schedule`);
  optionalPayload(task.payload, `${field}.payload`, false, true);
  optionalActiveHour(task.activeHoursStart, `${field}.activeHoursStart`, false);
  optionalActiveHour(task.activeHoursEnd, `${field}.activeHoursEnd`, false);
  if (typeof task.enabled !== 'boolean') fail(`${field}.enabled`);
  optionalBoundedString(
    task.createdBy,
    `${field}.createdBy`,
    SCHEDULED_TASK_RPC_LIMITS.creatorCharacters,
  );
  assertState(task.state, `${field}.state`);
  assertIdentifier(task.executionNodeId, `${field}.executionNodeId`);
  optionalBoundedString(
    task.executionNodeLabel,
    `${field}.executionNodeLabel`,
    SCHEDULED_TASK_RPC_LIMITS.labelCharacters,
  );
  assertIdentifier(task.originNodeId, `${field}.originNodeId`);
  if (task.updatedAt !== undefined) assertCanonicalDate(task.updatedAt, `${field}.updatedAt`);
  if (task.nextRunAt !== undefined) assertCanonicalDate(task.nextRunAt, `${field}.nextRunAt`);
  if (task.lastRunAt !== undefined) assertCanonicalDate(task.lastRunAt, `${field}.lastRunAt`);
  if (task.lastFailureAt !== undefined) assertCanonicalDate(task.lastFailureAt, `${field}.lastFailureAt`);
  if (task.nextRetryAt !== undefined) assertCanonicalDate(task.nextRetryAt, `${field}.nextRetryAt`);
  if (
    task.lastRunStatus !== undefined &&
    task.lastRunStatus !== 'succeeded' &&
    task.lastRunStatus !== 'failed'
  ) fail(`${field}.lastRunStatus`);
  optionalBoundedString(task.lastError, `${field}.lastError`, 1_024);
  optionalInteger(task.consecutiveFailures, `${field}.consecutiveFailures`, 0, 1_000_000);
  optionalInteger(task.runCount, `${field}.runCount`, 0, Number.MAX_SAFE_INTEGER);
  optionalInteger(task.maxRuns, `${field}.maxRuns`, 1, Number.MAX_SAFE_INTEGER);
  optionalBoolean(task.deleteAfterRun, `${field}.deleteAfterRun`);
  optionalInteger(task.executionRevision, `${field}.executionRevision`, 0, Number.MAX_SAFE_INTEGER);
  optionalBoundedString(task.occurrenceId, `${field}.occurrenceId`, 128);
  if (task.occurrenceScheduledFor !== undefined) {
    assertCanonicalDate(task.occurrenceScheduledFor, `${field}.occurrenceScheduledFor`);
  }
  optionalInteger(task.occurrenceAttempt, `${field}.occurrenceAttempt`, 0, 1_000_000);
}

function assertSchedule(value: unknown, field: string): asserts value is ScheduledTaskRpcSchedule {
  const schedule = asRecord(value, field);
  if (schedule.kind === 'cron') {
    assertOnlyKeys(schedule, ['kind', 'expression', 'timezone'], field);
    assertBoundedString(
      schedule.expression,
      `${field}.expression`,
      SCHEDULED_TASK_RPC_LIMITS.cronExpressionCharacters,
    );
    optionalBoundedString(
      schedule.timezone,
      `${field}.timezone`,
      SCHEDULED_TASK_RPC_LIMITS.timezoneCharacters,
    );
    return;
  }
  if (schedule.kind === 'at') {
    assertOnlyKeys(schedule, ['kind', 'wakeAtISO'], field);
    assertCanonicalDate(schedule.wakeAtISO, `${field}.wakeAtISO`);
    return;
  }
  fail(`${field}.kind`);
}

function optionalPayload(
  value: unknown,
  field: string,
  nullable: boolean,
  optionalMessage = false,
): void {
  if (value === undefined || nullable && value === null) return;
  const payload = asRecord(value, field);
  assertOnlyKeys(payload, ['message'], field);
  if (optionalMessage && payload.message === undefined) return;
  assertBoundedString(
    payload.message,
    `${field}.message`,
    SCHEDULED_TASK_RPC_LIMITS.messageCharacters,
    true,
  );
}

function optionalActiveHour(value: unknown, field: string, nullable: boolean): void {
  if (value === undefined || nullable && value === null) return;
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) fail(field);
}

function optionalStateList(value: unknown, field: string): void {
  if (value === undefined) return;
  assertArray(value, field);
  if (value.length === 0 || value.length > 5) fail(field);
  const seen = new Set<string>();
  for (const item of value) {
    assertState(item, `${field}[]`);
    if (seen.has(item)) fail(field);
    seen.add(item);
  }
}

function assertState(value: unknown, field: string): asserts value is ScheduledTaskState {
  if (
    value !== 'active' &&
    value !== 'paused' &&
    value !== 'completed' &&
    value !== 'cancelled' &&
    value !== 'archived'
  ) fail(field);
}

function assertCanonicalDates(values: unknown[], field: string): void {
  let previous: string | undefined;
  for (const value of values) {
    assertCanonicalDate(value, `${field}[]`);
    if (previous !== undefined && previous >= value) fail(field);
    previous = value;
  }
}

function assertCanonicalDate(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length > 64) fail(field);
  let canonical: string;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    fail(field);
  }
  if (canonical !== value) fail(field);
}

function assertTaskMatchesScopedRequest(
  task: ScheduledTask,
  request: Record<string, unknown>,
  field: string,
): void {
  if (
    task.id !== request.taskId ||
    task.agentInstanceId !== request.agentInstanceId ||
    task.agentDefinitionId !== request.agentDefinitionId ||
    task.executionNodeId !== request.executionNodeId
  ) fail(field);
}

function assertEditorInputIdentity(
  input: CreateScheduledTaskInput,
  options: { executionNodeId: string; originNodeId: string },
): void {
  if (input.executionNodeId !== options.executionNodeId) {
    throw new ScheduledTaskRpcProtocolError('input.executionNodeId');
  }
  if (input.originNodeId !== options.originNodeId) {
    throw new ScheduledTaskRpcProtocolError('input.originNodeId');
  }
  if (input.scheduleKind !== input.schedule.kind) {
    throw new ScheduledTaskRpcProtocolError('input.scheduleKind');
  }
}

function assertEditorPatchIdentity(
  input: Partial<CreateScheduledTaskInput>,
  task: ScheduledTask,
  options: { executionNodeId: string; originNodeId: string },
): void {
  if (input.agentInstanceId !== undefined && input.agentInstanceId !== task.agentInstanceId) {
    throw new ScheduledTaskRpcProtocolError('input.agentInstanceId');
  }
  if (input.agentDefinitionId !== undefined && input.agentDefinitionId !== task.agentDefinitionId) {
    throw new ScheduledTaskRpcProtocolError('input.agentDefinitionId');
  }
  if (input.executionNodeId !== undefined && input.executionNodeId !== options.executionNodeId) {
    throw new ScheduledTaskRpcProtocolError('input.executionNodeId');
  }
  if (input.originNodeId !== undefined && input.originNodeId !== options.originNodeId) {
    throw new ScheduledTaskRpcProtocolError('input.originNodeId');
  }
  if (
    input.scheduleKind !== undefined &&
    input.schedule !== undefined &&
    input.scheduleKind !== input.schedule.kind
  ) {
    throw new ScheduledTaskRpcProtocolError('input.scheduleKind');
  }
}

function createInputFromEditor(input: CreateScheduledTaskInput): ScheduledTaskRpcCreateInput {
  return {
    agentInstanceId: input.agentInstanceId,
    agentDefinitionId: input.agentDefinitionId,
    name: input.name,
    schedule: input.schedule,
    payload: input.payload,
    activeHoursStart: input.activeHoursStart,
    activeHoursEnd: input.activeHoursEnd,
    createdBy: input.createdBy,
    enabled: input.enabled,
    executionNodeId: input.executionNodeId,
    executionNodeLabel: input.executionNodeLabel,
  };
}

function updatePatchFromEditor(
  input: Partial<CreateScheduledTaskInput>,
): ScheduledTaskRpcUpdatePatch {
  const patch: ScheduledTaskRpcUpdatePatch = {};
  if (hasOwn(input, 'name')) patch.name = input.name;
  if (hasOwn(input, 'schedule')) patch.schedule = input.schedule;
  if (hasOwn(input, 'payload')) patch.payload = input.payload ?? null;
  if (hasOwn(input, 'activeHoursStart')) {
    patch.activeHoursStart = input.activeHoursStart ?? null;
  }
  if (hasOwn(input, 'activeHoursEnd')) patch.activeHoursEnd = input.activeHoursEnd ?? null;
  if (hasOwn(input, 'enabled')) patch.enabled = input.enabled;
  if (hasOwn(input, 'executionNodeId')) patch.executionNodeId = input.executionNodeId;
  if (hasOwn(input, 'executionNodeLabel')) {
    patch.executionNodeLabel = input.executionNodeLabel ?? null;
  }
  assertUpdatePatch(patch, 'request.patch');
  return patch;
}

function requireKnownTask(tasks: Map<string, ScheduledTask>, taskId: string): ScheduledTask {
  assertIdentifier(taskId, 'taskId');
  const task = tasks.get(taskId);
  if (!task) throw new Error('scheduled_task_scope_unavailable');
  return task;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(field);
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some(key => !allowedSet.has(key))) fail(field);
}

function assertArray(value: unknown, field: string): asserts value is unknown[] {
  if (!Array.isArray(value)) fail(field);
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > SCHEDULED_TASK_RPC_LIMITS.identifierCharacters ||
    value !== value.trim() ||
    hasAsciiControlText(value)
  ) fail(field);
}

function hasAsciiControlText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function assertBoundedString(
  value: unknown,
  field: string,
  maximum: number,
  allowEmpty = false,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum ||
    value.includes('\0')
  ) fail(field);
}

function optionalBoundedString(
  value: unknown,
  field: string,
  maximum: number,
): void {
  if (value !== undefined) assertBoundedString(value, field, maximum);
}

function optionalNullableBoundedString(
  value: unknown,
  field: string,
  maximum: number,
): void {
  if (value !== undefined && value !== null) assertBoundedString(value, field, maximum);
}

function optionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'boolean') fail(field);
}

function optionalInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): void {
  if (
    value !== undefined &&
    (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum)
  ) fail(field);
}

function fail(field: string): never {
  throw new ScheduledTaskRpcProtocolError(field);
}
