import { OrchestrationError } from '../errors.js';
import type { LoopRunHandle, LoopRunOutcome, LoopRunStartRequest, LoopRuntimeDriver } from '../loopRuntimeDriver.js';

import { assertDriverRequestEnvelope, type DriverRequestEnvelope } from './driverRequest.js';
import type { LoopRuntimeCapabilities, LoopRuntimeManagementDriver, LoopRuntimePrepared, LoopRuntimePreparePayload, ManagedLoopRunStatus } from './loopRuntimeManagement.js';

interface PreparedExecution {
  handle: string;
  resourceUid: string;
  fencingEpoch: number;
  request: LoopRunStartRequest;
}

interface ActiveExecution {
  status: ManagedLoopRunStatus;
  handle: LoopRunHandle;
  terminal: Promise<ManagedLoopRunStatus>;
}

export interface ManagedLoopRuntimeAdapterOptions {
  capabilities: LoopRuntimeCapabilities;
  resolveStartRequest(
    request: DriverRequestEnvelope<LoopRuntimePreparePayload>,
  ): Promise<LoopRunStartRequest>;
  now?: () => Date;
  requireCapability?: boolean;
}

function unsupported(operation: string): never {
  throw new OrchestrationError({
    code: 'UNSUPPORTED',
    message: `loop runtime adapter does not support ${operation}`,
    retryable: false,
  });
}

