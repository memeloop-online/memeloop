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

export type ControlStoreVerb = 'create' | 'update-status' | 'delete' | 'acquire-lease' | 'renew-lease' | 'release-lease';

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
