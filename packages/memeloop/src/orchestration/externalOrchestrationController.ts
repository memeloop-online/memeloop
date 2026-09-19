import { safeErrorMessageFromUnknown } from '../safeError.js';

import type { OrchestrationResource, OrchestrationResourceReference, OrchestrationResourceStatus } from './client.js';
import type { ControlStore, ControlStoreActor } from './controlStore.js';
import type { ExternalDriverCapabilities, ExternalOrchestrationDriver, ExternalStatusResult, ExternalWorkerBootstrapSecret } from './drivers/externalDriver.js';
import { assertExternalToolOperationContract, assertExternalToolOperationResult, type ExternalToolContract } from './drivers/externalToolContract.js';
import { resolveExternalWorkloadResources, resolveExternalWorkloadRuntime } from './drivers/externalWorkloadContract.js';
import { OrchestrationError } from './errors.js';
import {
  AGENT_RUN_API_VERSION,
  AGENT_RUN_KIND,
  AGENT_WORKLOAD_API_VERSION,
  AGENT_WORKLOAD_KIND,
  type AgentRunStatus,
  type AgentWorkloadResource,
  type AgentWorkloadStatus,
  createAgentRunManifest,
  isAgentWorkload,
  isToolOperation,
  TOOL_OPERATION_API_VERSION,
  TOOL_OPERATION_KIND,
  type ToolOperationResource,
  type ToolOperationStatus,
} from './resources.js';
import { isCanonicalOrchestrationResource, requireCanonicalOrchestrationResource, requireCanonicalOrchestrationResourceOrNull } from './resourceValidation.js';
import { redactSecrets } from './security/secretRedaction.js';

export interface RegisteredExternalOrchestrationDriver {
  name: string;
  driver: ExternalOrchestrationDriver;
  capabilities: ExternalDriverCapabilities;
}

export interface ExternalOrchestrationControllerOptions {
  actor: ControlStoreActor;
  drivers: RegisteredExternalOrchestrationDriver[];
  pollIntervalMs?: number;
  statusWriteAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Resolve admitted script content without persisting it in ControlStore. */
  resolveScriptSource?: (scriptReference: string) => Promise<string | undefined>;
  /** Create a short-lived, single-use bootstrap secret at placement time. */
  createWorkerBootstrap?: (
    workload: AgentWorkloadResource,
    runReference: OrchestrationResourceReference,
  ) => Promise<ExternalWorkerBootstrapSecret | undefined>;
  /**
   * Host-bound policy/approval authority for external tool effects. The
   * controller fails closed when this hook is absent.
   */
  authorizeToolOperation?: (
    operation: ToolOperationResource,
    signal?: AbortSignal,
  ) => Promise<{ approval?: NonNullable<ToolOperationStatus['approval']> }>;
  /**
   * Host-bound admission for external workload placement. The returned
   * durable decision identity is persisted before the native side effect.
   */
  authorizeWorkloadPlacement?: (
    workload: AgentWorkloadResource,
    driver: RegisteredExternalOrchestrationDriver,
    signal?: AbortSignal,
  ) => Promise<{ decisionHandle: string; policyDigest: string }>;
  onError?: (error: unknown) => void;
}

export interface ExternalOrchestrationControllerHandle {
  stop(): Promise<void>;
}

type RoutedResource = AgentWorkloadResource | ToolOperationResource;

function isCanonicalAgentWorkload(value: unknown): value is AgentWorkloadResource {
  return isCanonicalOrchestrationResource(value) && isAgentWorkload(value);
}

function isCanonicalToolOperation(value: unknown): value is ToolOperationResource {
  return isCanonicalOrchestrationResource(value) && isToolOperation(value);
}

function isRoutedResource(value: unknown): value is RoutedResource {
  return isCanonicalAgentWorkload(value) || isCanonicalToolOperation(value);
}

/**
 * Reconcile explicitly external AgentWorkloads and ToolOperations through
 * registered optional drivers. Placement identity is persisted before status
 * polling, so controller restart adopts the native resource rather than
 * creating a second effect. Driver implementations must make placement
 * idempotent by MemeLoop resource UID.
 */
