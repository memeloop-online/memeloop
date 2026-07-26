import type {
  AgentOrchestrationCapabilities,
  AgentOrchestrationClient,
  OrchestrationApplyOptions,
  OrchestrationDeleteOptions,
  OrchestrationDeleteResult,
  OrchestrationGetOptions,
  OrchestrationListOptions,
  OrchestrationResource,
  OrchestrationResourceList,
  OrchestrationResourceManifest,
  OrchestrationResourceQuery,
  OrchestrationResourceReference,
  OrchestrationResourceStatus,
  OrchestrationWatchEvent,
  OrchestrationWatchOptions,
} from './client.js';
import type { ControlStore, ControlStoreActor } from './controlStore.js';

/**
 * ControlStore-backed AgentOrchestrationClient (plan 24.14).
 *
 * Adapts the trusted controller store to the Agent-facing facade so script
 * deployment (and later other facade consumers) can run against the real
 * store instead of test fakes. Actor identity is bound by the host at
 * construction; callers cannot choose it.
 *
 * Apply delegates to the store's atomic declarative update: create when
 * absent, return an equal spec idempotently, or CAS a changed desired spec
 * while preserving identity/status and advancing generation.
 */

export interface ControlStoreOrchestrationClientOptions {
  /** Resource kinds reported by getCapabilities (default: workload-related kinds). */
  resourceKinds?: string[];
}

const DEFAULT_RESOURCE_KINDS = [
  'AgentWorkload',
  'AgentRun',
  'ArtifactRecord',
  'ModelClass',
  'ModelEndpoint',
  'WorkloadCapabilityGrant',
];

export function createControlStoreOrchestrationClient(
  store: ControlStore,
  actor: ControlStoreActor,
  options: ControlStoreOrchestrationClientOptions = {},
): AgentOrchestrationClient {
  const resourceKinds = options.resourceKinds ?? DEFAULT_RESOURCE_KINDS;

  return {
    async getCapabilities(): Promise<AgentOrchestrationCapabilities> {
      return {
        operations: ['apply', 'get', 'list', 'watch', 'delete'],
        resourceKinds,
        interfaces: ['resource'],
      };
    },

    async apply<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
      resource: OrchestrationResourceManifest<TSpec>,
      applyOptions?: OrchestrationApplyOptions,
    ): Promise<OrchestrationResource<TSpec, TStatus>> {
      const reference: OrchestrationResourceReference = {
        apiVersion: resource.apiVersion,
        kind: resource.kind,
        name: resource.metadata.name,
        namespace: resource.metadata.namespace,
      };
      const existing = await store.get<TSpec, TStatus>(reference);
      return store.apply(actor, resource, {
        ...(existing ? { resourceVersion: existing.metadata.resourceVersion } : {}),
        idempotencyKey: applyOptions?.idempotencyKey,
        dryRun: applyOptions?.dryRun,
      });
    },

    get<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
      reference: OrchestrationResourceReference,
      _options?: OrchestrationGetOptions,
    ): Promise<OrchestrationResource<TSpec, TStatus> | null> {
      return store.get<TSpec, TStatus>(reference);
    },

    list<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
      query: OrchestrationResourceQuery,
      _options?: OrchestrationListOptions,
    ): Promise<OrchestrationResourceList<TSpec, TStatus>> {
      return store.list<TSpec, TStatus>(query);
    },

    watch<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
      query: OrchestrationResourceQuery,
      watchOptions?: OrchestrationWatchOptions,
    ): AsyncIterable<OrchestrationWatchEvent<TSpec, TStatus>> {
      return store.watch<TSpec, TStatus>(query, watchOptions);
    },

    delete(
      reference: OrchestrationResourceReference,
      deleteOptions?: OrchestrationDeleteOptions,
    ): Promise<OrchestrationDeleteResult> {
      return store.delete(actor, reference, deleteOptions);
    },
  };
}
