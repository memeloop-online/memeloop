import { OrchestrationError } from '../errors.js';
import type { LoopRunHandle, LoopRunOutcome, LoopRunStartRequest, LoopRuntimeDriver } from '../loopRuntimeDriver.js';

import { assertDriverRequestEnvelope, canonicalDriverValue, type DriverRequestEnvelope } from './driverRequest.js';
import type { LoopRuntimeCapabilities, LoopRuntimeManagementDriver, LoopRuntimePrepared, LoopRuntimePreparePayload, ManagedLoopRunStatus } from './loopRuntimeManagement.js';

interface PreparedExecution {
  handle: string;
  resourceUid: string;
  fencingEpoch: number;
  request: LoopRunStartRequest;
  inputFingerprint: string;
}

interface ActiveExecution {
  status: ManagedLoopRunStatus;
  handle: LoopRunHandle;
  terminal: Promise<ManagedLoopRunStatus>;
}

export interface ManagedLoopRuntimeExecutionRouteOptions extends Omit<ManagedLoopRuntimeAdapterOptions, 'resolveStartRequest'> {
  createPreparePayload(
    request: LoopRunStartRequest,
  ): LoopRuntimePreparePayload;
  createRequest<T>(
    request: LoopRunStartRequest,
    method: string,
    payload: T,
  ): DriverRequestEnvelope<T>;
}

export interface ManagedLoopRuntimeExecutionRoute {
  /** Existing controller-facing facade; every effect traverses management. */
  executionDriver: LoopRuntimeDriver;
  /** Complete management surface for host discovery and direct inspection. */
  managementDriver: LoopRuntimeManagementDriver;
}

export interface ManagedLoopRuntimeAdapterOptions {
  capabilities: LoopRuntimeCapabilities;
  resolveStartRequest(
    request: DriverRequestEnvelope<LoopRuntimePreparePayload>,
  ): Promise<LoopRunStartRequest>;
  now?: () => Date;
  requireCapability?: boolean;
  /** Trusted host verifier for the opaque capability on every lifecycle call. */
  authorizeRequest?: (
    request: DriverRequestEnvelope,
  ) => boolean | Promise<boolean>;
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
    Array.isArray(payload) ||
    Object.keys(payload).some((key) => key !== field) ||
    typeof (payload as Record<string, unknown>)[field] !== 'string' ||
    !(payload as Record<string, string>)[field] ||
    (payload as Record<string, string>)[field].length > 2048
  ) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: `loop runtime payload '${field}' is required`,
      retryable: false,
    });
  }
  return (payload as Record<string, string>)[field];
}

