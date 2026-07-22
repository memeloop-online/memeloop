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
  /** Resolve a `spec.scriptReference` (content digest) to admitted source. */
  resolveScriptSource?: (scriptReference: string) => Promise<string | undefined>;
  /** Message delivered to the loop (default: workload name). */
  messageForWorkload?: (workload: AgentWorkloadResource) => string;
  /** CAS attempts per status write (default 3). */
  statusWriteAttempts?: number;
  /** Injectable sleep for watch-retry backoff in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Observes swallowed errors; the controller keeps watching regardless. */
  onError?: (error: unknown) => void;
}

export interface WorkloadExecutionControllerHandle {
  stop(): Promise<void>;
}

const TERMINAL_RUN_PHASES = new Set(['Completed', 'Failed', 'Cancelled']);

export function createWorkloadExecutionController(
  store: ControlStore,
  driver: LoopRuntimeDriver,
  options: WorkloadExecutionControllerOptions,
): WorkloadExecutionControllerHandle {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const statusWriteAttempts = options.statusWriteAttempts ?? 3;
  const onError = options.onError ?? ((): void => {});
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

  async function execute(workload: AgentWorkloadResource): Promise<void> {
    const workloadReference_ = workloadReference(workload);
    const runName = `${workload.metadata.name}-run`;
    const runReference: OrchestrationResourceReference = {
      apiVersion: AGENT_RUN_API_VERSION,
      kind: AGENT_RUN_KIND,
      name: runName,
      namespace: workload.metadata.namespace,
    };

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
        run = await store.create(
          options.actor,
          createAgentRunManifest(runName, {
            workloadRef: {
              apiVersion: AGENT_WORKLOAD_API_VERSION,
              kind: AGENT_WORKLOAD_KIND,
              name: workload.metadata.name,
              namespace: workload.metadata.namespace,
              uid: workload.metadata.uid,
            },
          }),
        ) as unknown as AgentRunResource;
      }
      if (run.status?.phase && TERMINAL_RUN_PHASES.has(run.status.phase)) {
        // Previous attempt finished; mirror the outcome and stop.
        await updateStatusWithRetry<AgentWorkloadStatus>(workloadReference_, (current) => ({
          ...current,
          phase: run.status!.phase === 'Completed' ? 'Completed' : 'Failed',
          lastRunResult: run.status!.summary,
        }));
        return;
      }

      await updateStatusWithRetry<AgentWorkloadStatus>(workloadReference_, (current) => ({
        ...current,
        phase: 'Running',
        runs: [runReference],
      }));
      await updateStatusWithRetry<AgentRunStatus>(runReference, () => ({ phase: 'Running' }));

      const handle = await driver.start({
        workload,
        run,
        scriptSource,
        message: options.messageForWorkload?.(workload) ?? workload.metadata.name,
      });
      active.set(workload.metadata.uid, handle);
      const outcome = await handle.wait();

      await updateStatusWithRetry<AgentRunStatus>(runReference, () => ({
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
      onError(error);
      await updateStatusWithRetry<AgentWorkloadStatus>(workloadReference_, (current) => ({
        ...current,
        phase: 'Failed',
        lastRunResult: error instanceof Error ? error.message : String(error),
      })).catch(onError);
    } finally {
      active.delete(workload.metadata.uid);
    }
  }

  function maybeStart(resource: OrchestrationResource): void {
    const workload = resource as AgentWorkloadResource;
    const status = workload.status;
    if (!status || status.phase !== 'Scheduling') return;
    if (status.assignedNode !== options.nodeId) return;
    if (active.has(workload.metadata.uid)) return;
    active.set(workload.metadata.uid, { cancel: async () => {} });
    void execute(workload).catch(onError);
  }

  void (async () => {
    while (!stopped) {
      try {
        for await (const event of store.watch({ apiVersion: AGENT_WORKLOAD_API_VERSION, kind: AGENT_WORKLOAD_KIND })) {
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
