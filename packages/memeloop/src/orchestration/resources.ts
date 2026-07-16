import type { OrchestrationObjectMetadata, OrchestrationOwnerReference, OrchestrationResourceManifest, OrchestrationResourceStatus, OrchestrationTypeMeta } from './client.js';
import type { OrchestrationErrorData } from './errors.js';

export const AGENT_WORKLOAD_API_VERSION = 'workload.memeloop.io/v1alpha1';
export const AGENT_WORKLOAD_KIND = 'AgentWorkload';

export const AGENT_RUN_API_VERSION = 'run.memeloop.io/v1alpha1';
export const AGENT_RUN_KIND = 'AgentRun';

export type AgentTrustLevel = 'trusted' | 'restricted' | 'quarantine';

export interface AgentWorkloadModelPolicy {
  modelClass?: string;
  allowedModelNames?: string[];
  budget?: {
    maxTokens?: number;
    maxCost?: number;
  };
}

export interface AgentWorkloadToolPolicy {
  allowedToolClasses?: string[];
  allowedToolIds?: string[];
  defaultAction?: 'allow' | 'ask' | 'deny';
  rules?: Array<{ pattern: string; action: 'allow' | 'ask' | 'deny' }>;
}

export interface AgentWorkloadNetworkPolicy {
  networkClass?: string;
  egress?: 'none' | 'same-node' | 'restricted' | 'open';
}

export interface AgentWorkloadVolumeClaim {
  name: string;
  claimRef: string;
}

export interface AgentWorkloadStoragePolicy {
  storageClass?: string;
  volumes?: AgentWorkloadVolumeClaim[];
}

export interface AgentWorkloadPlacement {
  nodeSelector?: Record<string, string>;
  requiredNode?: string;
  antiAffinity?: string[];
}

export type AgentWorkloadCompletionPolicy = 'complete' | 'detach' | 'daemon';

export interface AgentWorkloadSpec {
  profileId?: string;
  scriptReference?: string;
  promptReference?: string;
  trust?: AgentTrustLevel;
  placement?: AgentWorkloadPlacement;
  modelPolicy?: AgentWorkloadModelPolicy;
  toolPolicy?: AgentWorkloadToolPolicy;
  networkPolicy?: AgentWorkloadNetworkPolicy;
  storagePolicy?: AgentWorkloadStoragePolicy;
  completionPolicy?: AgentWorkloadCompletionPolicy;
  ownerReferences?: OrchestrationOwnerReference[];
}

export interface AgentWorkloadStatus extends OrchestrationResourceStatus {
  phase?: 'Pending' | 'Scheduling' | 'Running' | 'Completed' | 'Failed';
  runs?: Array<{
    apiVersion: string;
    kind: string;
    name?: string;
    namespace?: string;
    uid?: string;
  }>;
  lastRunResult?: string;
}

export interface AgentWorkloadCondition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
}

export type AgentWorkloadManifest = OrchestrationResourceManifest<AgentWorkloadSpec>;

export interface AgentWorkloadResource extends OrchestrationTypeMeta {
  metadata: OrchestrationObjectMetadata;
  spec: AgentWorkloadSpec;
  status?: AgentWorkloadStatus;
}

export interface AgentRunSpec {
  workloadRef: {
    apiVersion: string;
    kind: string;
    name?: string;
    namespace?: string;
    uid?: string;
  };
  promptReference?: string;
  retry?: number;
  timeoutMs?: number;
}

export interface AgentRunStatus extends OrchestrationResourceStatus {
  phase?: 'Pending' | 'Running' | 'Completed' | 'Failed' | 'Cancelled';
  outputReference?: string;
  summary?: string;
  exitCode?: number;
}

export interface AgentRunCondition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
}

export type AgentRunManifest = OrchestrationResourceManifest<AgentRunSpec>;

export interface AgentRunResource extends OrchestrationTypeMeta {
  metadata: OrchestrationObjectMetadata;
  spec: AgentRunSpec;
  status?: AgentRunStatus;
}

export function createAgentWorkloadManifest(name: string, spec: AgentWorkloadSpec): AgentWorkloadManifest {
  return {
    apiVersion: AGENT_WORKLOAD_API_VERSION,
    kind: AGENT_WORKLOAD_KIND,
    metadata: { name },
    spec,
  };
}

