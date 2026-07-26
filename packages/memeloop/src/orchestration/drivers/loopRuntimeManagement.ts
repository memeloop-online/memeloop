import { OrchestrationError } from '../errors.js';
import type { NodeTrustClass } from '../resources.js';

import type { DriverConformanceSuite } from './driverConformance.js';
import { assertDriverRequestEnvelope, type DriverRequestEnvelope } from './driverRequest.js';

export interface LoopRuntimeCapabilities {
  name: string;
  isolation: Array<'none' | 'process' | 'container' | 'wasm' | 'remote'>;
  supportedTrustClasses: NodeTrustClass[];
  supportsCheckpoint: boolean;
  supportsRestore: boolean;
  supportsAdoption: boolean;
  persistence: 'none' | 'process' | 'host' | 'external';
  threatAssumptions: string[];
}

export interface LoopRuntimePreparePayload {
  runtimeClass: string;
  runtimeDigest: string;
  scriptDigest?: string;
  isolation: LoopRuntimeCapabilities['isolation'][number];
  trustClass: NodeTrustClass;
}

export interface LoopRuntimePrepared {
  preparationHandle: string;
}

export interface LoopRuntimeStartPayload {
  preparationHandle: string;
}

export interface ManagedLoopRunStatus {
  runHandle: string;
  resourceUid: string;
  phase: 'Prepared' | 'Running' | 'Completed' | 'Failed' | 'Cancelled';
  fencingEpoch: number;
  updatedAt: string;
  summary?: string;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface LoopRuntimeCheckpoint {
  checkpointHandle: string;
  runHandle: string;
  resourceUid: string;
  createdAt: string;
}

export interface LoopRuntimeManagementDriver {
  getCapabilities(): Promise<LoopRuntimeCapabilities>;
  prepare(
    request: DriverRequestEnvelope<LoopRuntimePreparePayload>,
  ): Promise<LoopRuntimePrepared>;
  start(
    request: DriverRequestEnvelope<LoopRuntimeStartPayload>,
  ): Promise<ManagedLoopRunStatus>;
  watch(
    request: DriverRequestEnvelope<{ runHandle: string }>,
  ): AsyncIterable<ManagedLoopRunStatus>;
  checkpoint(
    request: DriverRequestEnvelope<{ runHandle: string }>,
  ): Promise<LoopRuntimeCheckpoint>;
  restore(
    request: DriverRequestEnvelope<{ checkpointHandle: string }>,
  ): Promise<ManagedLoopRunStatus>;
  cancel(
    request: DriverRequestEnvelope<{ runHandle: string }>,
  ): Promise<ManagedLoopRunStatus>;
  inspect(
    request: DriverRequestEnvelope<{ runHandle: string }>,
  ): Promise<ManagedLoopRunStatus | undefined>;
  adopt(
    request: DriverRequestEnvelope<{ runHandle: string }>,
  ): Promise<ManagedLoopRunStatus>;
  delete(request: DriverRequestEnvelope<{ runHandle: string }>): Promise<void>;
}

interface PreparationRecord {
  handle: string;
  resourceUid: string;
  fence: number;
}

export interface FakeLoopRuntimeState {
  preparations: Map<string, PreparationRecord>;
  runs: Map<string, ManagedLoopRunStatus>;
  checkpoints: Map<string, LoopRuntimeCheckpoint>;
  idempotency: Map<string, string>;
  fences: Map<string, number>;
  nextHandle: number;
}

export function createFakeLoopRuntimeState(): FakeLoopRuntimeState {
  return {
    preparations: new Map(),
    runs: new Map(),
    checkpoints: new Map(),
    idempotency: new Map(),
    fences: new Map(),
    nextHandle: 1,
  };
}

function requiredHandle(payload: unknown, field: string): string {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof (payload as Record<string, unknown>)[field] !== 'string' ||
    !(payload as Record<string, string>)[field]
  ) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: `loop runtime payload '${field}' is required`,
      retryable: false,
    });
  }
  return (payload as Record<string, string>)[field];
}

/**
 * Stateful portable reference driver. Supplying the same state to a new
 * instance simulates a driver-host restart and makes adoption testable.
 */
