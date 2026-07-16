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
}

export interface OrchestrationObjectMetadata extends OrchestrationManifestMetadata {
  name: string;
  uid: string;
  generation: number;
  resourceVersion: string;
  creationTimestamp: string;
}

export interface OrchestrationResourceManifest<TSpec = Record<string, unknown>> extends OrchestrationTypeMeta {
  metadata: OrchestrationManifestMetadata;
  spec: TSpec;
}

export interface OrchestrationResource<TSpec = Record<string, unknown>, TStatus = unknown> extends OrchestrationTypeMeta {
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
  interfaces: AgentInfrastructureInterface[];
}

export interface OrchestrationApplyOptions {
  idempotencyKey?: string;
  fieldManager?: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface OrchestrationGetOptions {
  resourceVersion?: string;
}

export interface OrchestrationListOptions {
  resourceVersion?: string;
  limit?: number;
  continueToken?: string;
}

export interface OrchestrationResourceList<TSpec = Record<string, unknown>, TStatus = unknown> {
  items: Array<OrchestrationResource<TSpec, TStatus>>;
  resourceVersion: string;
  continueToken?: string;
}

export type OrchestrationWatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR';

export interface OrchestrationWatchEvent<TSpec = Record<string, unknown>, TStatus = unknown> {
  type: OrchestrationWatchEventType;
  resourceVersion: string;
  resource?: OrchestrationResource<TSpec, TStatus>;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}

export interface OrchestrationWatchOptions {
  resourceVersion?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface OrchestrationDeleteOptions {
  idempotencyKey?: string;
  resourceVersion?: string;
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
  getCapabilities(): Promise<AgentOrchestrationCapabilities>;

  apply<TSpec = Record<string, unknown>, TStatus = unknown>(
    resource: OrchestrationResourceManifest<TSpec>,
    options?: OrchestrationApplyOptions,
  ): Promise<OrchestrationResource<TSpec, TStatus>>;

  get<TSpec = Record<string, unknown>, TStatus = unknown>(
    reference: OrchestrationResourceReference,
    options?: OrchestrationGetOptions,
  ): Promise<OrchestrationResource<TSpec, TStatus> | null>;

  list<TSpec = Record<string, unknown>, TStatus = unknown>(
    query: OrchestrationResourceQuery,
    options?: OrchestrationListOptions,
  ): Promise<OrchestrationResourceList<TSpec, TStatus>>;

  watch<TSpec = Record<string, unknown>, TStatus = unknown>(
    query: OrchestrationResourceQuery,
    options?: OrchestrationWatchOptions,
  ): AsyncIterable<OrchestrationWatchEvent<TSpec, TStatus>>;

  delete(
    reference: OrchestrationResourceReference,
    options?: OrchestrationDeleteOptions,
  ): Promise<OrchestrationDeleteResult>;
}
