import type { OrchestrationErrorData } from './errors.js';

export interface OrchestrationTypeMeta {
  apiVersion: string;
  kind: string;
}

export interface OrchestrationOwnerReference extends OrchestrationTypeMeta {
  name: string;
  uid: string;
  controller?: boolean;
}

export interface OrchestrationManifestMetadata {
  name?: string;
  generateName?: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: OrchestrationOwnerReference[];
  finalizers?: string[];
}

export interface OrchestrationObjectMetadata extends OrchestrationManifestMetadata {
  name: string;
  uid: string;
  generation: number;
  resourceVersion: string;
  creationTimestamp: string;
  deletionTimestamp?: string;
  deletionGracePeriodSeconds?: number;
}

export type OrchestrationConditionStatus = 'True' | 'False' | 'Unknown';

export interface OrchestrationCondition {
  type: string;
  status: OrchestrationConditionStatus;
  reason: string;
  lastTransitionTime: string;
  message?: string;
  observedGeneration?: number;
}

export interface OrchestrationResourceStatus {
  /** Generation observed by the controller that last wrote this status. */
  observedGeneration?: number;
  /** Conditions set by the controller or verifier. */
  conditions?: OrchestrationCondition[];
  /**
   * Status reported by the actor (worker/node), kept separate from
   * controller-observed fields so a compromised actor cannot overwrite
   * controller decisions. Only the named actor may update this field.
   */
  actorReportedStatus?: Record<string, unknown>;
}

export interface OrchestrationResourceManifest<TSpec = Record<string, unknown>> extends OrchestrationTypeMeta {
  metadata: OrchestrationManifestMetadata;
  spec: TSpec;
}

export interface OrchestrationResource<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus> extends OrchestrationTypeMeta {
  metadata: OrchestrationObjectMetadata;
  spec: TSpec;
  status?: TStatus;
}

export interface OrchestrationResourceReference extends OrchestrationTypeMeta {
  name?: string;
  namespace?: string;
  uid?: string;
}

export interface OrchestrationResourceQuery {
  apiVersion?: string;
  kind: string;
  namespace?: string;
  labels?: Record<string, string>;
}

export type OrchestrationEventSeverity = 'Normal' | 'Warning';

export interface OrchestrationEvent {
  eventId: string;
  involvedObject: OrchestrationResourceReference;
  severity: OrchestrationEventSeverity;
  reason: string;
  message: string;
  reportingController: string;
  eventTime: string;
  action?: string;
  count?: number;
}

export interface OrchestrationPreconditions {
  uid?: string;
  resourceVersion?: string;
  generation?: number;
}

export type AgentOrchestrationOperation = 'apply' | 'get' | 'list' | 'watch' | 'delete';

export type AgentInfrastructureInterface =
  | 'resource'
  | 'loop-runtime'
  | 'tool-execution'
  | 'model-provider'
  | 'network'
  | 'storage'
  | 'credential-broker'
  | 'artifact'
  | 'identity-attestation'
  | 'policy-approval'
  | 'audit-telemetry';

export interface AgentOrchestrationCapabilities {
  operations: AgentOrchestrationOperation[];
  resourceKinds: string[];
  /**
   * Optional per-kind operation matrix when `operations` is not a Cartesian
   * promise for every advertised kind. Hosts should publish this whenever
   * controller-owned status resources are read-only to a caller.
   */
  resourceOperations?: Record<string, AgentOrchestrationOperation[]>;
  interfaces: AgentInfrastructureInterface[];
}

export interface OrchestrationCallOptions {
  /** Host/user cancellation. Remote adapters must propagate this to server-side work. */
  signal?: AbortSignal;
  /** Absolute ISO-8601 deadline. Remote adapters apply a bounded default when omitted. */
  deadline?: string;
}

export interface OrchestrationApplyOptions extends OrchestrationCallOptions {
  idempotencyKey?: string;
  fieldManager?: string;
  force?: boolean;
  dryRun?: boolean;
  preconditions?: OrchestrationPreconditions;
}

export interface OrchestrationGetOptions extends OrchestrationCallOptions {
  /**
   * Minimum store revision that must be observable before serving the read.
   * This is a consistency cursor for the store, not a requirement that the
   * addressed resource itself was modified at that revision.
   */
  resourceVersion?: string;
}

export interface OrchestrationListOptions extends OrchestrationCallOptions {
  resourceVersion?: string;
  resourceVersionMatch?: 'exact' | 'not-older-than';
  limit?: number;
  continueToken?: string;
}

export interface OrchestrationResourceList<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus> {
  items: Array<OrchestrationResource<TSpec, TStatus>>;
  resourceVersion: string;
  continueToken?: string;
}

export type OrchestrationResourceWatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED';

export interface OrchestrationResourceWatchEvent<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus> {
  type: OrchestrationResourceWatchEventType;
  resourceVersion: string;
  resource: OrchestrationResource<TSpec, TStatus>;
}

export interface OrchestrationBookmarkWatchEvent {
  type: 'BOOKMARK';
  resourceVersion: string;
}

export interface OrchestrationErrorWatchEvent {
  type: 'ERROR';
  resourceVersion: string;
  terminal: boolean;
  error: OrchestrationErrorData;
}

export type OrchestrationWatchEvent<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus> =
  | OrchestrationResourceWatchEvent<TSpec, TStatus>
  | OrchestrationBookmarkWatchEvent
  | OrchestrationErrorWatchEvent;

export interface OrchestrationWatchOptions {
  resourceVersion?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  allowBookmarks?: boolean;
  sendInitialEvents?: boolean;
}

export interface OrchestrationDeleteOptions extends OrchestrationCallOptions {
  idempotencyKey?: string;
  preconditions?: OrchestrationPreconditions;
  propagationPolicy?: 'orphan' | 'background' | 'foreground';
  dryRun?: boolean;
}

export interface OrchestrationDeleteResult {
  accepted: boolean;
  reference: OrchestrationResourceReference;
}

/**
 * Policy-scoped facade exposed to Agent loops and Agent-facing tools.
 *
 * Hosts bind actor identity, admission, quotas, and grants when constructing the
 * facade. Callers receive declarative resource operations only, never raw
 * infrastructure drivers, platform handles, or credentials.
 */
export interface AgentOrchestrationClient {
  getCapabilities(options?: OrchestrationCallOptions): Promise<AgentOrchestrationCapabilities>;

  apply<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
    resource: OrchestrationResourceManifest<TSpec>,
    options?: OrchestrationApplyOptions,
  ): Promise<OrchestrationResource<TSpec, TStatus>>;

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

  delete(
    reference: OrchestrationResourceReference,
    options?: OrchestrationDeleteOptions,
  ): Promise<OrchestrationDeleteResult>;
}
