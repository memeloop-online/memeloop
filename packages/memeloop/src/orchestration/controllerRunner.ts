import type { OrchestrationResource, OrchestrationResourceStatus } from './client.js';
import type { ControlStore, ControlStoreActor } from './controlStore.js';

export interface ControllerReconcileRequest<
  TSpec = Record<string, unknown>,
  TStatus = OrchestrationResourceStatus,
> {
  resource: OrchestrationResource<TSpec, TStatus>;
  actor: ControlStoreActor;
  leaseEpoch: string;
  now: Date;
}

export interface ControllerReconcileResult<
  TStatus extends OrchestrationResourceStatus = OrchestrationResourceStatus,
> {
  /** New status to write; omit to leave status unchanged. */
  status?: TStatus;
  /** If true, the resource is ready; controller stops reconciling until it changes. */
  ready?: boolean;
  /** Optional requeue delay when the controller wants to try again later. */
  requeueAfterMs?: number;
}

export interface Controller<
  TSpec = Record<string, unknown>,
  TStatus extends OrchestrationResourceStatus = OrchestrationResourceStatus,
> {
  reconcile(request: ControllerReconcileRequest<TSpec, TStatus>): Promise<ControllerReconcileResult<TStatus>>;
}

export interface ControllerRunnerOptions<
  TSpec = Record<string, unknown>,
  TStatus extends OrchestrationResourceStatus = OrchestrationResourceStatus,