export function createAgentRunManifest(name: string, spec: AgentRunSpec): AgentRunManifest {
  return {
    apiVersion: AGENT_RUN_API_VERSION,
    kind: AGENT_RUN_KIND,
    metadata: { name },
    spec,
  };
}

export function isAgentWorkload(resource: { apiVersion?: string; kind?: string }): resource is AgentWorkloadResource {
  return resource.apiVersion === AGENT_WORKLOAD_API_VERSION && resource.kind === AGENT_WORKLOAD_KIND;
}

export function isAgentRun(resource: { apiVersion?: string; kind?: string }): resource is AgentRunResource {
  return resource.apiVersion === AGENT_RUN_API_VERSION && resource.kind === AGENT_RUN_KIND;
}

export function agentWorkloadReference(name: string, namespace?: string): {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
} {
  return {
    apiVersion: AGENT_WORKLOAD_API_VERSION,
    kind: AGENT_WORKLOAD_KIND,
    name,
    namespace,
  };
}

export const TOOL_OPERATION_API_VERSION = 'execution.memeloop.io/v1alpha1';
export const TOOL_OPERATION_KIND = 'ToolOperation';

export type ToolOperationEffect = 'read' | 'create' | 'update' | 'delete' | 'execute' | 'unknown';

export interface ToolOperationToolReference {
  apiVersion?: string;
  kind: string;
  name: string;
  namespace?: string;
}

export interface ToolOperationRetryPolicy {
  maxAttempts?: number;
  nonRetryable?: boolean;
  fencingToken?: string;
}

export interface ToolOperationPolicy {
  requireApproval?: boolean;
  auditLevel?: 'none' | 'metadata' | 'payload';
}

export interface ToolOperationSpec {
  toolRef: ToolOperationToolReference;
  arguments?: Record<string, unknown>;
  effect: ToolOperationEffect;
  idempotencyKey?: string;
  timeoutMs?: number;
  retry?: ToolOperationRetryPolicy;
  policy?: ToolOperationPolicy;
}

export interface ToolOperationResult {
  value?: unknown;
  error?: OrchestrationErrorData;
  evidenceRef?: string;
}

export interface ToolOperationStatus extends OrchestrationResourceStatus {
  phase?: 'Pending' | 'Running' | 'Completed' | 'Failed' | 'Cancelled';
  result?: ToolOperationResult;
  attempts?: number;
  startedAt?: string;
  completedAt?: string;
}

export type ToolOperationManifest = OrchestrationResourceManifest<ToolOperationSpec>;

export interface ToolOperationResource extends OrchestrationTypeMeta {
  metadata: OrchestrationObjectMetadata;
  spec: ToolOperationSpec;
  status?: ToolOperationStatus;
}

export function createToolOperationManifest(name: string, spec: ToolOperationSpec): ToolOperationManifest {
  return {
    apiVersion: TOOL_OPERATION_API_VERSION,
    kind: TOOL_OPERATION_KIND,
    metadata: { name },
    spec,
  };
}

export function isToolOperation(resource: { apiVersion?: string; kind?: string }): resource is ToolOperationResource {
  return resource.apiVersion === TOOL_OPERATION_API_VERSION && resource.kind === TOOL_OPERATION_KIND;
}

export function agentRunReference(name: string, namespace?: string): {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
} {
  return {
    apiVersion: AGENT_RUN_API_VERSION,
    kind: AGENT_RUN_KIND,
    name,
    namespace,
  };
}

export const TOOL_CLASS_API_VERSION = 'tool.memeloop.io/v1alpha1';
export const TOOL_CLASS_KIND = 'ToolClass';

export const TOOL_EXECUTOR_API_VERSION = 'tool.memeloop.io/v1alpha1';
export const TOOL_EXECUTOR_KIND = 'ToolExecutor';

export type ToolRiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

export interface ToolClassSchema {
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  required?: string[];
}

export interface ToolClassSpec {
  description?: string;
  version?: string;
  schema: ToolClassSchema;
  schemaDigest?: string;
  risk?: ToolRiskLevel;
  effects?: ToolOperationEffect[];
  allowedTargets?: string[];
  categories?: string[];
}

export interface ToolClassStatus extends OrchestrationResourceStatus {
  endpointCount?: number;
  healthyEndpointCount?: number;
}

