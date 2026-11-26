import type { OrchestrationResourceReference } from '../client.js';
import type { ControlStore, ControlStoreActor } from '../controlStore.js';
import { OrchestrationError } from '../errors.js';
import { MODEL_CLASS_API_VERSION, MODEL_CLASS_KIND, MODEL_ENDPOINT_API_VERSION, MODEL_ENDPOINT_KIND, type ModelEndpointStatus } from '../resources.js';
import { describeLocalModelEndpoints, type LocalModelAdvertisementOptions } from './localModelRegistration.js';
import type { ModelProviderDriver } from './modelProviderDriver.js';

/**
 * ModelEndpoint registration heartbeat (plan 24.36).
 *
 * A node runs one registrar per ModelProviderDriver. Each heartbeat tick
 * re-describes the driver's models, upserts ModelClass/ModelEndpoint
 * resources into the ControlStore, and refreshes endpoint `status.healthy`
 * and `status.heartbeat` so the scheduler can place model calls on live
 * endpoints. Endpoints the driver stops serving are deleted; when the driver
 * cannot be interrogated or the registrar stops, owned endpoints are marked
 * unhealthy (fail-safe: never advertise a possibly-dead model as healthy).
 *
 * The actor identity is host-bound; scripts and model output cannot choose
 * it. Endpoint specs are immutable here because ControlStore intentionally
 * exposes no spec-update verb — identity changes require delete + recreate.
 */

export interface ModelEndpointRegistrarOptions {
  /** Host-bound actor identity used for every ControlStore write. */
  actor: ControlStoreActor;
  /** Advertisement identity/policy (nodeId, trust, capacity, data policy). */
  advertisement: LocalModelAdvertisementOptions;
  /** Heartbeat interval in milliseconds (default 30_000). */
  heartbeatIntervalMs?: number;
  /** CAS attempts per status write before giving up (default 3). */
  statusWriteAttempts?: number;
  /** Start the background loop immediately (default true). */
  autoStart?: boolean;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Injectable sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Observes swallowed tick errors; the loop keeps running regardless. */
  onError?: (error: unknown) => void;
}

export interface ModelEndpointRegistrarHandle {
  /** Run one registration + heartbeat pass (serialized with the loop). */
  refresh(): Promise<void>;
  /** Stop the loop and mark owned endpoints unhealthy (best-effort). */
  stop(): Promise<void>;
}

export function createModelEndpointRegistrar(
  store: ControlStore,
  driver: ModelProviderDriver,
  options: ModelEndpointRegistrarOptions,
): ModelEndpointRegistrarHandle {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const intervalMs = options.heartbeatIntervalMs ?? 30_000;
  const statusWriteAttempts = options.statusWriteAttempts ?? 3;
  const onError = options.onError ?? ((): void => {});

  const ownedEndpoints = new Map<string, OrchestrationResourceReference>();
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  async function writeEndpointStatus(
    reference: OrchestrationResourceReference,
    patch: Pick<ModelEndpointStatus, 'healthy' | 'heartbeat'>,
  ): Promise<void> {
    for (let attempt = 0; attempt < statusWriteAttempts; attempt += 1) {
      const current = await store.get(reference);
      if (!current) return; // Deleted concurrently; nothing to refresh.
      try {
        await store.updateStatus(
          options.actor,
          reference,
          { ...current.status, ...patch },
          { resourceVersion: current.metadata.resourceVersion },
        );
        return;
      } catch (error) {
        if (error instanceof OrchestrationError && error.code === 'CONFLICT') continue;
        throw error;
      }
    }
    throw new OrchestrationError({
      code: 'CONFLICT',
      message: `endpoint '${reference.name}' status update exceeded ${statusWriteAttempts} CAS attempts`,
      retryable: true,
    });
  }

  async function markAllOwned(healthy: boolean): Promise<void> {
    for (const reference of ownedEndpoints.values()) {
      try {
        await writeEndpointStatus(reference, { healthy, heartbeat: now().toISOString() });
      } catch (error) {
        onError(error);
      }
    }
  }

  async function refreshOnce(): Promise<void> {
    let advertisement;
    try {
      advertisement = await describeLocalModelEndpoints(driver, options.advertisement);
    } catch (error) {
      // Fail-safe: a driver we cannot interrogate must not keep advertising
      // healthy endpoints.
      onError(error);
      await markAllOwned(false);
      return;
    }

    for (const classManifest of advertisement.modelClasses) {
      const reference: OrchestrationResourceReference = {
        apiVersion: MODEL_CLASS_API_VERSION,
        kind: MODEL_CLASS_KIND,
        name: classManifest.metadata.name,
      };
      try {
        if (!(await store.get(reference))) {
          await store.create(options.actor, classManifest);
        }
      } catch (error) {
        onError(error);
      }
    }

    const seen = new Set<string>();
    for (const endpointManifest of advertisement.endpoints) {
      const name = endpointManifest.metadata.name;
      if (!name) continue;
      const reference: OrchestrationResourceReference = {
        apiVersion: MODEL_ENDPOINT_API_VERSION,
        kind: MODEL_ENDPOINT_KIND,
        name,
      };
      seen.add(name);
      try {
        if (!(await store.get(reference))) {
          await store.create(options.actor, endpointManifest);
        }
        ownedEndpoints.set(name, reference);
        await writeEndpointStatus(reference, {
          healthy: advertisement.health.healthy,
          heartbeat: now().toISOString(),
        });
      } catch (error) {
        onError(error);
      }
    }

    // Prune endpoints the driver no longer serves.
    for (const [name, reference] of [...ownedEndpoints]) {
      if (seen.has(name)) continue;
      try {
        await store.delete(options.actor, reference);
      } catch (error) {
        onError(error);
      }
      ownedEndpoints.delete(name);
    }
  }

  function runRefresh(): Promise<void> {
    inFlight = inFlight.then(() => refreshOnce()).catch(onError);
    return inFlight;
  }

  if (options.autoStart ?? true) {
    void (async () => {
      while (!stopped) {
        await runRefresh();
        if (stopped) break;
        await sleep(intervalMs);
      }
    })().catch(onError);
  }

  return {
    refresh: runRefresh,
    async stop() {
      stopped = true;
      await inFlight.catch(() => undefined);
      await markAllOwned(false);
    },
  };
}