export function createFakeLoopRuntimeManagementDriver(options: {
  state?: FakeLoopRuntimeState;
  now?: () => Date;
} = {}): LoopRuntimeManagementDriver {
  const state = options.state ?? createFakeLoopRuntimeState();
  const now = options.now ?? (() => new Date());

  function validate<T>(
    request: DriverRequestEnvelope<T>,
    expectedMethod: string,
  ): number {
    assertDriverRequestEnvelope<T>(request, {
      now,
      requireRun: true,
      requireFencing: true,
      requireCapability: true,
      expectedMethod,
    });
    const fence = request.fencingEpoch as number;
    const current = state.fences.get(request.resource.uid) ?? 0;
    if (fence < current) {
      throw new OrchestrationError({
        code: 'STALE_EPOCH',
        message: `stale loop runtime fencing epoch ${fence}; current epoch is ${current}`,
        retryable: false,
      });
    }
    state.fences.set(request.resource.uid, fence);
    return fence;
  }

  function nextHandle(prefix: string): string {
    const handle = `${prefix}:${state.nextHandle}`;
    state.nextHandle += 1;
    return handle;
  }

  function getRun(handle: string, resourceUid: string): ManagedLoopRunStatus {
    const status = state.runs.get(handle);
    if (!status) {
      throw new OrchestrationError({
        code: 'NOT_FOUND',
        message: `loop runtime handle '${handle}' was not found`,
        retryable: false,
      });
    }
    if (status.resourceUid !== resourceUid) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `loop runtime handle '${handle}' belongs to another resource`,
        retryable: false,
      });
    }
    return status;
  }

  function idempotencyKey(
    request: DriverRequestEnvelope,
    operation: string,
  ): string {
    return `${request.resource.uid}:${operation}:${request.idempotencyKey}`;
  }

  return {
    async getCapabilities() {
      return {
        name: 'fake-managed-loop-runtime',
        isolation: ['process'],
        supportedTrustClasses: ['trusted', 'restricted'],
        supportsCheckpoint: true,
        supportsRestore: true,
        supportsAdoption: true,
        persistence: 'host',
        threatAssumptions: ['the fake state port is durable and trusted'],
      };
    },
    async prepare(request) {
      const fence = validate(request, 'loop.prepare');
      const idempotency = idempotencyKey(request, 'prepare');
      const existing = state.idempotency.get(idempotency);
      if (existing) return { preparationHandle: existing };
      if (
        !request.payload.runtimeClass ||
        !request.payload.runtimeDigest ||
        !request.payload.isolation ||
        !request.payload.trustClass
      ) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: 'loop runtime preparation is incomplete',
          retryable: false,
        });
      }
      const handle = nextHandle('loop-preparation');
      state.preparations.set(handle, {
        handle,
        resourceUid: request.resource.uid,
        fence,
      });
      state.idempotency.set(idempotency, handle);
      return { preparationHandle: handle };
    },
    async start(request) {
      const fence = validate(request, 'loop.start');
      const preparationHandle = requiredHandle(request.payload, 'preparationHandle');
      const preparation = state.preparations.get(preparationHandle);
      if (!preparation || preparation.resourceUid !== request.resource.uid) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'preparation handle is stale or belongs to another resource',
          retryable: false,
        });
      }
      if (preparation.fence !== fence) {
        throw new OrchestrationError({
          code: 'STALE_EPOCH',
          message: `preparation handle was issued at fencing epoch ${preparation.fence}, not ${fence}`,
          retryable: false,
        });
      }
      const idempotency = idempotencyKey(request, 'start');
      const existing = state.idempotency.get(idempotency);
      if (existing) return getRun(existing, request.resource.uid);
      const runHandle = nextHandle('loop-run');
      const status: ManagedLoopRunStatus = {
        runHandle,
        resourceUid: request.resource.uid,
        phase: 'Running',
        fencingEpoch: fence,
        updatedAt: now().toISOString(),
      };
      state.runs.set(runHandle, status);
      state.idempotency.set(idempotency, runHandle);
      return status;
    },
    async *watch(request) {
      validate(request, 'loop.watch');
      yield getRun(
        requiredHandle(request.payload, 'runHandle'),
        request.resource.uid,
      );
    },
    async checkpoint(request) {
      validate(request, 'loop.checkpoint');
      const runHandle = requiredHandle(request.payload, 'runHandle');
      getRun(runHandle, request.resource.uid);
      const idempotency = idempotencyKey(request, 'checkpoint');
      const existing = state.idempotency.get(idempotency);
      if (existing) return state.checkpoints.get(existing) as LoopRuntimeCheckpoint;
      const checkpoint: LoopRuntimeCheckpoint = {
        checkpointHandle: nextHandle('loop-checkpoint'),
        runHandle,
        resourceUid: request.resource.uid,
        createdAt: now().toISOString(),
      };
      state.checkpoints.set(checkpoint.checkpointHandle, checkpoint);
      state.idempotency.set(idempotency, checkpoint.checkpointHandle);
      return checkpoint;
    },
    async restore(request) {
      const fence = validate(request, 'loop.restore');
      const checkpointHandle = requiredHandle(request.payload, 'checkpointHandle');
      const checkpoint = state.checkpoints.get(checkpointHandle);
      if (!checkpoint) {
        throw new OrchestrationError({
          code: 'NOT_FOUND',
          message: `checkpoint '${checkpointHandle}' was not found`,
          retryable: false,
        });
      }
      if (checkpoint.resourceUid !== request.resource.uid) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: `checkpoint '${checkpointHandle}' belongs to another resource`,
          retryable: false,
        });
      }
      const idempotency = idempotencyKey(request, 'restore');
      const existing = state.idempotency.get(idempotency);
      if (existing) return getRun(existing, request.resource.uid);
      const runHandle = nextHandle('loop-run');
      const status: ManagedLoopRunStatus = {
        runHandle,
        resourceUid: request.resource.uid,
        phase: 'Running',
        fencingEpoch: fence,
        updatedAt: now().toISOString(),
      };
      state.runs.set(runHandle, status);
      state.idempotency.set(idempotency, runHandle);
      return status;
    },
    async cancel(request) {
      const fence = validate(request, 'loop.cancel');
      const run = getRun(
        requiredHandle(request.payload, 'runHandle'),
        request.resource.uid,
      );
      const cancelled: ManagedLoopRunStatus = {
        ...run,
        phase: 'Cancelled',
        fencingEpoch: fence,
        updatedAt: now().toISOString(),
      };
      state.runs.set(run.runHandle, cancelled);
      return cancelled;
    },
    async inspect(request) {
      validate(request, 'loop.inspect');
      const handle = requiredHandle(request.payload, 'runHandle');
      const run = state.runs.get(handle);
      return run ? getRun(handle, request.resource.uid) : undefined;
    },
    async adopt(request) {
      validate(request, 'loop.adopt');
      return getRun(
        requiredHandle(request.payload, 'runHandle'),
        request.resource.uid,
      );
    },
    async delete(request) {
      validate(request, 'loop.delete');
      const handle = requiredHandle(request.payload, 'runHandle');
      const run = state.runs.get(handle);
      if (!run) return;
      getRun(handle, request.resource.uid);
      state.runs.delete(handle);
    },
  };
}