export type ToolClassManifest = OrchestrationResourceManifest<ToolClassSpec>;

export interface ToolClassResource extends OrchestrationTypeMeta {
  metadata: OrchestrationObjectMetadata;
  spec: ToolClassSpec;
  status?: ToolClassStatus;
}

export interface ToolExecutorCapability {
  toolClassRef: {
    apiVersion: string;
    kind: string;
    name: string;
  };
  schemaDigest: string;
  endpoint: string;
  capacity?: {
    maxConcurrent?: number;
    queueDepth?: number;
  };
  health?: {
    lastHeartbeat?: string;
    healthy: boolean;
  };
}

export interface ToolExecutorSpec {
  nodeId?: string;
  selectors?: Record<string, string>;
  capabilities: ToolExecutorCapability[];
  trust?: 'trusted' | 'restricted' | 'quarantine';
}

export interface ToolExecutorStatus extends OrchestrationResourceStatus {
  heartbeat?: string;
  healthy?: boolean;
}

export type ToolExecutorManifest = OrchestrationResourceManifest<ToolExecutorSpec>;

export interface ToolExecutorResource extends OrchestrationTypeMeta {
  metadata: OrchestrationObjectMetadata;
  spec: ToolExecutorSpec;
  status?: ToolExecutorStatus;
}

export function createToolClassManifest(name: string, spec: ToolClassSpec): ToolClassManifest {
  return {
    apiVersion: TOOL_CLASS_API_VERSION,
    kind: TOOL_CLASS_KIND,
    metadata: { name },
    spec,
  };
}

export function createToolExecutorManifest(name: string, spec: ToolExecutorSpec): ToolExecutorManifest {
  return {
    apiVersion: TOOL_EXECUTOR_API_VERSION,
    kind: TOOL_EXECUTOR_KIND,
    metadata: { name },
    spec,
  };
}

export function isToolClass(resource: { apiVersion?: string; kind?: string }): resource is ToolClassResource {
  return resource.apiVersion === TOOL_CLASS_API_VERSION && resource.kind === TOOL_CLASS_KIND;
}

export function isToolExecutor(resource: { apiVersion?: string; kind?: string }): resource is ToolExecutorResource {
  return resource.apiVersion === TOOL_EXECUTOR_API_VERSION && resource.kind === TOOL_EXECUTOR_KIND;
}

export const MODEL_CLASS_API_VERSION = 'models.memeloop.io/v1alpha1';
export const MODEL_CLASS_KIND = 'ModelClass';

export const MODEL_ENDPOINT_API_VERSION = 'models.memeloop.io/v1alpha1';
export const MODEL_ENDPOINT_KIND = 'ModelEndpoint';

export const MODEL_CALL_RECORD_API_VERSION = 'models.memeloop.io/v1alpha1';
export const MODEL_CALL_RECORD_KIND = 'ModelCallRecord';

export type ModelModality = 'text' | 'vision' | 'audio' | 'embedding';

export interface ModelClassCapabilities {
  streaming?: boolean;
  toolUse?: boolean;
  jsonMode?: boolean;
  systemPrompt?: boolean;
}

/**
 * Declarative model catalog entry. Carries identity, digest, capabilities,
 * residency, and cost metadata only — raw provider SDK clients, base URLs with
 * embedded credentials, and API keys must never appear here.
 */
export interface ModelClassSpec {
  description?: string;
  /** Provider family identifier, e.g. `openai`, `anthropic`, `ollama`. */
  provider: string;
  /** Provider model name, e.g. `gpt-4o-mini`, `qwen2.5:7b`. */
  model: string;
  version?: string;
  /** Content digest: local weights hash or provider snapshot identifier. */
  digest?: string;
  modalities?: ModelModality[];
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: ModelClassCapabilities;
  /** `local`, `cloud`, or a region/zone label constraining data residency. */
  dataResidency?: string;
  cost?: {
    inputPerMillion?: number;
    outputPerMillion?: number;
    currency?: string;
  };
}

export interface ModelClassStatus extends OrchestrationResourceStatus {
  endpointCount?: number;
  healthyEndpointCount?: number;
}

export type ModelClassManifest = OrchestrationResourceManifest<ModelClassSpec>;

