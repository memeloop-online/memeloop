import type { OrchestrationResource, OrchestrationResourceReference, OrchestrationResourceStatus } from './client.js';
import type { ControlStore, ControlStoreActor } from './controlStore.js';
import { OrchestrationError } from './errors.js';
import type { LoopRuntimeDriver } from './loopRuntimeDriver.js';
import {
  AGENT_RUN_API_VERSION,
  AGENT_RUN_KIND,
  AGENT_WORKLOAD_API_VERSION,
  AGENT_WORKLOAD_KIND,
  type AgentRunResource,
  type AgentRunStatus,
  type AgentWorkloadResource,
  type AgentWorkloadStatus,
  createAgentRunManifest,
  createNetworkAttachmentManifest,
  MODEL_ENDPOINT_API_VERSION,
  MODEL_ENDPOINT_KIND,
  type ModelEndpointResource,
  NETWORK_ATTACHMENT_API_VERSION,
  NETWORK_ATTACHMENT_KIND,
  type NetworkAttachmentResource,
  type NetworkAttachmentStatus,
  type NetworkClassResource,
} from './resources.js';

/**
 * Workload execution controller (Phase 4.2 / plan 24.14).
 *
 * Watches AgentWorkloads, and for each one the binding controller (24.56)
 * has scheduled onto THIS node (`status.phase === 'Scheduling'` with
 * `status.assignedNode === nodeId`), creates an AgentRun and executes it
 * through the injected LoopRuntimeDriver. Terminal outcomes are written to
 * both the run and the workload. Deleting a running workload cancels its
 * execution. Executions on other nodes are ignored — remote nodes run their
 * own controller instance.
 */

export interface WorkloadExecutionControllerOptions {
  /** Host-bound actor identity for all ControlStore writes. */
  actor: ControlStoreActor;
  /** Only execute workloads bound to this node name. */
  nodeId: string;
  /** Stable only for this daemon lifetime; changes after restart. */
  controllerInstanceId?: string;
  /** Resolve a `spec.scriptReference` (content digest) to admitted source. */
  resolveScriptSource?: (scriptReference: string) => Promise<string | undefined>;
  /** Message delivered to the loop (default: workload name). */
  messageForWorkload?: (workload: AgentWorkloadResource) => string;
  /** CAS attempts per status write (default 3). */
  statusWriteAttempts?: number;
  /** Maximum wait for an independently scheduled ModelEndpoint (default 30s). */
  modelBindingTimeoutMs?: number;
  /** Maximum wait for an independently prepared NetworkAttachment (default 30s). */
  networkAttachmentTimeoutMs?: number;
  /** Maximum wait for independently published volumes (default 30s). */
  volumeBindingTimeoutMs?: number;
  /** Resolve publish handles into ephemeral host mount paths. */
  resolveVolumeMounts?: (
    workload: AgentWorkloadResource,
    run: AgentRunResource,
  ) => Promise<NonNullable<import('./loopRuntimeDriver.js').LoopRunStartRequest['volumeMounts']>>;
  /** Poll interval while waiting for model binding (default 25ms). */
  dependencyPollIntervalMs?: number;
  /** Revalidate selected endpoint heartbeat age before launch (default 90s). */
  modelEndpointHeartbeatTtlMs?: number;
  /** Injectable sleep for watch-retry backoff in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Observes swallowed errors; the controller keeps watching regardless. */
  onError?: (error: unknown) => void;
}

export interface WorkloadExecutionControllerHandle {
  stop(): Promise<void>;
}

const TERMINAL_RUN_PHASES = new Set(['Completed', 'Failed', 'Cancelled']);
let controllerInstanceCounter = 0;