export function createLoopRuntimeManagementConformanceSuite(options: {
  createRequest<T>(
    method: string,
    payload: T,
    idempotencyKey: string,
    fencingEpoch?: number,
    resourceUid?: string,
  ): DriverRequestEnvelope<T>;
  recreate(driver: LoopRuntimeManagementDriver): LoopRuntimeManagementDriver;
}): DriverConformanceSuite {
  return {
    interfaceKind: 'loop-runtime',
    tests: [
      {
        name: 'declares lifecycle and threat capabilities',
        description: 'Capabilities explicitly report adoption, persistence, trust, and threat assumptions',
        run: async (value) => {
          const capabilities = await (value as LoopRuntimeManagementDriver).getCapabilities();
          if (!capabilities.name || !capabilities.isolation.length) throw new Error('runtime capabilities are incomplete');
          if (!capabilities.supportedTrustClasses.length) throw new Error('runtime trust classes are missing');
          if (!capabilities.threatAssumptions.length) throw new Error('runtime threat assumptions are missing');
        },
      },
      {
        name: 'prepare and start are idempotent',
        description: 'Duplicate operation keys return the same opaque handles',
        run: async (value) => {
          const driver = value as LoopRuntimeManagementDriver;
          const prepare = options.createRequest('loop.prepare', {
            runtimeClass: 'restricted-process',
            runtimeDigest: `sha256:${'a'.repeat(64)}`,
            isolation: 'process' as const,
            trustClass: 'restricted' as const,
          }, 'prepare-1');
          const firstPreparation = await driver.prepare(prepare);
          const secondPreparation = await driver.prepare(prepare);
          if (firstPreparation.preparationHandle !== secondPreparation.preparationHandle) {
            throw new Error('prepare is not idempotent');
          }
          const start = options.createRequest('loop.start', firstPreparation, 'start-1');
          const firstRun = await driver.start(start);
          const secondRun = await driver.start(start);
          if (firstRun.runHandle !== secondRun.runHandle) throw new Error('start is not idempotent');
        },
      },
      {
        name: 'checkpoint, restore, cancel, inspect, and delete converge',
        description: 'The managed lifecycle is complete and uses opaque handles',
        run: async (value) => {
          const driver = value as LoopRuntimeManagementDriver;
          const prepared = await driver.prepare(options.createRequest('loop.prepare', {
            runtimeClass: 'restricted-process',
            runtimeDigest: `sha256:${'b'.repeat(64)}`,
            isolation: 'process' as const,
            trustClass: 'restricted' as const,
          }, 'prepare-lifecycle'));
          const running = await driver.start(options.createRequest('loop.start', prepared, 'start-lifecycle'));
          const checkpoint = await driver.checkpoint(options.createRequest(
            'loop.checkpoint',
            { runHandle: running.runHandle },
            'checkpoint-lifecycle',
          ));
          const restored = await driver.restore(options.createRequest(
            'loop.restore',
            { checkpointHandle: checkpoint.checkpointHandle },
            'restore-lifecycle',
          ));
          const watched: ManagedLoopRunStatus[] = [];
          for await (
            const status of driver.watch(options.createRequest(
              'loop.watch',
              { runHandle: restored.runHandle },
              'watch-lifecycle',
            ))
          ) watched.push(status);
          if (watched.at(-1)?.phase !== 'Running') throw new Error('watch did not report Running');
          const cancelled = await driver.cancel(options.createRequest(
            'loop.cancel',
            { runHandle: restored.runHandle },
            'cancel-lifecycle',
          ));
          if (cancelled.phase !== 'Cancelled') throw new Error('cancel did not converge');
          await driver.delete(options.createRequest(
            'loop.delete',
            { runHandle: restored.runHandle },
            'delete-lifecycle',
          ));
          const inspected = await driver.inspect(options.createRequest(
            'loop.inspect',
            { runHandle: restored.runHandle },
            'inspect-lifecycle',
          ));
          if (inspected !== undefined) throw new Error('delete did not remove the run');
        },
      },
      {
        name: 'scopes opaque handles and idempotency to the resource UID',
        description: 'A different resource cannot inspect, cancel, restore, or deduplicate another resource handle',
        run: async (value) => {
          const driver = value as LoopRuntimeManagementDriver;
          const prepared = await driver.prepare(options.createRequest(
            'loop.prepare',
            {
              runtimeClass: 'restricted-process',
              runtimeDigest: `sha256:${'e'.repeat(64)}`,
              isolation: 'process' as const,
              trustClass: 'restricted' as const,
            },
            'same-key',
            6,
            'resource-a',
          ));
          const running = await driver.start(options.createRequest(
            'loop.start',
            prepared,
            'same-key',
            6,
            'resource-a',
          ));
          const otherPreparation = await driver.prepare(options.createRequest(
            'loop.prepare',
            {
              runtimeClass: 'restricted-process',
              runtimeDigest: `sha256:${'e'.repeat(64)}`,
              isolation: 'process' as const,
              trustClass: 'restricted' as const,
            },
            'same-key',
            6,
            'resource-b',
          ));
          if (otherPreparation.preparationHandle === prepared.preparationHandle) {
            throw new Error('idempotency key crossed the resource boundary');
          }
          let rejected = false;
          try {
            await driver.inspect(options.createRequest(
              'loop.inspect',
              { runHandle: running.runHandle },
              'inspect-other',
              6,
              'resource-b',
            ));
          } catch (error) {
            rejected = error instanceof OrchestrationError && error.code === 'FORBIDDEN';
          }
          if (!rejected) throw new Error('cross-resource opaque handle was accepted');
        },
      },
      {
        name: 'adopts a pre-restart run and rejects stale fencing',
        description: 'A recreated host discovers durable runs and stale controllers fail closed',
        run: async (value) => {
          const driver = value as LoopRuntimeManagementDriver;
          const prepared = await driver.prepare(options.createRequest(
            'loop.prepare',
            {
              runtimeClass: 'restricted-process',
              runtimeDigest: `sha256:${'c'.repeat(64)}`,
              isolation: 'process' as const,
              trustClass: 'restricted' as const,
            },
            'prepare-adopt',
            4,
          ));
          const running = await driver.start(options.createRequest('loop.start', prepared, 'start-adopt', 4));
          const restarted = options.recreate(driver);
          const adopted = await restarted.adopt(options.createRequest(
            'loop.adopt',
            { runHandle: running.runHandle },
            'adopt-1',
            5,
          ));
          if (adopted.runHandle !== running.runHandle) throw new Error('run was not adopted');
          let staleRejected = false;
          try {
            await restarted.inspect(options.createRequest(
              'loop.inspect',
              { runHandle: running.runHandle },
              'inspect-stale',
              3,
            ));
          } catch (error) {
            staleRejected = error instanceof OrchestrationError && error.code === 'STALE_EPOCH';
          }
          if (!staleRejected) throw new Error('stale fencing epoch was accepted');
        },
      },
    ],
  };
}
