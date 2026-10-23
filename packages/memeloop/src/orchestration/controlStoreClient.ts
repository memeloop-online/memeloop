import type {
  AgentOrchestrationCapabilities,
  AgentOrchestrationClient,
  OrchestrationApplyOptions,
  OrchestrationCallOptions,
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
  'ToolOperation',
  'ArtifactRecord',
  'ModelClass',
  'ModelEndpoint',
  'WorkloadCapabilityGrant',
];

function cancellationError(): OrchestrationError {
  return new OrchestrationError({
    code: 'CANCELLED',
    message: 'ControlStore orchestration request was cancelled',
    retryable: false,
  });
}

function deadlineError(): OrchestrationError {
  return new OrchestrationError({
    code: 'TIMEOUT',
    message: 'ControlStore orchestration request deadline expired',
    retryable: false,
  });
}

function validateDeadline(deadline: string | undefined): number | undefined {
  if (deadline === undefined) return undefined;
  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(deadlineMs)) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: 'ControlStore orchestration request deadline is invalid',
      retryable: false,
    });
  }
  return deadlineMs;
}

function throwIfCallInactive(options: OrchestrationCallOptions | undefined): void {
  if (options?.signal?.aborted) throw cancellationError();
  const deadlineMs = validateDeadline(options?.deadline);
  if (deadlineMs !== undefined && deadlineMs <= Date.now()) throw deadlineError();
}

/**
 * Apply is a two-step read/compare/write operation for ControlStore-backed
 * clients. Keep cancellation/deadline behavior at this adapter boundary so a
 * local backend that cannot interrupt a synchronous transaction still never
 * reports a late success to its caller.
 */
function withCallOptions<T>(
  operation: () => Promise<T>,
  options: OrchestrationCallOptions | undefined,
): Promise<T> {
  const deadlineMs = validateDeadline(options?.deadline);
  try {
    throwIfCallInactive(options);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  if (options?.signal === undefined && deadlineMs === undefined) return operation();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options?.signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => {
      finish(() => {
        reject(cancellationError());
      });
    };
    options?.signal?.addEventListener('abort', onAbort, { once: true });
    if (deadlineMs !== undefined) {
      timer = setTimeout(() => {
        finish(() => {
          reject(deadlineError());
        });
      }, Math.max(0, deadlineMs - Date.now()));
    }
    Promise.resolve()
      .then(operation)
      .then(
        value => {
          finish(() => {
            resolve(value);
          });
        },
        (error: unknown) => {
          finish(() => {
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        },
      );
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
      return withCallOptions(async () => {
        const reference: OrchestrationResourceReference = {
          apiVersion: resource.apiVersion,
          kind: resource.kind,
          name: resource.metadata.name,
          namespace: resource.metadata.namespace,
        };
        const existing = await store.get<TSpec, TStatus>(reference, {
          ...(applyOptions?.signal === undefined ? {} : { signal: applyOptions.signal }),
          ...(applyOptions?.deadline === undefined ? {} : { deadline: applyOptions.deadline }),
        });
        throwIfCallInactive(applyOptions);
        const requestedResourceVersion = applyOptions?.preconditions?.resourceVersion;
        if (requestedResourceVersion !== undefined && !existing) {
          throw new OrchestrationError({
            code: 'CONFLICT',
            message: 'apply resourceVersion precondition failed because the resource does not exist',
            retryable: true,
          });
        }
        throwIfCallInactive(applyOptions);
        return store.apply(actor, resource, {
          ...(requestedResourceVersion !== undefined
            ? { resourceVersion: requestedResourceVersion }
            : existing
            ? { resourceVersion: existing.metadata.resourceVersion }
            : {}),
          idempotencyKey: applyOptions?.idempotencyKey,
          fieldManager: applyOptions?.fieldManager,
          force: applyOptions?.force,
          preconditions: applyOptions?.preconditions,
          dryRun: applyOptions?.dryRun,
          ...(applyOptions?.signal === undefined ? {} : { signal: applyOptions.signal }),
          ...(applyOptions?.deadline === undefined ? {} : { deadline: applyOptions.deadline }),
        });
      }, applyOptions);
    },

    get<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
      reference: OrchestrationResourceReference,
      options?: OrchestrationGetOptions,
    ): Promise<OrchestrationResource<TSpec, TStatus> | null> {
      return store.get<TSpec, TStatus>(reference, options);
    },

    list<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
      query: OrchestrationResourceQuery,
      options?: OrchestrationListOptions,
    ): Promise<OrchestrationResourceList<TSpec, TStatus>> {
      return store.list<TSpec, TStatus>(query, options);
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