export function createWorkloadExecutionController(
  store: ControlStore,
  driver: LoopRuntimeDriver,
  options: WorkloadExecutionControllerOptions,
): WorkloadExecutionControllerHandle {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const statusWriteAttempts = options.statusWriteAttempts ?? 3;
  const modelBindingTimeoutMs = options.modelBindingTimeoutMs ?? 30_000;
  const networkAttachmentTimeoutMs = options.networkAttachmentTimeoutMs ?? 30_000;
  const volumeBindingTimeoutMs = options.volumeBindingTimeoutMs ?? 30_000;
  const dependencyPollIntervalMs = options.dependencyPollIntervalMs ?? 25;
  const modelEndpointHeartbeatTtlMs = options.modelEndpointHeartbeatTtlMs ?? 90_000;
  const onError = options.onError ?? ((): void => {});
  controllerInstanceCounter += 1;
  const controllerInstanceId = options.controllerInstanceId ??
    `${options.nodeId}:${Date.now()}:${controllerInstanceCounter}`;
  if (!controllerInstanceId) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: 'workload execution controller instance identity is required',
      retryable: false,
    });
  }
  const active = new Map<string, { cancel(): Promise<void> }>();
  let stopped = false;

  async function updateStatusWithRetry<TStatus extends OrchestrationResourceStatus>(
    reference: OrchestrationResourceReference,
    patch: (current: TStatus | undefined) => TStatus,
  ): Promise<void> {
    for (let attempt = 0; attempt < statusWriteAttempts; attempt += 1) {
      const current = await store.get<Record<string, unknown>, TStatus>(reference);
      if (!current) return; // Deleted concurrently.
      try {
        await store.updateStatus(options.actor, reference, patch(current.status), {
          resourceVersion: current.metadata.resourceVersion,
        });
        return;
      } catch (error) {
        if (error instanceof OrchestrationError && error.code === 'CONFLICT') continue;
        throw error;
      }
    }
    throw new OrchestrationError({
      code: 'CONFLICT',
      message: `status update for '${reference.name ?? ''}' exceeded ${statusWriteAttempts} CAS attempts`,
      retryable: true,
    });
  }

  function workloadReference(workload: AgentWorkloadResource): OrchestrationResourceReference {
    return {
      apiVersion: AGENT_WORKLOAD_API_VERSION,
      kind: AGENT_WORKLOAD_KIND,
      name: workload.metadata.name,
      namespace: workload.metadata.namespace,
    };
  }

  function assertCanonicalRunBinding(
    workload: AgentWorkloadResource,
    run: AgentRunResource,
  ): void {
    const reference = run.spec.workloadRef;
    const workloadNamespace = workload.metadata.namespace ?? 'default';
    const referenceNamespace = reference.namespace ?? run.metadata.namespace ?? 'default';
    if (
      reference.apiVersion !== AGENT_WORKLOAD_API_VERSION ||
      reference.kind !== AGENT_WORKLOAD_KIND ||
      reference.name !== workload.metadata.name ||
      referenceNamespace !== workloadNamespace ||
      reference.uid !== workload.metadata.uid ||
      run.spec.promptReference !== undefined ||
      run.spec.retry !== undefined ||
      run.spec.timeoutMs !== undefined
    ) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `pre-existing AgentRun '${run.metadata.name}' does not exactly match controller-owned workload '${workload.metadata.name}'`,
        retryable: false,
      });
    }
  }

  async function claimRuntimeExecution(
    reference: OrchestrationResourceReference,
  ): Promise<AgentRunResource | null> {
    for (let attempt = 0; attempt < statusWriteAttempts; attempt += 1) {
      const current = await store.get<
        AgentRunResource['spec'],
        AgentRunResource['status']
      >(reference) as AgentRunResource | null;
      if (!current) return null;
      // Another daemon already crossed the durable pre-effect boundary.
      // Never overwrite its claim, even after a CAS retry.
      if (current.status?.runtimeExecutionClaim) return null;
      try {
        return await store.updateStatus<
          AgentRunResource['spec'],
          AgentRunResource['status']
        >(
          options.actor,
          reference,
          {
            ...current.status,
            phase: 'Starting',
            runtimeExecutionClaim: {
              controllerInstanceId,
              claimedAt: new Date().toISOString(),
            },
          },
          { resourceVersion: current.metadata.resourceVersion },
        ) as AgentRunResource;
      } catch (error) {
        if (error instanceof OrchestrationError && error.code === 'CONFLICT') {
          continue;
        }
        throw error;
      }
    }
    throw new OrchestrationError({
      code: 'CONFLICT',
      message: `runtime execution claim for '${reference.name ?? ''}' exceeded ${statusWriteAttempts} CAS attempts`,
      retryable: true,
    });
  }

  async function waitForModelBinding(
    workload: AgentWorkloadResource,
    runReference: OrchestrationResourceReference,
  ): Promise<{ run: AgentRunResource; endpoint?: ModelEndpointResource }> {
    const deadline = Date.now() + modelBindingTimeoutMs;
    for (;;) {
      if (stopped) {
        throw new OrchestrationError({
          code: 'CANCELLED',
          message: 'workload execution controller stopped while awaiting dependencies',
          retryable: false,
        });
      }
      const current = await store.get<AgentRunResource['spec'], AgentRunResource['status']>(
        runReference,
      ) as AgentRunResource | null;
      if (!current) {
        throw new OrchestrationError({
          code: 'NOT_FOUND',
          message: `AgentRun '${runReference.name ?? ''}' was deleted while awaiting dependencies`,
          retryable: false,
        });
      }
      if (!workload.spec.modelPolicy?.modelClass) return { run: current };
      const binding = current.status?.assignedModelEndpoint;
      if (binding) {
        const endpoint = await store.get<ModelEndpointResource['spec'], ModelEndpointResource['status']>({
          apiVersion: binding.apiVersion || MODEL_ENDPOINT_API_VERSION,
          kind: binding.kind || MODEL_ENDPOINT_KIND,
          name: binding.name,
          namespace: binding.namespace,
        }) as ModelEndpointResource | null;
        if (
          endpoint &&
          endpoint.metadata.uid === binding.uid &&
          endpoint.status?.healthy === true &&
          Number.isFinite(Date.parse(endpoint.status.heartbeat ?? '')) &&
          Date.now() - Date.parse(endpoint.status.heartbeat ?? '') <= modelEndpointHeartbeatTtlMs &&
          endpoint.spec.modelClassRef.name === workload.spec.modelPolicy.modelClass
        ) {
          return { run: current, endpoint };
        }
      }
      if (Date.now() >= deadline) {
        throw new OrchestrationError({
          code: 'TIMEOUT',
          message: `AgentRun '${current.metadata.name}' did not receive a healthy ModelEndpoint binding within ${modelBindingTimeoutMs}ms`,
          retryable: true,
        });
      }
      await sleep(dependencyPollIntervalMs);
    }
  }

  async function ensureNetworkAttachment(
    workload: AgentWorkloadResource,
    runReference: OrchestrationResourceReference,
    runUid: string,
  ): Promise<NetworkAttachmentResource | undefined> {
    const networkClassName = workload.spec.networkPolicy?.networkClass;
    if (!networkClassName) return undefined;
    const attachmentName = `${runReference.name ?? workload.metadata.name}-network`;
    const reference: OrchestrationResourceReference = {
      apiVersion: NETWORK_ATTACHMENT_API_VERSION,
      kind: NETWORK_ATTACHMENT_KIND,
      name: attachmentName,
      namespace: workload.metadata.namespace,
    };
    let attachment = await store.get<
      NetworkAttachmentResource['spec'],
      NetworkAttachmentResource['status']
    >(reference) as NetworkAttachmentResource | null;
    if (!attachment) {
      const manifest = createNetworkAttachmentManifest(attachmentName, {
        networkClassRef: {
          apiVersion: 'network.memeloop.io/v1alpha1',
          kind: 'NetworkClass',
          name: networkClassName,
        },
        workloadRef: {
          apiVersion: workload.apiVersion,
          kind: workload.kind,
          name: workload.metadata.name,
          uid: workload.metadata.uid,
        },
        runRef: {
          apiVersion: runReference.apiVersion,
          kind: runReference.kind,
          name: runReference.name as string,
          uid: runUid,
          controller: true,
        },
        nodeId: options.nodeId,
      });
      manifest.metadata.namespace = workload.metadata.namespace;
      attachment = await store.create(options.actor, manifest) as unknown as NetworkAttachmentResource;
    }
    await updateStatusWithRetry<AgentRunStatus>(runReference, (current) => ({
      ...current,
      networkAttachmentRef: {
        apiVersion: attachment.apiVersion,
        kind: attachment.kind,
        name: attachment.metadata.name,
        ...(attachment.metadata.namespace ? { namespace: attachment.metadata.namespace } : {}),
        uid: attachment.metadata.uid,
      },
    }));

    const deadline = Date.now() + networkAttachmentTimeoutMs;
    for (;;) {
      if (stopped) {
        throw new OrchestrationError({
          code: 'CANCELLED',
          message: 'workload execution controller stopped while awaiting network attachment',
          retryable: false,
        });
      }
      const current = await store.get<
        NetworkAttachmentResource['spec'],
        NetworkAttachmentResource['status']
      >(reference) as NetworkAttachmentResource | null;
      if (!current || current.metadata.uid !== attachment.metadata.uid) {
        throw new OrchestrationError({
          code: 'NOT_FOUND',
          message: `NetworkAttachment '${attachmentName}' disappeared before workload launch`,
          retryable: false,
        });
      }
      if (current.status?.phase === 'Failed') {
        throw new OrchestrationError({
          code: current.status.error?.code ?? 'UNAVAILABLE',
          message: current.status.error?.message ?? `NetworkAttachment '${attachmentName}' failed`,
          retryable: current.status.error?.retryable ?? false,
        });
      }
      if (current.status?.phase === 'Attached' && current.status.handle) {
        const networkClass = await store.get<
          NetworkClassResource['spec'],
          NetworkClassResource['status']
        >(current.spec.networkClassRef) as NetworkClassResource | null;
        if (
          networkClass &&
          current.status.binding?.networkClassResourceVersion === networkClass.metadata.resourceVersion &&
          current.status.assignedNode === options.nodeId &&
          current.status.assignedDriver === networkClass.spec.driver
        ) {
          return current;
        }
      }
      if (Date.now() >= deadline) {
        throw new OrchestrationError({
          code: 'TIMEOUT',
          message: `NetworkAttachment '${attachmentName}' was not ready within ${networkAttachmentTimeoutMs}ms`,
          retryable: true,
        });
      }
      await sleep(dependencyPollIntervalMs);
    }
  }

  async function waitForVolumeBindings(
    workload: AgentWorkloadResource,
    runReference: OrchestrationResourceReference,
  ): Promise<{
    run: AgentRunResource;
    mounts?: NonNullable<import('./loopRuntimeDriver.js').LoopRunStartRequest['volumeMounts']>;
  }> {
    const expected = workload.spec.storagePolicy?.volumes ?? [];
    if (expected.length === 0) {
      const run = await store.get<AgentRunResource['spec'], AgentRunResource['status']>(
        runReference,
      ) as AgentRunResource;
      return { run };
    }
    const deadline = Date.now() + volumeBindingTimeoutMs;
    for (;;) {
      if (stopped) {
        throw new OrchestrationError({
          code: 'CANCELLED',
          message: 'workload execution controller stopped while awaiting volumes',
          retryable: false,
        });
      }
      const run = await store.get<AgentRunResource['spec'], AgentRunResource['status']>(
        runReference,
      ) as AgentRunResource | null;
      if (!run) {
        throw new OrchestrationError({
          code: 'NOT_FOUND',
          message: `AgentRun '${runReference.name ?? ''}' disappeared while awaiting volumes`,
          retryable: false,
        });
      }
      if (run.status?.volumePhase === 'Failed') {
        throw new OrchestrationError(
          run.status.volumeError ?? {
            code: 'UNAVAILABLE',
            message: 'volume publication failed',
            retryable: false,
          },
        );
      }
      const bindingNames = new Set(run.status?.volumeBindings?.map((item) => item.name));
      if (
        run.status?.volumePhase === 'Ready' &&
        expected.every((item) => bindingNames.has(item.name))
      ) {
        if (!options.resolveVolumeMounts) {
          throw new OrchestrationError({
            code: 'UNSUPPORTED',
            message: 'host cannot resolve published volume handles',
            retryable: false,
          });
        }
        return { run, mounts: await options.resolveVolumeMounts(workload, run) };
      }
      if (Date.now() >= deadline) {
        throw new OrchestrationError({
          code: 'TIMEOUT',
          message: `AgentRun '${run.metadata.name}' volumes were not ready within ${volumeBindingTimeoutMs}ms`,
          retryable: true,
        });
      }
      await sleep(dependencyPollIntervalMs);
    }
  }

  async function requestDependencyRelease(
    runReference: OrchestrationResourceReference,
  ): Promise<void> {
    const run = await store.get<AgentRunResource['spec'], AgentRunResource['status']>(
      runReference,
    ) as AgentRunResource | null;
    if (!run) return;
    const requestedAt = new Date().toISOString();
    const attachment = run.status?.networkAttachmentRef;
    if (attachment) {
      await updateStatusWithRetry<NetworkAttachmentStatus>(
        {
          apiVersion: attachment.apiVersion,
          kind: attachment.kind,
          name: attachment.name,
          namespace: attachment.namespace,
        },
        (current) => ({
          ...current,
          releaseRequestedAt: requestedAt,
        }),
      );
    }
    if (
      run.status?.volumePhase === 'Ready' ||
      run.status?.volumePhase === 'Publishing'
    ) {
      await updateStatusWithRetry<AgentRunStatus>(runReference, (current) => ({
        ...current,
        volumeReleaseRequestedAt: requestedAt,
      }));
    }
  }

  async function execute(workload: AgentWorkloadResource): Promise<void> {
    const workloadReference_ = workloadReference(workload);
    const runName = `${workload.metadata.name}-run`;
    const runReference: OrchestrationResourceReference = {
      apiVersion: AGENT_RUN_API_VERSION,
      kind: AGENT_RUN_KIND,
      name: runName,
      namespace: workload.metadata.namespace,
    };
    let runtimeClaimed = false;

    try {
      // Resolve script source for artifact-backed workloads.
      let scriptSource: string | undefined;
      if (workload.spec.scriptReference) {
        scriptSource = await options.resolveScriptSource?.(workload.spec.scriptReference);
        if (!scriptSource) {
          await updateStatusWithRetry<AgentWorkloadStatus>(workloadReference_, (current) => ({
            ...current,
            phase: 'Failed',
            lastRunResult: `script artifact '${workload.spec.scriptReference}' unavailable`,
          }));
          return;
        }
      }

      // Create (or adopt, after a controller restart) the AgentRun.
      let run = await store.get<AgentRunResource['spec'], AgentRunResource['status']>(runReference) as AgentRunResource | null;
      if (!run) {
        const manifest = createAgentRunManifest(runName, {
          workloadRef: {
            apiVersion: AGENT_WORKLOAD_API_VERSION,
            kind: AGENT_WORKLOAD_KIND,
            name: workload.metadata.name,
            namespace: workload.metadata.namespace,
            uid: workload.metadata.uid,
          },
        });
        manifest.metadata.namespace = workload.metadata.namespace;
        try {
          run = await store.create(
            options.actor,
            manifest,
          ) as unknown as AgentRunResource;
        } catch (error) {
          if (!(error instanceof OrchestrationError) || error.code !== 'CONFLICT') {
            throw error;
          }
          // A competing controller may have created the deterministic Run.
          run = await store.get<
            AgentRunResource['spec'],
            AgentRunResource['status']
          >(runReference) as AgentRunResource | null;
          if (!run) throw error;
        }
      }
      assertCanonicalRunBinding(workload, run);
      if (run.status?.phase && TERMINAL_RUN_PHASES.has(run.status.phase)) {
        // Previous attempt finished; mirror the outcome and stop.
        const terminalStatus = run.status;
        await updateStatusWithRetry<AgentWorkloadStatus>(workloadReference_, (current) => ({
          ...current,
          phase: terminalStatus.phase === 'Completed' ? 'Completed' : 'Failed',
          lastRunResult: terminalStatus.summary,
        }));
        return;
      }

      const [dependencies, networkAttachment, volumeDependencies] = await Promise.all([
        waitForModelBinding(workload, runReference),
        ensureNetworkAttachment(workload, runReference, run.metadata.uid),
        waitForVolumeBindings(workload, runReference),
      ]);
      run = volumeDependencies.run;
      // ensureNetworkAttachment may have added the durable reference.
      run = await store.get<AgentRunResource['spec'], AgentRunResource['status']>(
        runReference,
      ) as AgentRunResource ?? run;

      await updateStatusWithRetry<AgentWorkloadStatus>(workloadReference_, (current) => ({
        ...current,
        phase: 'Running',
        runs: [runReference],
      }));
      const claimedRun = await claimRuntimeExecution(runReference);
      if (!claimedRun) return;
      runtimeClaimed = true;
      run = claimedRun;
      const handle = await driver.start({
        workload,
        run,
        ...(dependencies.endpoint ? { modelEndpoint: dependencies.endpoint } : {}),
        ...(networkAttachment ? { networkAttachment } : {}),
        ...(volumeDependencies.mounts ? { volumeMounts: volumeDependencies.mounts } : {}),
        scriptSource,
        message: options.messageForWorkload?.(workload) ?? workload.metadata.name,
      });
      active.set(workload.metadata.uid, handle);
      await updateStatusWithRetry<AgentRunStatus>(runReference, (current) => ({
        ...current,
        phase: 'Running',
      }));
      const outcome = await handle.wait();

      await requestDependencyRelease(runReference);

      await updateStatusWithRetry<AgentRunStatus>(runReference, (current) => ({
        ...current,
        phase: outcome.phase,
        summary: outcome.summary ?? outcome.error?.message,
        exitCode: outcome.phase === 'Completed' ? 0 : 1,
      }));
      await updateStatusWithRetry<AgentWorkloadStatus>(workloadReference_, (current) => ({
        ...current,
        phase: outcome.phase === 'Completed' ? 'Completed' : 'Failed',
        lastRunResult: outcome.summary ?? outcome.error?.message,
      }));
    } catch (error) {
      await requestDependencyRelease(runReference).catch(onError);
      const cause = error instanceof Error ? error.message : String(error);
      const message = runtimeClaimed
        ? `UNKNOWN_EFFECT: runtime execution failed after the durable pre-effect claim; verify external state before retrying: ${cause}`
        : cause;
      await updateStatusWithRetry<AgentRunStatus>(runReference, (current) => ({
        ...current,
        ...(current?.phase && TERMINAL_RUN_PHASES.has(current.phase)
          ? {}
          : {
            phase: 'Failed' as const,
            summary: message,
            exitCode: 1,
          }),
      })).catch(onError);
      if (stopped) return;
      onError(error);
      await updateStatusWithRetry<AgentWorkloadStatus>(workloadReference_, (current) => ({
        ...current,
        phase: 'Failed',
        lastRunResult: message,
      })).catch(onError);
    } finally {
      active.delete(workload.metadata.uid);
    }
  }

  async function recoverRunning(workload: AgentWorkloadResource): Promise<void> {
    const runReference: OrchestrationResourceReference = {
      apiVersion: AGENT_RUN_API_VERSION,
      kind: AGENT_RUN_KIND,
      name: `${workload.metadata.name}-run`,
      namespace: workload.metadata.namespace,
    };
    try {
      const run = await store.get<AgentRunResource['spec'], AgentRunResource['status']>(
        runReference,
      ) as AgentRunResource | null;
      if (run) {
        try {
          assertCanonicalRunBinding(workload, run);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await updateStatusWithRetry<AgentRunStatus>(runReference, (current) => ({
            ...current,
            phase: 'Failed',
            summary: message,
            exitCode: 1,
          }));
          await updateStatusWithRetry<AgentWorkloadStatus>(
            workloadReference(workload),
            (current) => ({
              ...current,
              phase: 'Failed',
              lastRunResult: message,
            }),
          );
          onError(error);
          return;
        }
      }
      if (!run || !run.status?.phase || run.status.phase === 'Pending') {
        // The previous daemon stopped before persisting its pre-effect claim.
        // No runtime side effect was authorized, so this instance may resume.
        await execute(workload);
        return;
      }
      if (TERMINAL_RUN_PHASES.has(run.status.phase)) {
        await requestDependencyRelease(runReference);
        await updateStatusWithRetry<AgentWorkloadStatus>(
          workloadReference(workload),
          (current) => ({
            ...current,
            phase: run.status?.phase === 'Completed' ? 'Completed' : 'Failed',
            lastRunResult: run.status?.summary,
          }),
        );
        return;
      }

      const message = `UNKNOWN_EFFECT: AgentRun '${run.metadata.name}' was left ${run.status.phase} ` +
        `by controller '${run.status.runtimeExecutionClaim?.controllerInstanceId ?? 'unknown'}'; ` +
        'the configured LoopRuntimeDriver cannot safely adopt it';
      await requestDependencyRelease(runReference);
      await updateStatusWithRetry<AgentRunStatus>(runReference, (current) => ({
        ...current,
        phase: 'Failed',
        summary: message,
        exitCode: 1,
      }));
      await updateStatusWithRetry<AgentWorkloadStatus>(
        workloadReference(workload),
        (current) => ({
          ...current,
          phase: 'Failed',
          lastRunResult: message,
        }),
      );
    } catch (error) {
      onError(error);
    } finally {
      active.delete(workload.metadata.uid);
    }
  }

  function maybeStart(resource: OrchestrationResource): void {
    const workload = resource as AgentWorkloadResource;
    const status = workload.status;
    if (
      !status ||
      (status.phase !== 'Scheduling' && status.phase !== 'Running')
    ) return;
    if (status.assignedNode !== options.nodeId) return;
    if (active.has(workload.metadata.uid)) return;
    active.set(workload.metadata.uid, { cancel: async () => {} });
    if (status.phase === 'Running') {
      void recoverRunning(workload);
    } else {
      void execute(workload).catch(onError);
    }
  }

  void (async () => {
    while (!stopped) {
      try {
        for await (
          const event of store.watch(
            { apiVersion: AGENT_WORKLOAD_API_VERSION, kind: AGENT_WORKLOAD_KIND },
            { sendInitialEvents: true },
          )
        ) {
          if (stopped) break;
          if (event.type === 'ADDED' || event.type === 'MODIFIED') {
            maybeStart(event.resource);
          } else if (event.type === 'DELETED') {
            const workload = event.resource as AgentWorkloadResource;
            await active.get(workload.metadata.uid)?.cancel().catch(onError);
          }
        }
      } catch (error) {
        onError(error);
      }
      if (!stopped) await sleep(1000);
    }
  })().catch(onError);

  return {
    async stop() {
      stopped = true;
      for (const handle of active.values()) {
        await handle.cancel().catch(() => undefined);
      }
    },
  };
}