export function createExternalOrchestrationController(
  store: ControlStore,
  options: ExternalOrchestrationControllerOptions,
): ExternalOrchestrationControllerHandle {
  const drivers = new Map(options.drivers.map((entry) => [entry.name, entry]));
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const statusWriteAttempts = options.statusWriteAttempts ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const onError = options.onError ?? ((): void => {});
  const active = new Map<string, Promise<void>>();
  const activeByDriver = new Map<string, number>();
  const watchAbort = new AbortController();
  const stoppedError = new OrchestrationError({
    code: 'CANCELLED',
    message: 'external orchestration controller stopped',
    retryable: false,
  });
  let resolveStopped!: (value: { kind: 'stopped' }) => void;
  const stoppedBoundary = new Promise<{ kind: 'stopped' }>((resolve) => {
    resolveStopped = resolve;
  });
  let stopped = false;
  let stopPromise: Promise<void> | undefined;

  function throwIfStopped(): void {
    if (stopped) throw stoppedError;
  }

  /**
   * Bound an otherwise non-cancellable host/driver/store operation to this
   * controller generation. The underlying promise remains observed after an
   * abort, but its late result can no longer resume reconciliation and touch a
   * store that the host is entitled to close after stop() resolves.
   */
  async function whileRunning<T>(operation: () => Promise<T>): Promise<T> {
    throwIfStopped();
    const operationResult = Promise.resolve().then(operation).then(
      (value) => ({ kind: 'value' as const, value }),
      (error: unknown) => ({
        kind: 'error' as const,
        error: error instanceof Error ? error : new Error(safeErrorMessageFromUnknown(error)),
      }),
    );
    const result = await Promise.race([operationResult, stoppedBoundary]);
    if (result.kind === 'stopped') throw stoppedError;
    if (result.kind === 'error') throw result.error;
    return result.value;
  }

  function reportUnlessStopped(error: unknown): void {
    if (!stopped && error !== stoppedError) onError(error);
  }

  async function drainWithDeadline(tasks: Promise<unknown>[]): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(tasks).then(() => {}),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 1000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async function acquireDriverSlot(entry: RegisteredExternalOrchestrationDriver): Promise<boolean> {
    const limit = entry.capabilities.maxConcurrency;
    while (!stopped) {
      const current = activeByDriver.get(entry.name) ?? 0;
      if (limit === undefined || current < limit) {
        activeByDriver.set(entry.name, current + 1);
        return true;
      }
      await whileRunning(() => sleep(pollIntervalMs));
    }
    return false;
  }

  function releaseDriverSlot(name: string): void {
    const current = activeByDriver.get(name) ?? 0;
    if (current <= 1) activeByDriver.delete(name);
    else activeByDriver.set(name, current - 1);
  }

  function referenceOf(resource: RoutedResource): OrchestrationResourceReference {
    return {
      apiVersion: resource.apiVersion,
      kind: resource.kind,
      name: resource.metadata.name,
      namespace: resource.metadata.namespace,
    };
  }

  function routeOf(resource: RoutedResource): string | undefined {
    return isAgentWorkload(resource)
      ? resource.spec.placement?.orchestrator
      : resource.spec.placement?.orchestrator;
  }

  function runReferenceOf(workload: AgentWorkloadResource): OrchestrationResourceReference {
    return {
      apiVersion: AGENT_RUN_API_VERSION,
      kind: AGENT_RUN_KIND,
      name: `${workload.metadata.name}-run`,
      namespace: workload.metadata.namespace,
    };
  }

  async function ensureRun(workload: AgentWorkloadResource): Promise<OrchestrationResourceReference> {
    const reference = runReferenceOf(workload);
    if (await whileRunning(() => store.get(reference))) return reference;
    const manifest = createAgentRunManifest(reference.name!, {
      workloadRef: {
        apiVersion: workload.apiVersion,
        kind: workload.kind,
        name: workload.metadata.name,
        namespace: workload.metadata.namespace,
        uid: workload.metadata.uid,
      },
    });
    manifest.metadata.namespace = workload.metadata.namespace;
    try {
      await whileRunning(() => store.create(options.actor, manifest));
    } catch (error) {
      if (!(error instanceof OrchestrationError) || error.code !== 'CONFLICT') throw error;
    }
    return reference;
  }

  async function updateStatus<TStatus extends OrchestrationResourceStatus>(
    reference: OrchestrationResourceReference,
    patch: (current: TStatus | undefined) => TStatus,
  ): Promise<void> {
    for (let attempt = 0; attempt < statusWriteAttempts; attempt += 1) {
      const current = await whileRunning(() => store.get<Record<string, unknown>, TStatus>(reference));
      if (!current) return;
      try {
        await whileRunning(() =>
          store.updateStatus(options.actor, reference, patch(current.status), {
            resourceVersion: current.metadata.resourceVersion,
          })
        );
        return;
      } catch (error) {
        if (error instanceof OrchestrationError && error.code === 'CONFLICT') continue;
        throw error;
      }
    }
    throw new OrchestrationError({
      code: 'CONFLICT',
      message: `external status update for '${reference.name ?? ''}' exceeded ${statusWriteAttempts} CAS attempts`,
      retryable: true,
    });
  }

  function findDriver(resource: RoutedResource): RegisteredExternalOrchestrationDriver {
    const selected = routeOf(resource);
    const entry = selected ? drivers.get(selected) : undefined;
    if (!entry) {
      throw new OrchestrationError({
        code: 'NOT_FOUND',
        message: `external orchestrator '${selected ?? ''}' is not registered`,
        retryable: false,
      });
    }
    if (!entry.capabilities.manages.includes(resource.kind as 'AgentWorkload' | 'ToolOperation')) {
      throw new OrchestrationError({
        code: 'UNSUPPORTED',
        message: `external orchestrator '${selected}' does not manage ${resource.kind}`,
        retryable: false,
      });
    }
    if (!entry.capabilities.supportsAdoption) {
      throw new OrchestrationError({
        code: 'UNSUPPORTED',
        message: `external orchestrator '${selected}' cannot safely adopt placement after controller restart`,
        retryable: false,
      });
    }
    return entry;
  }

  async function fail(resource: RoutedResource, error: unknown): Promise<void> {
    throwIfStopped();
    const message = safeErrorMessageFromUnknown(error, { fallback: 'External orchestration failed' });
    if (isAgentWorkload(resource)) {
      await updateStatus<AgentRunStatus>(runReferenceOf(resource), () => ({
        phase: 'Failed',
        summary: message,
        exitCode: 1,
      }));
      await updateStatus<AgentWorkloadStatus>(referenceOf(resource), (current) => ({
        ...current,
        phase: 'Failed',
        lastRunResult: message,
      }));
    } else {
      await updateStatus<ToolOperationStatus>(referenceOf(resource), (current) => ({
        ...current,
        phase: 'Failed',
        result: {
          error: {
            code: error instanceof OrchestrationError ? error.code : 'INTERNAL',
            message,
            retryable: error instanceof OrchestrationError ? error.retryable : false,
          },
        },
        completedAt: now().toISOString(),
      }));
    }
  }

  async function reflectWorkloadStatus(
    resource: AgentWorkloadResource,
    external: ExternalStatusResult,
  ): Promise<boolean> {
    const terminal = external.phase === 'Succeeded' || external.phase === 'Failed' || external.phase === 'Cancelled';
    const missingResult = external.phase === 'Succeeded' && external.runtimeResult === undefined;
    const resultPhase = missingResult ? 'Failed' : external.runtimeResult?.phase;
    const succeeded = external.phase === 'Succeeded' && resultPhase === 'Completed';
    const cancelled = external.phase === 'Cancelled' || resultPhase === 'Cancelled';
    const message = redactSecrets(
      external.runtimeResult?.summary ??
        external.runtimeResult?.error?.message ??
        (missingResult ? 'external runtime completed without a valid MEMELOOP_RESULT' : external.message),
    );
    const runReference = runReferenceOf(resource);
    await updateStatus<AgentRunStatus>(runReference, () => ({
      phase: succeeded
        ? 'Completed'
        : cancelled
        ? 'Cancelled'
        : terminal
        ? 'Failed'
        : 'Running',
      ...(message !== undefined ? { summary: message } : {}),
      ...(terminal ? { exitCode: succeeded ? 0 : 1 } : {}),
    }));
    await updateStatus<AgentWorkloadStatus>(referenceOf(resource), (current) => ({
      ...current,
      phase: succeeded
        ? 'Completed'
        : terminal
        ? 'Failed'
        : external.phase === 'Pending'
        ? 'Scheduling'
        : 'Running',
      ...(message !== undefined ? { lastRunResult: message } : {}),
    }));
    return terminal;
  }

  async function reflectToolStatus(
    resource: ToolOperationResource,
    external: ExternalStatusResult,
    contract: ExternalToolContract,
  ): Promise<boolean> {
    const terminal = external.phase === 'Succeeded' || external.phase === 'Failed' || external.phase === 'Cancelled';
    const missingResult = external.phase === 'Succeeded' && external.runtimeResult === undefined;
    const resultPhase = missingResult ? 'Failed' : external.runtimeResult?.phase;
    const succeeded = external.phase === 'Succeeded' && resultPhase === 'Completed';
    const cancelled = external.phase === 'Cancelled' || resultPhase === 'Cancelled';
    const externalResult = succeeded && external.runtimeResult?.result
      ? redactSecrets(external.runtimeResult.result)
      : undefined;
    if (succeeded) {
      assertExternalToolOperationResult(
        contract,
        external.runtimeResult?.result?.value,
      );
    }
    const error = external.runtimeResult?.error ?? (missingResult
      ? { code: 'INVALID', message: 'external runtime completed without a valid MEMELOOP_RESULT', retryable: false }
      : external.phase === 'Failed'
      ? { code: 'INTERNAL', message: external.message ?? 'external tool operation failed', retryable: false }
      : undefined);
    await updateStatus<ToolOperationStatus>(referenceOf(resource), (current) => ({
      ...current,
      phase: succeeded
        ? 'Completed'
        : cancelled
        ? 'Cancelled'
        : terminal
        ? 'Failed'
        : external.phase === 'Pending'
        ? 'Pending'
        : 'Running',
      ...(externalResult ? { result: externalResult } : error ? { result: { error: redactSecrets(error) } } : {}),
      ...(terminal ? { completedAt: now().toISOString() } : {}),
    }));
    return terminal;
  }

  async function reconcileWorkload(resource: AgentWorkloadResource): Promise<void> {
    throwIfStopped();
    const entry = findDriver(resource);
    const runtime = resolveExternalWorkloadRuntime(
      resource,
      entry.capabilities.workloadRuntimes,
    );
    resolveExternalWorkloadResources(resource, runtime);
    const reference = referenceOf(resource);
    const runReference = await ensureRun(resource);
    const latest = requireCanonicalOrchestrationResourceOrNull(
      await whileRunning(() => store.get<AgentWorkloadResource['spec'], AgentWorkloadResource['status']>(reference)),
      isCanonicalAgentWorkload,
      'AgentWorkload get',
    );
    let externalId = latest?.status?.externalId ?? resource.status?.externalId;
    if (!externalId) {
      if (!options.authorizeWorkloadPlacement) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'external AgentWorkload has no host-bound placement authority',
          retryable: false,
        });
      }
      const authorization = await whileRunning(() => options.authorizeWorkloadPlacement!(resource, entry, watchAbort.signal));
      const health = await whileRunning(() => entry.driver.getHealth());
      if (!health.healthy) {
        throw new OrchestrationError({ code: 'UNAVAILABLE', message: `external orchestrator '${entry.name}' is unhealthy`, retryable: true });
      }
      await updateStatus<AgentWorkloadStatus>(reference, (current) => ({
        ...current,
        phase: 'Scheduling',
        assignedDriver: entry.name,
        runs: [runReference],
        placementDecisionRef: authorization.decisionHandle,
        placementPolicyDigest: authorization.policyDigest,
      }));
      let scriptSource: string | undefined;
      const scriptReference = resource.spec.scriptReference;
      if (scriptReference) {
        scriptSource = await whileRunning(async () => options.resolveScriptSource?.(scriptReference));
        if (scriptSource === undefined) {
          throw new OrchestrationError({
            code: 'NOT_FOUND',
            message: `script artifact '${scriptReference}' is unavailable for external placement`,
            retryable: false,
          });
        }
      }
      const workerBootstrap = await whileRunning(async () => options.createWorkerBootstrap?.(resource, runReference));
      const placed = await whileRunning(() =>
        entry.driver.placeWorkload(resource, options.actor, {
          ...(scriptSource !== undefined ? { scriptSource } : {}),
          ...(workerBootstrap !== undefined ? { workerBootstrap } : {}),
          ...(runtime.timeLimitMs !== undefined
            ? { deadline: new Date(now().getTime() + runtime.timeLimitMs).toISOString() }
            : {}),
          signal: watchAbort.signal,
        })
      );
      externalId = placed.externalId;
      await updateStatus<AgentWorkloadStatus>(reference, (current) => ({
        ...current,
        phase: 'Running',
        assignedDriver: entry.name,
        assignedNode: placed.nodeName,
        externalId: placed.externalId,
        runs: [runReference],
        ...(placed.providerMetadata ? { externalMetadata: placed.providerMetadata } : {}),
      }));
      await updateStatus<AgentRunStatus>(runReference, () => ({ phase: 'Running' }));
    }
    while (!stopped) {
      const external = await whileRunning(() => entry.driver.getWorkloadStatus(externalId));
      if (await reflectWorkloadStatus(resource, external)) return;
      await whileRunning(() => sleep(pollIntervalMs));
    }
  }

  async function reconcileToolOperation(resource: ToolOperationResource): Promise<void> {
    throwIfStopped();
    const entry = findDriver(resource);
    const runtimeImage = resource.metadata.annotations?.['memeloop.io/runtime-image'];
    const contract = assertExternalToolOperationContract(
      resource,
      entry.capabilities.toolContracts,
      runtimeImage,
    );
    const reference = referenceOf(resource);
    const latest = requireCanonicalOrchestrationResourceOrNull(
      await whileRunning(() => store.get<ToolOperationResource['spec'], ToolOperationResource['status']>(reference)),
      isCanonicalToolOperation,
      'ToolOperation get',
    );
    let externalId = latest?.status?.externalId ?? resource.status?.externalId;
    if (!externalId) {
      const health = await whileRunning(() => entry.driver.getHealth());
      if (!health.healthy) {
        throw new OrchestrationError({ code: 'UNAVAILABLE', message: `external orchestrator '${entry.name}' is unhealthy`, retryable: true });
      }
      await updateStatus<ToolOperationStatus>(reference, (current) => ({
        ...current,
        phase: 'Pending',
        assignedDriver: entry.name,
      }));
      if (!options.authorizeToolOperation) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'external ToolOperation has no host-bound policy authority',
          retryable: false,
        });
      }
      const authorization = await whileRunning(() => options.authorizeToolOperation!(resource, watchAbort.signal));
      if (authorization.approval) {
        await updateStatus<ToolOperationStatus>(reference, (current) => ({
          ...current,
          approval: authorization.approval,
        }));
      }
      const placed = await whileRunning(() => entry.driver.executeToolOperation(resource, options.actor));
      externalId = placed.externalId;
      await updateStatus<ToolOperationStatus>(reference, (current) => ({
        ...current,
        phase: 'Running',
        assignedDriver: entry.name,
        assignedNode: placed.nodeName,
        externalId: placed.externalId,
        startedAt: current?.startedAt ?? now().toISOString(),
        ...(placed.providerMetadata ? { externalMetadata: placed.providerMetadata } : {}),
      }));
    }
    while (!stopped) {
      const external = await whileRunning(() => entry.driver.getToolOperationStatus(externalId));
      if (await reflectToolStatus(resource, external, contract)) return;
      await whileRunning(() => sleep(pollIntervalMs));
    }
  }

  function maybeStart(resource: OrchestrationResource): void {
    if (stopped) return;
    const routed = requireCanonicalOrchestrationResource(
      resource,
      isRoutedResource,
      'external orchestration watch',
    );
    if (!routeOf(routed)) return;
    const phase = routed.status?.phase;
    if (phase === 'Completed' || phase === 'Failed' || phase === 'Cancelled') return;
    if (active.has(routed.metadata.uid)) return;
    const task = (async () => {
      let slot: string | undefined;
      try {
        const entry = findDriver(routed);
        if (!await acquireDriverSlot(entry)) return;
        slot = entry.name;
      } catch (error) {
        if (stopped || error === stoppedError) return;
        onError(error);
        await fail(routed, error).catch(reportUnlessStopped);
        return;
      }
      try {
        while (!stopped) {
          try {
            if (isAgentWorkload(routed)) {
              await reconcileWorkload(routed);
            } else {
              await reconcileToolOperation(routed);
            }
            return;
          } catch (error) {
            if (stopped || error === stoppedError) return;
            onError(error);
            if (!(error instanceof OrchestrationError) || !error.retryable) {
              await fail(routed, error).catch(reportUnlessStopped);
              return;
            }
            // Retriable backend/transport failures must not turn a declared
            // workload into a permanent failure. Placement retries are safe
            // because external drivers adopt by immutable resource UID.
            await whileRunning(() => sleep(pollIntervalMs));
          }
        }
      } finally {
        if (slot) releaseDriverSlot(slot);
      }
    })();
    active.set(routed.metadata.uid, task);
    void task.finally(() => {
      if (active.get(routed.metadata.uid) === task) active.delete(routed.metadata.uid);
    }).catch((error: unknown) => {
      if (!stopped && error !== stoppedError) onError(error);
    });
  }

  async function cancelDeleted(resource: RoutedResource): Promise<void> {
    const driverName = resource.status?.assignedDriver ?? routeOf(resource);
    const externalId = resource.status?.externalId;
    if (!driverName || !externalId) return;
    const entry = drivers.get(driverName);
    if (!entry) return;
    if (resource.kind === AGENT_WORKLOAD_KIND) {
      await entry.driver.stopWorkload(externalId, options.actor);
    } else {
      await entry.driver.cancelToolOperation(externalId, options.actor);
    }
  }

  async function runKind(apiVersion: string, kind: string): Promise<void> {
    while (!stopped) {
      try {
        // Subscribe before listing. ControlStore implementations buffer watch
        // events, closing the otherwise dangerous list→watch race where a
        // resource created between those operations would never reconcile.
        const iterator = store.watch(
          { apiVersion, kind },
          { signal: watchAbort.signal },
        )[Symbol.asyncIterator]();
        const existing = await whileRunning(() => store.list({ apiVersion, kind }));
        for (const resource of existing.items) maybeStart(resource);
        while (!stopped) {
          const next = await iterator.next();
          if (next.done) break;
          const event = next.value;
          if (stopped) break;
          if (event.type === 'DELETED') {
            const routed = requireCanonicalOrchestrationResource(
              event.resource,
              isRoutedResource,
              'external orchestration delete event',
            );
            await cancelDeleted(routed).catch(reportUnlessStopped);
          } else if (event.type === 'ADDED' || event.type === 'MODIFIED') {
            maybeStart(event.resource);
          }
        }
      } catch (error) {
        if (!stopped && error !== stoppedError) onError(error);
      }
      if (!stopped) {
        await whileRunning(() => sleep(1000)).catch((error: unknown) => {
          if (!stopped && error !== stoppedError) onError(error);
        });
      }
    }
  }

  const watchers = [
    runKind(AGENT_WORKLOAD_API_VERSION, AGENT_WORKLOAD_KIND),
    runKind(TOOL_OPERATION_API_VERSION, TOOL_OPERATION_KIND),
  ];
  for (const watcher of watchers) void watcher.catch(reportUnlessStopped);

  return {
    async stop() {
      if (!stopPromise) {
        stopped = true;
        resolveStopped({ kind: 'stopped' });
        watchAbort.abort(stoppedError);
        // Some third-party ControlStore watches cannot interrupt an already
        // pending `next()`. Drain conforming tasks, but never let a broken
        // driver or watch hold host shutdown indefinitely.
        stopPromise = drainWithDeadline([...watchers, ...active.values()]);
      }
      await stopPromise;
    },
  };
}