> {
  /** Controller identity used for all ControlStore writes. */
  actor: ControlStoreActor;
  /** Lease name; controllers with the same name compete for the lease. */
  leaseName: string;
  /** Resource kind this controller reconciles (passed to ControlStore.watch). */
  watchKind: string;
  /** How long the lease is valid before it must be renewed. */
  leaseTtlMs: number;
  /** How often to renew the lease while running. */
  leaseRenewIntervalMs?: number;
  /** Initial backoff after a reconcile failure. */
  retryBaseDelayMs?: number;
  /** Maximum backoff after consecutive reconcile failures. */
  retryMaxDelayMs?: number;
  /** Filter which resources this controller reconciles. */
  resourceFilter?: (resource: OrchestrationResource<TSpec, TStatus>) => boolean;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Injectable sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ControllerRunnerHandle {
  /** Stop watching and release the lease. */
  stop(): Promise<void>;
  /** Wait until the runner has fully stopped. */
  done(): Promise<void>;
}

/**
 * Restart-safe generic controller runner.
 *
 * Watches a ControlStore query, acquires a lease, and calls `controller.reconcile`
 * for each matching resource. On success it may update status and mark Ready.
 * On failure it retries with exponential backoff. If the process crashes, the
 * lease expires and another runner takes over; watch replay resumes from the
 * last acknowledged resource version.
 */
export async function createControllerRunner<
  TSpec = Record<string, unknown>,
  TStatus extends OrchestrationResourceStatus = OrchestrationResourceStatus,
>(
  store: ControlStore,
  controller: Controller<TSpec, TStatus>,
  options: ControllerRunnerOptions<TSpec, TStatus>,
): Promise<ControllerRunnerHandle> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const leaseRenewInterval = options.leaseRenewIntervalMs ?? Math.max(1, Math.floor(options.leaseTtlMs / 3));
  const retryBaseDelay = options.retryBaseDelayMs ?? 100;
  const retryMaxDelay = options.retryMaxDelayMs ?? 30_000;

  let stopped = false;
  let currentLease: Awaited<ReturnType<ControlStore['acquireLease']>> | null = null;
  const pendingRetries = new Map<string, ReturnType<typeof setTimeout>>();
  let stopWatch: (() => void) | null = null;

  // Acquire the lease before watching so a standby runner does not process
  // stale events from before it became leader.
  currentLease = await store.acquireLease(options.actor, {
    name: options.leaseName,
    holder: options.actor.id,
    ttlMs: options.leaseTtlMs,
  });

  const stopPromise = (async () => {
    if (stopped) {
      await store.releaseLease(options.actor, currentLease).catch(() => undefined);
      currentLease = null;
      return;
    }

    const renewTimer = setInterval(async () => {
      if (stopped || !currentLease) return;
      try {
        currentLease = await store.renewLease(options.actor, currentLease, options.leaseTtlMs);
      } catch {
        // Lost lease (or the store went away); stop reconciling and let
        // another runner take over. Break the watch loop and stop renewing
        // so a closed store does not leave a live timer behind.
        stopped = true;
        clearInterval(renewTimer);
        stopWatch?.();
      }
    }, leaseRenewInterval);

    const watcher = store.watch<TSpec, TStatus>(
      { kind: options.watchKind },
      { sendInitialEvents: true },
    );
    const iterator = watcher[Symbol.asyncIterator]();
    stopWatch = () => void iterator.return?.();

    try {
      while (!stopped) {
        const result = await iterator.next();
        if (result.done === true || result.value === undefined) break;
        const event = result.value;
        if (event.type !== 'ADDED' && event.type !== 'MODIFIED') continue;

        const resource = event.resource;
        if (
          options.resourceFilter &&
          !options.resourceFilter(resource)
        ) continue;

        const key = `${resource.metadata.namespace}/${resource.metadata.name}`;
        if (pendingRetries.has(key)) continue;

        await reconcileWithRetry(key, resource);
      }
    } finally {
      clearInterval(renewTimer);
      for (const timer of pendingRetries.values()) clearTimeout(timer);
      pendingRetries.clear();
      if (currentLease) {
        await store.releaseLease(options.actor, currentLease).catch(() => undefined);
        currentLease = null;
      }
    }
  })();

  async function reconcileWithRetry(
    key: string,
    resource: OrchestrationResource<TSpec, TStatus>,
    attempt = 0,
  ): Promise<void> {
    if (stopped || !currentLease) return;

    try {
      const result = await controller.reconcile({
        resource,
        actor: options.actor,
        leaseEpoch: currentLease.epoch,
        now: now(),
      });

      if (result.status && Object.keys(result.status).length > 0) {
        await store.updateStatus(
          options.actor,
          {
            apiVersion: resource.apiVersion,
            kind: resource.kind,
            namespace: resource.metadata.namespace,
            name: resource.metadata.name,
          },
          result.status,
          {
            resourceVersion: resource.metadata.resourceVersion,
          },
        );
      }

      if (result.requeueAfterMs !== undefined && result.requeueAfterMs > 0) {
        const timer = setTimeout(() => {
          pendingRetries.delete(key);
          if (!stopped) void regetAndReconcile(key, resource, 0);
        }, result.requeueAfterMs);
        pendingRetries.set(key, timer);
      }
    } catch {
      const delay = Math.min(retryMaxDelay, retryBaseDelay * 2 ** attempt);
      const timer = setTimeout(() => {
        pendingRetries.delete(key);
        if (!stopped) void regetAndReconcile(key, resource, attempt + 1);
      }, delay);
      pendingRetries.set(key, timer);
    }
  }

  /**
   * Requeue/retry must reconcile the CURRENT resource, not the snapshot the
   * timer captured: controllers whose progress lives in status (e.g. fleet
   * rollout batches) would otherwise reprocess the same stage forever and
   * fail every status CAS against the newer resourceVersion.
   */
  async function regetAndReconcile(
    key: string,
    fallback: OrchestrationResource<TSpec, TStatus>,
    attempt: number,
  ): Promise<void> {
    let current: OrchestrationResource<TSpec, TStatus> | null;
    try {
      current = await store.get<TSpec, TStatus>({
        apiVersion: fallback.apiVersion,
        kind: fallback.kind,
        namespace: fallback.metadata.namespace,
        name: fallback.metadata.name,
      });
    } catch {
      // An unavailable current read is uncertainty, not permission to act on
      // the captured snapshot. Retry the read with backoff and do no work
      // until the authoritative resource can be observed again.
      const delay = Math.min(retryMaxDelay, retryBaseDelay * 2 ** attempt);
      const timer = setTimeout(() => {
        pendingRetries.delete(key);
        if (!stopped) void regetAndReconcile(key, fallback, attempt + 1);
      }, delay);
      pendingRetries.set(key, timer);
      return;
    }
    // A deleted resource must never fall back to the stale snapshot: doing
    // so can repeat a side effect after its cancellation/delete request.
    if (!current) return;
    await reconcileWithRetry(key, current, attempt);
  }

  return {
    async stop() {
      stopped = true;
      stopWatch?.();
      // Release the lease immediately; do not wait for a potentially stuck watch.
      if (currentLease) {
        await store.releaseLease(options.actor, currentLease).catch(() => undefined);
        currentLease = null;
      }
      // Give the background loop a short grace period to clean up timers.
      await Promise.race([
        stopPromise.catch(() => undefined),
        sleep(50),
      ]);
    },
    done: () => stopPromise,
  };
}
