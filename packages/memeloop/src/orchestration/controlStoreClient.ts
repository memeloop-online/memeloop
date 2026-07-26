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
import { OrchestrationError } from './errors.js';

/**
 * ControlStore-backed AgentOrchestrationClient (plan 24.14).
 *
 * Adapts the trusted controller store to the Agent-facing facade so script
 * deployment (and later other facade consumers) can run against the real
 * store instead of test fakes. Actor identity is bound by the host at
 * construction; callers cannot choose it.
 *
 * Apply semantics follow the store's immutable-spec rule: a missing resource
 * is created; an existing resource with a deep-equal spec is returned
 * unchanged (idempotent for content-addressed names); an existing resource
 * with a different spec is rejected with CONFLICT — delete and recreate to
 * change spec. This matches declarative deployment, where workload names are
 * derived from content digests.
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

/** Deterministic structural comparison (key order independent). */
function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return Object.fromEntries(
        Object.entries(nested as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return nested;
  });
}

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
      if (!existing) {
        return store.create(actor, resource, { idempotencyKey: applyOptions?.idempotencyKey, dryRun: applyOptions?.dryRun });
      }
      if (canonicalize(existing.spec) !== canonicalize(resource.spec)) {
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: `${resource.kind}/${reference.name ?? ''} exists with a different spec; spec is immutable through this facade — delete and recreate to change it`,
          retryable: false,
        });
      }
      return existing;
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