export interface ModelClassResource extends OrchestrationTypeMeta {
  metadata: OrchestrationObjectMetadata;
  spec: ModelClassSpec;
  status?: ModelClassStatus;
}

/**
 * Schedulable model serving endpoint. The endpoint string is an opaque driver
 * handle (e.g. `ollama://node-1/qwen2.5:7b` or `gateway://default`) and must
 * not embed credentials.
 */
export interface ModelEndpointSpec {
  modelClassRef: {
    apiVersion: string;
    kind: string;
    name: string;
  };
  /** Must match the referenced ModelClass digest for schedulability. */
  modelDigest?: string;
  nodeId?: string;
  trust?: 'trusted' | 'restricted' | 'quarantine';
  endpoint: string;
  capacity?: {
    maxConcurrent?: number;
    tokensPerMinute?: number;
  };
  dataPolicy?: {
    classification?: string;
    retention?: string;
  };
}

export interface ModelEndpointStatus extends OrchestrationResourceStatus {
  healthy?: boolean;
  heartbeat?: string;
  activeCalls?: number;
}

export type ModelEndpointManifest = OrchestrationResourceManifest<ModelEndpointSpec>;

export interface ModelEndpointResource extends OrchestrationTypeMeta {
  metadata: OrchestrationObjectMetadata;
  spec: ModelEndpointSpec;
  status?: ModelEndpointStatus;
}

/**
 * Audit and usage record for a single model call. Records carry usage and
 * classification metadata, never raw prompts, completions, or credentials.
 */
export interface ModelCallRecordSpec {
  modelClassRef: {
    apiVersion: string;
    kind: string;
    name: string;
  };
  endpointRef?: {
    apiVersion: string;
    kind: string;
    name: string;
  };
  runRef?: OrchestrationOwnerReference;
  /** Bound actor identity asserted by the host, not self-reported. */
  caller?: string;
  /** Name of the ModelAccessHandle authorizing this call. */
  accessHandleRef?: string;
  inputClassification?: string;
  outputClassification?: string;
}

export interface ModelCallRecordStatus extends OrchestrationResourceStatus {
  phase?: 'Running' | 'Completed' | 'Failed' | 'Cancelled';
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
    currency?: string;
  };
  latencyMs?: number;
  startedAt?: string;
  completedAt?: string;
  error?: OrchestrationErrorData;
}

export type ModelCallRecordManifest = OrchestrationResourceManifest<ModelCallRecordSpec>;

export interface ModelCallRecordResource extends OrchestrationTypeMeta {
  metadata: OrchestrationObjectMetadata;
  spec: ModelCallRecordSpec;
  status?: ModelCallRecordStatus;
}

export function createModelClassManifest(name: string, spec: ModelClassSpec): ModelClassManifest {
  return {
    apiVersion: MODEL_CLASS_API_VERSION,
    kind: MODEL_CLASS_KIND,
    metadata: { name },
    spec,
  };
}

export function createModelEndpointManifest(name: string, spec: ModelEndpointSpec): ModelEndpointManifest {
  return {
    apiVersion: MODEL_ENDPOINT_API_VERSION,
    kind: MODEL_ENDPOINT_KIND,
    metadata: { name },
    spec,
  };
}

export function createModelCallRecordManifest(name: string, spec: ModelCallRecordSpec): ModelCallRecordManifest {
  return {
    apiVersion: MODEL_CALL_RECORD_API_VERSION,
    kind: MODEL_CALL_RECORD_KIND,
    metadata: { name },
    spec,
  };
}

export function isModelClass(resource: { apiVersion?: string; kind?: string }): resource is ModelClassResource {
  return resource.apiVersion === MODEL_CLASS_API_VERSION && resource.kind === MODEL_CLASS_KIND;
}

export function isModelEndpoint(resource: { apiVersion?: string; kind?: string }): resource is ModelEndpointResource {
  return resource.apiVersion === MODEL_ENDPOINT_API_VERSION && resource.kind === MODEL_ENDPOINT_KIND;
}

export function isModelCallRecord(resource: { apiVersion?: string; kind?: string }): resource is ModelCallRecordResource {
  return resource.apiVersion === MODEL_CALL_RECORD_API_VERSION && resource.kind === MODEL_CALL_RECORD_KIND;
}