function requireHandle(payload: unknown, field: string): string {
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

function terminalPhase(outcome: LoopRunOutcome): ManagedLoopRunStatus['phase'] {
  return outcome.phase;
}

/**
 * Adapt the production narrow execution facade to the complete management
 * protocol without overstating crash/checkpoint support. Live handles remain
 * host-memory state, so adoption, checkpoint and restore fail UNSUPPORTED.
 */
export function createManagedLoopRuntimeAdapter(
  executionDriver: LoopRuntimeDriver,
  options: ManagedLoopRuntimeAdapterOptions,
): LoopRuntimeManagementDriver {
  if (
    options.capabilities.supportsCheckpoint ||
    options.capabilities.supportsRestore ||
    options.capabilities.supportsAdoption ||
    options.capabilities.persistence !== 'process' ||
    options.capabilities.isolation.length === 0 ||
    options.capabilities.supportedTrustClasses.length === 0 ||
    options.capabilities.threatAssumptions.length === 0
  ) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: 'narrow LoopRuntime adapter capabilities overstate its process-local lifecycle',
      retryable: false,
    });
  }
  const now = options.now ?? (() => new Date());
  const preparations = new Map<string, PreparedExecution>();
  const active = new Map<string, ActiveExecution>();
  const idempotency = new Map<string, string>();
  const fences = new Map<string, number>();
  let nextHandle = 1;

  function validate<T>(
    request: DriverRequestEnvelope<T>,
    expectedMethod: string,
  ): number {
    assertDriverRequestEnvelope<T>(request, {
      now,
      requireRun: true,
      requireFencing: true,
      requireCapability: options.requireCapability ?? true,
      expectedMethod,
    });
    const fencingEpoch = request.fencingEpoch as number;
    const current = fences.get(request.resource.uid) ?? 0;
    if (fencingEpoch < current) {
      throw new OrchestrationError({
        code: 'STALE_EPOCH',
        message: `stale loop runtime fencing epoch ${fencingEpoch}; current epoch is ${current}`,
        retryable: false,
      });
    }
    fences.set(request.resource.uid, fencingEpoch);
    return fencingEpoch;
  }

  function idempotencyKey(
    request: DriverRequestEnvelope,
    operation: string,
  ): string {
    return `${request.resource.uid}:${operation}:${request.idempotencyKey}`;
  }

  function opaque(prefix: string): string {
    const result = `${prefix}:${nextHandle}`;
    nextHandle += 1;
    return result;
  }

  function scopedActive(
    handle: string,
    resourceUid: string,
  ): ActiveExecution {
    const execution = active.get(handle);
    if (!execution) {
      throw new OrchestrationError({
        code: 'NOT_FOUND',
        message: `loop runtime handle '${handle}' was not found`,
        retryable: false,
      });
    }
    if (execution.status.resourceUid !== resourceUid) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `loop runtime handle '${handle}' belongs to another resource`,
        retryable: false,
      });
    }
    return execution;
  }

  async function awaitUntilDeadline<T>(
    promise: Promise<T>,
    deadline: string,
    operation: string,
  ): Promise<T> {
    const remaining = Date.parse(deadline) - now().getTime();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new OrchestrationError({
            code: 'TIMEOUT',
            message: `loop runtime ${operation} exceeded its deadline`,
            retryable: false,
          }),
        );
      }, remaining);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    async getCapabilities() {
      return options.capabilities;
    },
    async prepare(request): Promise<LoopRuntimePrepared> {
      const fencingEpoch = validate(request, 'loop.prepare');
      if (!options.capabilities.isolation.includes(request.payload.isolation)) {
        throw new OrchestrationError({
          code: 'UNSUPPORTED',
          message: `runtime isolation '${request.payload.isolation}' is unsupported`,
          retryable: false,
        });
      }
      if (!options.capabilities.supportedTrustClasses.includes(request.payload.trustClass)) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: `runtime trust class '${request.payload.trustClass}' is unsupported`,
          retryable: false,
        });
      }
      const key = idempotencyKey(request, 'prepare');
      const existing = idempotency.get(key);
      if (existing) return { preparationHandle: existing };
      const startRequest = await options.resolveStartRequest(request);
      if (
        startRequest.run.metadata.uid !== request.run?.uid ||
        startRequest.run.metadata.uid !== request.resource.uid
      ) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'resolved LoopRun identity does not match the management envelope',
          retryable: false,
        });
      }
      const handle = opaque('loop-preparation');
      preparations.set(handle, {
        handle,
        resourceUid: request.resource.uid,
        fencingEpoch,
        request: startRequest,
      });
      idempotency.set(key, handle);
      return { preparationHandle: handle };
    },
    async start(request) {
      const fencingEpoch = validate(request, 'loop.start');
      const preparationHandle = requireHandle(request.payload, 'preparationHandle');
      const preparation = preparations.get(preparationHandle);
      if (!preparation || preparation.resourceUid !== request.resource.uid) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'preparation handle is stale or belongs to another resource',
          retryable: false,
        });
      }
      if (preparation.fencingEpoch !== fencingEpoch) {
        throw new OrchestrationError({
          code: 'STALE_EPOCH',
          message: 'preparation handle belongs to another controller epoch',
          retryable: false,
        });
      }
      const key = idempotencyKey(request, 'start');
      const existing = idempotency.get(key);
      if (existing) return scopedActive(existing, request.resource.uid).status;

      const handle = await executionDriver.start(preparation.request);
      const runHandle = opaque('loop-run');
      const running: ManagedLoopRunStatus = {
        runHandle,
        resourceUid: request.resource.uid,
        phase: 'Running',
        fencingEpoch,
        updatedAt: now().toISOString(),
      };
      const record = {} as ActiveExecution;
      const terminal = handle.wait().then((outcome) => {
        const status: ManagedLoopRunStatus = {
          ...running,
          phase: terminalPhase(outcome),
          updatedAt: now().toISOString(),
        };
        record.status = status;
        return status;
      }, () => {
        const status: ManagedLoopRunStatus = {
          ...running,
          phase: 'Failed',
          updatedAt: now().toISOString(),
        };
        record.status = status;
        return status;
      });
      Object.assign(record, { status: running, handle, terminal });
      active.set(runHandle, record);
      idempotency.set(key, runHandle);
      return running;
    },
    async *watch(request) {
      validate(request, 'loop.watch');
      const execution = scopedActive(
        requireHandle(request.payload, 'runHandle'),
        request.resource.uid,
      );
      const waitForTerminal = execution.status.phase === 'Running';
      yield execution.status;
      if (waitForTerminal) {
        yield await awaitUntilDeadline(
          execution.terminal,
          request.deadline,
          'watch',
        );
      }
    },
    async checkpoint(request) {
      validate(request, 'loop.checkpoint');
      return unsupported('checkpoint');
    },
    async restore(request) {
      validate(request, 'loop.restore');
      return unsupported('restore');
    },
    async cancel(request) {
      const fencingEpoch = validate(request, 'loop.cancel');
      const execution = scopedActive(
        requireHandle(request.payload, 'runHandle'),
        request.resource.uid,
      );
      if (execution.status.phase === 'Running') {
        await execution.handle.cancel();
        const terminal = await awaitUntilDeadline(
          execution.terminal,
          request.deadline,
          'cancel',
        );
        execution.status = {
          ...terminal,
          fencingEpoch,
        };
      }
      return execution.status;
    },
    async inspect(request) {
      validate(request, 'loop.inspect');
      const handle = requireHandle(request.payload, 'runHandle');
      const execution = active.get(handle);
      return execution ? scopedActive(handle, request.resource.uid).status : undefined;
    },
    async adopt(request) {
      validate(request, 'loop.adopt');
      return unsupported('adoption');
    },
    async delete(request) {
      validate(request, 'loop.delete');
      const handle = requireHandle(request.payload, 'runHandle');
      const execution = active.get(handle);
      if (!execution) return;
      scopedActive(handle, request.resource.uid);
      if (execution.status.phase === 'Running') {
        await execution.handle.cancel();
        await awaitUntilDeadline(
          execution.terminal,
          request.deadline,
          'delete',
        );
      }
      active.delete(handle);
    },
  };
}
