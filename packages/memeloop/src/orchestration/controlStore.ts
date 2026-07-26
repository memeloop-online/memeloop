import type {
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

export type ControlStoreVerb =
  | 'create'
  | 'apply'
  | 'update-status'
  | 'delete'
  | 'acquire-lease'
  | 'renew-lease'
  | 'release-lease';

export interface ControlStoreActor {
  id: string;
  kind: 'controller' | 'verifier' | 'admin';
  properties?: string[];
}

export interface ControlStoreAuthorizationRequest {
  actor: ControlStoreActor;
  verb: ControlStoreVerb;
  reference: OrchestrationResourceReference;
  current?: OrchestrationResource;
  proposedResource?: OrchestrationResourceManifest;
  proposedStatus?: OrchestrationResourceStatus;
}

export interface ControlStoreAuthorizer {
  /** Must return synchronously so authorization and the protected write share one transaction. */
  authorize(request: ControlStoreAuthorizationRequest): void;
}

export interface ControlStoreCreateOptions {
  idempotencyKey?: string;
  dryRun?: boolean;
}

export interface ControlStoreApplyOptions {
  /** Required when changing an existing spec; omitted only for create/same-spec retry. */
  resourceVersion?: string;
  idempotencyKey?: string;
  dryRun?: boolean;
}

export interface ControlStoreStatusUpdateOptions {
  /** Exact compare-and-swap precondition. */
  resourceVersion: string;
  idempotencyKey?: string;
  dryRun?: boolean;
}

export interface ControlLeaseRequest {
  name: string;
  holder: string;
  ttlMs: number;
}

export interface ControlLeaseIdentity {
  name: string;
  holder: string;
  leaseId: string;
  epoch: string;
}

export interface ControlLeaseGrant extends ControlLeaseIdentity {
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
  resourceVersion: string;
}

export interface ControlStoreCompactionResult {
  compactedThrough: string;
  resourceVersion: string;
}

export interface ControlStoreSnapshotResult {
  resourceVersion: string;
  createdAt: string;
}

export interface ControlStoreHealth {
  healthy: boolean;
  resourceVersion: string;
  detail?: string;
}

/**
 * Trusted controller-facing state store. Agent-facing clients never receive
 * status, lease, compaction, snapshot, or actor-selection capabilities.
 */
export interface ControlStore {
  get<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
    reference: OrchestrationResourceReference,
    options?: OrchestrationGetOptions,
  ): Promise<OrchestrationResource<TSpec, TStatus> | null>;

  list<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
    query: OrchestrationResourceQuery,
    options?: OrchestrationListOptions,
  ): Promise<OrchestrationResourceList<TSpec, TStatus>>;

  watch<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
    query: OrchestrationResourceQuery,
    options?: OrchestrationWatchOptions,
  ): AsyncIterable<OrchestrationWatchEvent<TSpec, TStatus>>;

  create<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
    actor: ControlStoreActor,
    resource: OrchestrationResourceManifest<TSpec>,
    options?: ControlStoreCreateOptions,
  ): Promise<OrchestrationResource<TSpec, TStatus>>;

  apply<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
    actor: ControlStoreActor,
    resource: OrchestrationResourceManifest<TSpec>,
    options?: ControlStoreApplyOptions,
  ): Promise<OrchestrationResource<TSpec, TStatus>>;

  updateStatus<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
    actor: ControlStoreActor,
    reference: OrchestrationResourceReference,
    status: TStatus,
    options: ControlStoreStatusUpdateOptions,
  ): Promise<OrchestrationResource<TSpec, TStatus>>;

  delete(
    actor: ControlStoreActor,
    reference: OrchestrationResourceReference,
    options?: OrchestrationDeleteOptions,
  ): Promise<OrchestrationDeleteResult>;

  acquireLease(actor: ControlStoreActor, request: ControlLeaseRequest): Promise<ControlLeaseGrant>;
  renewLease(actor: ControlStoreActor, identity: ControlLeaseIdentity, ttlMs: number): Promise<ControlLeaseGrant>;
  releaseLease(actor: ControlStoreActor, identity: ControlLeaseIdentity): Promise<void>;

  compact(throughResourceVersion: string): Promise<ControlStoreCompactionResult>;
  snapshot(targetPath: string): Promise<ControlStoreSnapshotResult>;
  getHealth(): Promise<ControlStoreHealth>;
  close(): Promise<void>;
}

/** Key-order-independent structural form used by every ControlStore backend. */
export function canonicalControlStoreValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) {
    return `[${value.map(canonicalControlStoreValue).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonicalControlStoreValue(item)}`)
        .join(',')
    }}`;
  }
  return JSON.stringify(value) ?? typeof value;
}

const DECLARATIVE_METADATA_FIELDS = [
  'labels',
  'annotations',
  'ownerReferences',
  'finalizers',
] as const;

/** Whether an apply manifest is already represented by the stored resource. */
export function controlStoreApplyMatches(
  current: OrchestrationResource,
  proposed: OrchestrationResourceManifest,
): boolean {
  if (
    canonicalControlStoreValue(current.spec) !==
      canonicalControlStoreValue(proposed.spec)
  ) {
    return false;
  }
  return DECLARATIVE_METADATA_FIELDS.every((field) => {
    const desired = proposed.metadata[field];
    return desired === undefined ||
      canonicalControlStoreValue(current.metadata[field]) ===
        canonicalControlStoreValue(desired);
  });
}