function validatePreparePayload(payload: LoopRuntimePreparePayload): void {
  const fields = [
    'runtimeClass',
    'runtimeDigest',
    'scriptDigest',
    'isolation',
    'trustClass',
  ];
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).some((key) => !fields.includes(key)) ||
    typeof payload.runtimeClass !== 'string' ||
    !payload.runtimeClass ||
    payload.runtimeClass.length > 256 ||
    !/^sha256:[a-f0-9]{64}$/.test(payload.runtimeDigest) ||
    (payload.scriptDigest !== undefined &&
      !/^sha256:[a-f0-9]{64}$/.test(payload.scriptDigest)) ||
    !['none', 'process', 'container', 'wasm', 'remote'].includes(
      payload.isolation,
    ) ||
    !['trusted', 'restricted', 'quarantine'].includes(payload.trustClass)
  ) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: 'loop runtime prepare payload is malformed or unsupported',
      retryable: false,
    });
  }
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
    options.capabilities.threatAssumptions.length === 0 ||
    ((options.requireCapability ?? true) && !options.authorizeRequest)
  ) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: 'narrow LoopRuntime adapter capabilities overstate its process-local lifecycle or omit capability verification',
      retryable: false,
    });
  }
  const now = options.now ?? (() => new Date());
  const preparations = new Map<string, PreparedExecution>();
  const active = new Map<string, ActiveExecution>();
  const idempotency = new Map<string, string>();
  const idempotencyInputs = new Map<string, string>();
  const fences = new Map<string, number>();
  let nextHandle = 1;

  async function validate<T>(
    request: DriverRequestEnvelope<T>,
    expectedMethod: string,
  ): Promise<number> {
    assertDriverRequestEnvelope<T>(request, {
      now,
      requireRun: true,
      requireFencing: true,
      requireCapability: options.requireCapability ?? true,
      expectedMethod,
    });
    if (
      options.authorizeRequest &&
      !await options.authorizeRequest(request)
    ) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: 'loop runtime capability was rejected by the trusted host',
        retryable: false,
      });
    }
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
      return structuredClone(options.capabilities);
    },
    async prepare(request): Promise<LoopRuntimePrepared> {
      const fencingEpoch = await validate(request, 'loop.prepare');
      validatePreparePayload(request.payload);
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
      const inputFingerprint = canonicalDriverValue({
        resource: request.resource,
        run: request.run,
        session: request.session,
        capabilityHandleRef: request.capabilityHandleRef,
        payloadSchemaDigest: request.payloadSchemaDigest,
        payload: request.payload,
      });
      const existing = idempotency.get(key);
      if (existing) {
        if (idempotencyInputs.get(key) !== inputFingerprint) {
          throw new OrchestrationError({
            code: 'CONFLICT',
            message: 'loop runtime prepare idempotency input drifted',
            retryable: false,
          });
        }
        return { preparationHandle: existing };
      }
      const startRequest = await options.resolveStartRequest(request);
      if (
        startRequest.run.metadata.uid !== request.run?.uid ||
        startRequest.run.metadata.uid !== request.resource.uid ||
        startRequest.run.apiVersion !== request.resource.apiVersion ||
        startRequest.run.kind !== request.resource.kind ||
        startRequest.run.metadata.name !== request.resource.name ||
        startRequest.run.metadata.generation !== request.resource.generation
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
        inputFingerprint,
      });
      idempotency.set(key, handle);
      idempotencyInputs.set(key, inputFingerprint);
      return { preparationHandle: handle };
    },
    async start(request) {
      const fencingEpoch = await validate(request, 'loop.start');
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
      const inputFingerprint = canonicalDriverValue({
        resource: request.resource,
        run: request.run,
        session: request.session,
        capabilityHandleRef: request.capabilityHandleRef,
        payloadSchemaDigest: request.payloadSchemaDigest,
        payload: request.payload,
      });
      const existing = idempotency.get(key);
      if (existing) {
        if (idempotencyInputs.get(key) !== inputFingerprint) {
          throw new OrchestrationError({
            code: 'CONFLICT',
            message: 'loop runtime start idempotency input drifted',
            retryable: false,
          });
        }
        return scopedActive(existing, request.resource.uid).status;
      }

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
          ...(outcome.summary !== undefined
            ? { summary: outcome.summary }
            : {}),
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        };
        record.status = status;
        return status;
      }, (error: unknown) => {
        const status: ManagedLoopRunStatus = {
          ...running,
          phase: 'Failed',
          updatedAt: now().toISOString(),
          error: {
            code: error instanceof OrchestrationError ? error.code : 'INTERNAL',
            message: error instanceof Error ? error.message : String(error),
            retryable: error instanceof OrchestrationError && error.retryable,
          },
        };
        record.status = status;
        return status;
      });
      Object.assign(record, { status: running, handle, terminal });
      active.set(runHandle, record);
      idempotency.set(key, runHandle);
      idempotencyInputs.set(key, inputFingerprint);
      return running;
    },
    async *watch(request) {
      await validate(request, 'loop.watch');
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
      await validate(request, 'loop.checkpoint');
      return unsupported('checkpoint');
    },
    async restore(request) {
      await validate(request, 'loop.restore');
      return unsupported('restore');
    },
    async cancel(request) {
      const fencingEpoch = await validate(request, 'loop.cancel');
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
      await validate(request, 'loop.inspect');
      const handle = requireHandle(request.payload, 'runHandle');
      const execution = active.get(handle);
      return execution ? scopedActive(handle, request.resource.uid).status : undefined;
    },
    async adopt(request) {
      await validate(request, 'loop.adopt');
      return unsupported('adoption');
    },
    async delete(request) {
      await validate(request, 'loop.delete');
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

/**
 * Route the existing controller-facing execution facade through the complete
 * managed protocol without persisting ephemeral launch material in resources.
 */
export function createManagedLoopRuntimeExecutionRoute(
  executionDriver: LoopRuntimeDriver,
  options: ManagedLoopRuntimeExecutionRouteOptions,
): ManagedLoopRuntimeExecutionRoute {
  const pending = new Map<string, LoopRunStartRequest>();
  const managementDriver = createManagedLoopRuntimeAdapter(executionDriver, {
    capabilities: options.capabilities,
    ...(options.now ? { now: options.now } : {}),
    ...(options.requireCapability !== undefined
      ? { requireCapability: options.requireCapability }
      : {}),
    ...(options.authorizeRequest
      ? { authorizeRequest: options.authorizeRequest }
      : {}),
    resolveStartRequest: async (request) => {
      const startRequest = pending.get(request.resource.uid);
      if (!startRequest) {
        throw new OrchestrationError({
          code: 'NOT_FOUND',
          message: 'loop runtime launch material is no longer available',
          retryable: false,
        });
      }
      return startRequest;
    },
  });

  const executionFacade: LoopRuntimeDriver = {
    async start(startRequest) {
      const resourceUid = startRequest.run.metadata.uid;
      if (!resourceUid) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: 'managed loop execution requires an immutable AgentRun UID',
          retryable: false,
        });
      }
      if (pending.has(resourceUid)) {
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: `AgentRun '${resourceUid}' is already preparing`,
          retryable: true,
        });
      }
      pending.set(resourceUid, startRequest);
      let prepared: LoopRuntimePrepared;
      try {
        prepared = await managementDriver.prepare(options.createRequest(
          startRequest,
          'loop.prepare',
          options.createPreparePayload(startRequest),
        ));
      } finally {
        pending.delete(resourceUid);
      }
      const running = await managementDriver.start(options.createRequest(
        startRequest,
        'loop.start',
        prepared,
      ));
      return {
        async wait(): Promise<LoopRunOutcome> {
          let terminal: ManagedLoopRunStatus | undefined;
          for await (
            const status of managementDriver.watch(options.createRequest(
              startRequest,
              'loop.watch',
              { runHandle: running.runHandle },
            ))
          ) {
            terminal = status;
          }
          if (
            !terminal ||
            !['Completed', 'Failed', 'Cancelled'].includes(terminal.phase)
          ) {
            throw new OrchestrationError({
              code: 'UNAVAILABLE',
              message: 'managed loop runtime ended without a terminal status',
              retryable: true,
            });
          }
          return {
            phase: terminal.phase as LoopRunOutcome['phase'],
            ...(terminal.summary !== undefined
              ? { summary: terminal.summary }
              : {}),
            ...(terminal.error !== undefined ? { error: terminal.error } : {}),
          };
        },
        async cancel(): Promise<void> {
          await managementDriver.cancel(options.createRequest(
            startRequest,
            'loop.cancel',
            { runHandle: running.runHandle },
          ));
        },
      };
    },
  };

  return {
    executionDriver: executionFacade,
    managementDriver,
  };
}
