import type { OrchestrationObjectMetadata, OrchestrationOwnerReference, OrchestrationResourceManifest, OrchestrationResourceStatus, OrchestrationTypeMeta } from './client.js';
import type { OrchestrationErrorData } from './errors.js';

export const AGENT_WORKLOAD_API_VERSION = 'workload.memeloop.io/v1alpha1';
export const AGENT_WORKLOAD_KIND = 'AgentWorkload';

export const AGENT_RUN_API_VERSION = 'run.memeloop.io/v1alpha1';
export const AGENT_RUN_KIND = 'AgentRun';

/**
 * Host-asserted trust classification of a node or workload. The trust class
 * is bound by the host; it is never self-reported by the workload, the model,
 * or a `.mjs` script.
 */
export type NodeTrustClass = 'trusted' | 'restricted' | 'quarantine';

export type AgentTrustLevel = NodeTrustClass;

/** Ordered data classifications; higher ranks are more sensitive. */
export type DataClassification = 'public' | 'internal' | 'confidential' | 'restricted';

export type ToolAdmissionAction = 'allow' | 'deny' | 'require-approval';

/**
 * Declarative trusted-admission rule. Rules are evaluated in order; the first
 * matching rule wins (firewall semantics). A rule matches when `toolPattern`
 * matches the tool reference name and either `effects` is omitted (all
 * effects) or contains the operation effect.
 */
export interface ToolAdmissionRule {
  toolPattern: string;
  effects?: ToolOperationEffect[];
  action: ToolAdmissionAction;
  reason?: string;
}

export interface ToolAdmissionPolicy {
  /** Applied when no rule matches. Restricted/quarantine profiles resolve to `deny` regardless of this field. */
  defaultAction: ToolAdmissionAction;
  rules?: ToolAdmissionRule[];
}

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
  /** Tool classes that must have a healthy executor on the selected node. */
  requiredToolClasses?: string[];
  allowedToolIds?: string[];
  defaultAction?: 'allow' | 'ask' | 'deny';
  rules?: Array<{ pattern: string; action: 'allow' | 'ask' | 'deny' }>;
}

export interface AgentWorkloadNetworkPolicy {
  networkClass?: string;
  egress?: 'none' | 'same-node' | 'restricted' | 'open';
  /** Minimum boundary that must enforce this policy before the workload binds. */
  minimumEnforcement?: 'none' | 'process' | 'namespace' | 'host' | 'external';
}

export interface AgentWorkloadVolumeClaim {
  name: string;
  claimRef: string;
}

export interface AgentWorkloadStoragePolicy {
  storageClass?: string;
  volumes?: AgentWorkloadVolumeClaim[];
}

export interface AgentWorkloadCredentialPolicy {
  /** Credential broker class required on the selected node. */
  brokerClass?: string;
  /** Audiences for which the node must be able to request scoped grants. */
  audiences?: string[];
  /** Target classes for which scoped grants may be issued. */
  targets?: string[];
}

export interface AgentWorkloadResourceRequirements {
  cpuMillicores?: number;
  memoryBytes?: number;
  gpuCount?: number;
  diskBytes?: number;
  bandwidthKbps?: number;
}

export interface AgentWorkloadPlacement {
  /**
   * Registered external-orchestrator driver name. When set, the external
   * orchestration controller owns placement and the local node binder skips
   * this workload. External placement is always explicit; there is no silent
   * spillover from the local runtime.
   */
  orchestrator?: string;
  nodeSelector?: Record<string, string>;
  requiredNode?: string;
  antiAffinity?: string[];
  /** Soft co-location preference; never overrides a hard security filter. */
  preferredNode?: string;
  /** Taints the workload tolerates. Nodes with taints not listed here are filtered out. */
  tolerations?: string[];
  /**
   * Maximum data classification the workload may carry. Nodes with a lower
   * `maxDataClassification` than the workload's effective classification are
   * filtered out. Quarantine nodes are always treated as `public`-only.
   */
  dataClassification?: DataClassification;
  /** Allowed residency labels (for example `local`, `cn`, or `eu-west`). */
  dataResidency?: string[];
  /** Require a currently verified node attestation. */
  requireAttestation?: boolean;
  /** Fleet batch constraints enforced before a target binds. */
  rollout?: {
    batchId: string;
    excludedFaultDomains?: string[];
    maxConcurrentPerFaultDomain?: number;
  };
}

export type AgentWorkloadCompletionPolicy = 'complete' | 'detach' | 'daemon';

export interface AgentWorkloadSpec {
  profileId?: string;
  scriptReference?: string;
  promptReference?: string;
  trust?: AgentTrustLevel;
  /** RuntimeClass selected for script workloads (plan 24.18); declarative only. */
  runtimeClass?: string;
  /**
   * Non-secret environment variables for the workload (plan 24.14 `env`).
   * Secret-shaped values are rejected at admission (deployGeneratedScript)
   * and stripped again at launch (plan 24.35), so specs persisted in the
   * ControlStore never carry provider keys.
   */
  env?: Record<string, string>;
  /** Name of a SecurityProfile resource governing admission and model access. */
  securityProfileRef?: string;
  placement?: AgentWorkloadPlacement;
  modelPolicy?: AgentWorkloadModelPolicy;
  toolPolicy?: AgentWorkloadToolPolicy;
  networkPolicy?: AgentWorkloadNetworkPolicy;
  storagePolicy?: AgentWorkloadStoragePolicy;
  credentialPolicy?: AgentWorkloadCredentialPolicy;
  resources?: AgentWorkloadResourceRequirements;
  /** Content-addressed artifacts whose locality may influence placement. */
  artifactReferences?: string[];
  /** Durable checkpoint whose locality may influence placement. */
  checkpointReference?: string;
  completionPolicy?: AgentWorkloadCompletionPolicy;
  ownerReferences?: OrchestrationOwnerReference[];
}

export interface AgentWorkloadStatus extends OrchestrationResourceStatus {
  phase?: 'Pending' | 'Scheduling' | 'Running' | 'Completed' | 'Failed';
  /** Node the binding controller scheduled this workload onto. */
  assignedNode?: string;
  /** External driver selected for this workload, when any. */
  assignedDriver?: string;
  /** Opaque native workload identifier returned by the external driver. */
  externalId?: string;
  /** Non-secret, string-only backend metadata used for diagnostics/adoption. */
  externalMetadata?: Record<string, string>;
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
  /** Independently selected serving endpoint for this run's model calls. */
  assignedModelEndpoint?: {
    apiVersion: string;
    kind: string;
    name: string;
    namespace?: string;
    uid: string;
  };
  /** Fences the model binding decision to the controller leadership epoch. */
  modelBinding?: {
    leaseEpoch: string;
    endpointResourceVersion: string;
    boundAt: string;
  };
  /** NetworkAttachment that must reach Attached before this run starts. */
  networkAttachmentRef?: {
    apiVersion: string;
    kind: string;
    name: string;
    namespace?: string;
    uid: string;
  };
  volumePhase?: 'Pending' | 'Publishing' | 'Ready' | 'Releasing' | 'Released' | 'Failed';
  volumePublishClaim?: {
    leaseEpoch: string;
    claimedAt: string;
  };
  volumeBindings?: Array<{
    name: string;
    claimRef: { name: string; uid: string };
    volumeRef: { name: string; uid: string };
    assignedDriver: string;
    assignedNode: string;
    publishHandle: string;
    readOnly: boolean;
  }>;
  volumeReleaseRequestedAt?: string;
  volumeError?: OrchestrationErrorData;
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
  /** Expected input/output schema digest; executors with another digest are rejected. */
  schemaDigest?: string;
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
  /** Explicit registered external-orchestrator driver selection. */
  placement?: {
    orchestrator?: string;
    requiredNode?: string;
    preferredNode?: string;
    nodeSelector?: Record<string, string>;
    minimumTrust?: NodeTrustClass;
  };
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
  assignedDriver?: string;
  assignedNode?: string;
  assignedExecutor?: {
    apiVersion: string;
    kind: string;
    name: string;
    namespace?: string;
    uid?: string;
  };
  /**
   * Durable claim written before a local effect starts. A different fencing
   * epoch observing Running must reconcile unknown effect instead of blindly
   * repeating the operation.
   */
  executionClaim?: {
    leaseEpoch: string;
    claimedAt: string;
  };
  externalId?: string;
  externalMetadata?: Record<string, string>;
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

export const SECURITY_PROFILE_API_VERSION = 'security.memeloop.io/v1alpha1';
export const SECURITY_PROFILE_KIND = 'SecurityProfile';

/**
 * Reusable security posture referenced by workloads. The profile is applied
 * by trusted admission, never by the workload itself: for restricted and
 * quarantine trust classes the resolved tool-admission default is forced to
 * `deny` regardless of `toolAdmission.defaultAction`.
 */
export interface SecurityProfileSpec {
  description?: string;
  /** Trust class this profile applies to. */
  trustClass: NodeTrustClass;
  /** Tool admission overlay merged over the trust-class default policy. */
  toolAdmission?: ToolAdmissionPolicy;
  /** Model access constraints for workloads under this profile. */
  modelPolicy?: {
    allowedModelClasses?: string[];
    maxInputClassification?: DataClassification;
  };
}

export interface SecurityProfileStatus extends OrchestrationResourceStatus {
  /** Number of workloads currently referencing this profile. */
  workloadCount?: number;
}

export type SecurityProfileManifest = OrchestrationResourceManifest<SecurityProfileSpec>;

export interface SecurityProfileResource extends OrchestrationTypeMeta {
  metadata: OrchestrationObjectMetadata;
  spec: SecurityProfileSpec;
  status?: SecurityProfileStatus;
}

export function createSecurityProfileManifest(name: string, spec: SecurityProfileSpec): SecurityProfileManifest {
  return {
    apiVersion: SECURITY_PROFILE_API_VERSION,
    kind: SECURITY_PROFILE_KIND,
    metadata: { name },
    spec,
  };
}

export function isSecurityProfile(resource: { apiVersion?: string; kind?: string }): resource is SecurityProfileResource {
  return resource.apiVersion === SECURITY_PROFILE_API_VERSION && resource.kind === SECURITY_PROFILE_KIND;
}

export const NETWORK_CLASS_API_VERSION = 'network.memeloop.io/v1alpha1';
export const NETWORK_CLASS_KIND = 'NetworkClass';

export const NETWORK_ATTACHMENT_API_VERSION = 'network.memeloop.io/v1alpha1';
export const NETWORK_ATTACHMENT_KIND = 'NetworkAttachment';

export interface NetworkEgressRule {
  /** Host, domain suffix, or CIDR, e.g. `api.openai.com` or `10.0.0.0/8`. */
  target: string;
  ports?: number[];
  protocol?: 'tcp' | 'udp' | 'http' | 'https' | 'any';
  action: 'allow' | 'deny';
}

/**
 * CNI-like network desired state. `enforcement: required` means the workload
 * must not start unless the driver can enforce every configured feature;
 * `best-effort` allows partial enforcement with recorded degradation.
 */
export interface NetworkClassSpec {
  description?: string;
  /** NetworkDriver name responsible for this class. */
  driver: string;
  dns?: {
    policy?: 'default' | 'none' | 'custom';
    servers?: string[];
    searchDomains?: string[];
  };
  proxy?: {
    httpProxy?: string;
    httpsProxy?: string;
    noProxy?: string[];
    /** When true, traffic bypassing the proxy must be blocked. */
    mandatory?: boolean;
  };
  ingress?: {
    defaultAction?: 'allow' | 'deny';
    allow?: Array<{
      from?: string;
      ports?: number[];
    }>;
  };
  egress?: {
    defaultAction: 'allow' | 'deny';
    rules?: NetworkEgressRule[];
  };
  serviceAccess?: {
    allowControlPlane?: boolean;
    allowClusterServices?: boolean;
    allowModelGateway?: boolean;
  };
  bandwidth?: {
    ingressKbps?: number;
    egressKbps?: number;
  };
  dataPolicy?: {
    classification?: DataClassification;
    retention?: string;
  };
  enforcement: 'required' | 'best-effort';
}

export interface NetworkClassStatus extends OrchestrationResourceStatus {
  attachmentCount?: number;
}

export type NetworkClassManifest = OrchestrationResourceManifest<NetworkClassSpec>;

export interface NetworkClassResource extends OrchestrationTypeMeta {
  metadata: OrchestrationObjectMetadata;
  spec: NetworkClassSpec;
  status?: NetworkClassStatus;
}

export interface NetworkAttachmentSpec {
  networkClassRef: {
    apiVersion: string;
    kind: string;
    name: string;
  };
  workloadRef?: OrchestrationOwnerReference;
  nodeId?: string;
}

export interface NetworkAttachmentStatus extends OrchestrationResourceStatus {
  phase?: 'Pending' | 'Preparing' | 'Attached' | 'Failed' | 'Detached';
  /** Node and driver selected independently from workload execution. */
  assignedNode?: string;
  assignedDriver?: string;
  /** Fences the placement decision and the NetworkClass version it validated. */
  binding?: {
    leaseEpoch: string;
    networkClassResourceVersion: string;
    boundAt: string;
  };
  /**
   * Durable claim written before prepare() may create host-side state.
   * A new lease epoch must not blindly repeat an unconfirmed prepare.
   */
  executionClaim?: {
    leaseEpoch: string;
    claimedAt: string;
  };
  /** Opaque driver handle; consumers must never parse it. */
  handle?: string;
  addresses?: string[];
  routes?: string[];
  dns?: {
    servers?: string[];
  };
  /** Features the driver could not enforce under a best-effort class. */
  degraded?: string[];
  attachedAt?: string;
  /** Set by the workload owner after execution; the node driver must release before Detached. */
  releaseRequestedAt?: string;
  detachedAt?: string;
  error?: OrchestrationErrorData;
}

export type NetworkAttachmentManifest = OrchestrationResourceManifest<NetworkAttachmentSpec>;

export interface NetworkAttachmentResource extends OrchestrationTypeMeta {
  metadata: OrchestrationObjectMetadata;
  spec: NetworkAttachmentSpec;
  status?: NetworkAttachmentStatus;
}

export function createNetworkClassManifest(name: string, spec: NetworkClassSpec): NetworkClassManifest {
  return {
    apiVersion: NETWORK_CLASS_API_VERSION,
    kind: NETWORK_CLASS_KIND,
    metadata: { name },
    spec,
  };
}

export function createNetworkAttachmentManifest(name: string, spec: NetworkAttachmentSpec): NetworkAttachmentManifest {
  return {
    apiVersion: NETWORK_ATTACHMENT_API_VERSION,
    kind: NETWORK_ATTACHMENT_KIND,
    metadata: { name },
    spec,
  };
}

export function isNetworkClass(resource: { apiVersion?: string; kind?: string }): resource is NetworkClassResource {
  return resource.apiVersion === NETWORK_CLASS_API_VERSION && resource.kind === NETWORK_CLASS_KIND;
}

export function isNetworkAttachment(resource: { apiVersion?: string; kind?: string }): resource is NetworkAttachmentResource {
  return resource.apiVersion === NETWORK_ATTACHMENT_API_VERSION && resource.kind === NETWORK_ATTACHMENT_KIND;
}

export const STORAGE_CLASS_API_VERSION = 'storage.memeloop.io/v1alpha1';
export const STORAGE_CLASS_KIND = 'StorageClass';
export const VOLUME_CLAIM_API_VERSION = 'storage.memeloop.io/v1alpha1';
export const VOLUME_CLAIM_KIND = 'AgentVolumeClaim';
export const VOLUME_API_VERSION = 'storage.memeloop.io/v1alpha1';
export const VOLUME_KIND = 'AgentVolume';
export const SNAPSHOT_API_VERSION = 'storage.memeloop.io/v1alpha1';
export const SNAPSHOT_KIND = 'AgentSnapshot';

export type VolumeAccessMode = 'ReadWriteOnce' | 'ReadOnlyMany' | 'ReadWriteMany';

/** CSI-like storage class: provisioning and replication policy. */
export interface StorageClassSpec {
  description?: string;
  /** StorageDriver name responsible for this class. */
  driver: string;
  replication?: {
    /** Desired replica count across fault domains (1 = no replication). */
    factor?: number;
    /** Fault-domain labels replicas must be spread across (e.g. `node`, `zone`). */
    faultDomains?: string[];
    /** Rebuild replicas automatically after loss. */
    autoRebuild?: boolean;
  };
  encryption?: {
    enabled?: boolean;
    /** Reference to a key in the credential domain (never key material). */
    keyRef?: string;
  };
  allowedAccessModes?: VolumeAccessMode[];
  snapshotSupport?: boolean;
  backup?: {
    /** Cron-like schedule expression evaluated by the backup controller. */
    schedule?: string;
    retentionCount?: number;
  };
  dataPolicy?: {
    classification?: DataClassification;
    retention?: string;
  };
}

export interface StorageClassStatus extends OrchestrationResourceStatus {
  volumeCount?: number;
  healthyVolumeCount?: number;
}

export type StorageClassManifest = OrchestrationResourceManifest<StorageClassSpec>;

export interface StorageClassResource extends OrchestrationTypeMeta {
  metadata: OrchestrationObjectMetadata;
  spec: StorageClassSpec;
  status?: StorageClassStatus;
}

/** PVC-like claim: a workload's request for storage. */
export interface AgentVolumeClaimSpec {
  storageClassRef: {
    apiVersion: string;
    kind: string;
    name: string;
  };
  accessMode: VolumeAccessMode;
  sizeBytes?: number;
  selector?: Record<string, string>;
  /** Restore from a snapshot when provisioning. */
  dataSourceRef?: {
    apiVersion: string;
    kind: string;
    name: string;
  };
}

export interface AgentVolumeClaimStatus extends OrchestrationResourceStatus {
  phase?: 'Pending' | 'Provisioning' | 'Bound' | 'Lost' | 'Failed';
  assignedNode?: string;
  assignedDriver?: string;
  binding?: {
    leaseEpoch: string;
    storageClassResourceVersion: string;
    boundAt: string;
  };
  provisionClaim?: {
    leaseEpoch: string;
    claimedAt: string;
  };
  volumeRef?: {
    apiVersion: string;
    kind: string;
    name: string;
    uid?: string;
  };
  error?: OrchestrationErrorData;
}

export type AgentVolumeClaimManifest = OrchestrationResourceManifest<AgentVolumeClaimSpec>;

export interface AgentVolumeClaimResource extends OrchestrationTypeMeta {
  metadata: OrchestrationObjectMetadata;
  spec: AgentVolumeClaimSpec;
  status?: AgentVolumeClaimStatus;
}

export interface AgentVolumeReplicaStatus {
  nodeId: string;
  state: 'healthy' | 'degraded' | 'rebuilding' | 'offline';
  /** Verified content hash of this replica (must equal the volume contentHash). */
  contentHash?: string;
  updatedAt?: string;
}

/** PV-like provisioned volume. `driverHandle` is opaque and never parsed by consumers. */
export interface AgentVolumeSpec {
  storageClassRef: {
    apiVersion: string;
    kind: string;
    name: string;
  };
  claimRef?: OrchestrationOwnerReference;
  /** Opaque driver handle for the provisioned volume. */
  driverHandle: string;
  capacityBytes?: number;
  topology?: {
    nodeId?: string;
    zone?: string;
  };
  accessModes?: VolumeAccessMode[];
}

export interface AgentVolumeStatus extends OrchestrationResourceStatus {
  phase?: 'Pending' | 'Available' | 'Bound' | 'Published' | 'Failed';
  replicas?: AgentVolumeReplicaStatus[];
  /** Last verified content hash; the replication source of truth. */
  contentHash?: string;
  /** Current primary replica node; transfers originate only from the primary. */
  primaryNodeId?: string;
  /** Monotonically increasing fencing epoch, bumped on every primary change. */
  primaryEpoch?: number;
  publishedTo?: Array<{
    nodeId?: string;
    workloadRef?: OrchestrationOwnerReference;
  }>;
  health?: 'healthy' | 'degraded' | 'rebuilding' | 'failed';
}

export type AgentVolumeManifest = OrchestrationResourceManifest<AgentVolumeSpec>;

export interface AgentVolumeResource extends OrchestrationTypeMeta {
  metadata: OrchestrationObjectMetadata;
  spec: AgentVolumeSpec;
  status?: AgentVolumeStatus;
}

/** Point-in-time snapshot of a volume; restorable into new claims. */
export interface AgentSnapshotSpec {
  sourceVolumeRef: {
    apiVersion: string;
    kind: string;
    name: string;
  };
  snapshotClass?: string;
}

export interface AgentSnapshotStatus extends OrchestrationResourceStatus {
  phase?: 'Pending' | 'Ready' | 'Failed';
  readyToUse?: boolean;
  restoreSizeBytes?: number;
  /** Opaque driver handle for the snapshot. */
  driverHandle?: string;
  createdAt?: string;
}

export type AgentSnapshotManifest = OrchestrationResourceManifest<AgentSnapshotSpec>;

export interface AgentSnapshotResource extends OrchestrationTypeMeta {
  metadata: OrchestrationObjectMetadata;
  spec: AgentSnapshotSpec;
  status?: AgentSnapshotStatus;
}

export function createStorageClassManifest(name: string, spec: StorageClassSpec): StorageClassManifest {
  return {
    apiVersion: STORAGE_CLASS_API_VERSION,
    kind: STORAGE_CLASS_KIND,
    metadata: { name },
    spec,
  };
}

export function createVolumeClaimManifest(name: string, spec: AgentVolumeClaimSpec): AgentVolumeClaimManifest {
  return {
    apiVersion: VOLUME_CLAIM_API_VERSION,
    kind: VOLUME_CLAIM_KIND,
    metadata: { name },
    spec,
  };
}

export function createVolumeManifest(name: string, spec: AgentVolumeSpec): AgentVolumeManifest {
  return {
    apiVersion: VOLUME_API_VERSION,
    kind: VOLUME_KIND,
    metadata: { name },
    spec,
  };
}

export function createSnapshotManifest(name: string, spec: AgentSnapshotSpec): AgentSnapshotManifest {
  return {
    apiVersion: SNAPSHOT_API_VERSION,
    kind: SNAPSHOT_KIND,
    metadata: { name },
    spec,
  };
}

export function isStorageClass(resource: { apiVersion?: string; kind?: string }): resource is StorageClassResource {
  return resource.apiVersion === STORAGE_CLASS_API_VERSION && resource.kind === STORAGE_CLASS_KIND;
}

export function isVolumeClaim(resource: { apiVersion?: string; kind?: string }): resource is AgentVolumeClaimResource {
  return resource.apiVersion === VOLUME_CLAIM_API_VERSION && resource.kind === VOLUME_CLAIM_KIND;
}

export function isVolume(resource: { apiVersion?: string; kind?: string }): resource is AgentVolumeResource {
  return resource.apiVersion === VOLUME_API_VERSION && resource.kind === VOLUME_KIND;
}

export function isSnapshot(resource: { apiVersion?: string; kind?: string }): resource is AgentSnapshotResource {
  return resource.apiVersion === SNAPSHOT_API_VERSION && resource.kind === SNAPSHOT_KIND;
}

export const CREDENTIAL_GRANT_API_VERSION = 'security.memeloop.io/v1alpha1';
export const CREDENTIAL_GRANT_KIND = 'CredentialGrant';

/**
 * JIT credential authorization (plan 24.46). The resource records grant
 * metadata only — the opaque handle lives in the credential domain and raw
 * secret material never appears in spec or status.
 */
export interface CredentialGrantSpec {
  runRef: {
    apiVersion: string;
    kind: string;
    name: string;
    uid: string;
  };
  attempt: number;
  /** Fingerprint of the worker's ephemeral public key. */
  workerKey: string;
  /** Target system the credential acts on (e.g. `ssh://node-7`, `model:openai/gpt-4o`). */
  target: string;
  /** Operation the credential authorizes (e.g. `exec`, `generate`, `read`). */
  method: string;
  /** Audience the resulting handle is valid for. */
  audience: string;
  policyDigest: string;
  budget?: {
    maxCalls?: number;
    maxCost?: number;
    currency?: string;
  };
  /** Requested TTL in milliseconds; the broker caps it. */
  ttlMs?: number;
}

export interface CredentialGrantStatus extends OrchestrationResourceStatus {
  phase?: 'Pending' | 'Issuing' | 'Issued' | 'Renewed' | 'Revoked' | 'Expired' | 'Failed';
  assignedNode?: string;
  assignedBroker?: string;
  binding?: {
    leaseEpoch: string;
    boundAt: string;
  };
  issuanceClaim?: {
    leaseEpoch: string;
    claimedAt: string;
  };
  /** Opaque handle reference in the credential domain — never the handle itself. */
  handleRef?: string;
  issuedAt?: string;
  expiresAt?: string;
  renewedAt?: string;
  revokedAt?: string;
  /** Exposure assessment used to decide post-task rotation. */
  exposure?: 'none' | 'worker-visible' | 'potentially-exposed';
  rotationRequired?: boolean;
  rotationReason?: string;
  error?: OrchestrationErrorData;
}

export type CredentialGrantManifest = OrchestrationResourceManifest<CredentialGrantSpec>;

export interface CredentialGrantResource extends OrchestrationTypeMeta {
  metadata: OrchestrationObjectMetadata;
  spec: CredentialGrantSpec;
  status?: CredentialGrantStatus;
}

export function createCredentialGrantManifest(name: string, spec: CredentialGrantSpec): CredentialGrantManifest {
  return {
    apiVersion: CREDENTIAL_GRANT_API_VERSION,
    kind: CREDENTIAL_GRANT_KIND,
    metadata: { name },
    spec,
  };
}

export function isCredentialGrant(resource: { apiVersion?: string; kind?: string }): resource is CredentialGrantResource {
  return resource.apiVersion === CREDENTIAL_GRANT_API_VERSION && resource.kind === CREDENTIAL_GRANT_KIND;
}

export const ARTIFACT_RECORD_API_VERSION = 'artifacts.memeloop.io/v1alpha1';
export const ARTIFACT_RECORD_KIND = 'ArtifactRecord';

export type ArtifactTrust = 'trusted' | 'restricted' | 'quarantine' | 'untrusted';

export type ArtifactDestination = 'prompt' | 'volume' | 'backup' | 'knowledge';

export type ArtifactReviewKind = 'scan' | 'sanitize' | 'verify';

export interface ArtifactReviewEvidence {
  kind: ArtifactReviewKind;
  outcome: 'passed' | 'failed';
  reviewer: string;
  contentHash: string;
  policyDigest: string;
  destinations: ArtifactDestination[];
  /** Narrow properties certified by the reviewer; never implies general trust. */
  properties?: string[];
  recordedAt: string;
}

/**
 * Content-addressed artifact with provenance and trust (plan 24.47). Derived
 * content inherits the lowest trust of its inputs; untrusted or unverified
 * content cannot enter trusted prompts, volumes, backups, or knowledge
 * ingestion without explicit policy and a verifier pass.
 */
export interface ArtifactRecordSpec {
  /** Content hash (e.g. `sha256:...`); the storage address. */
  contentHash: string;
  sizeBytes?: number;
  mimeType?: string;
  /** Producing run and its trust at production time. */
  producer?: {
    runRef?: OrchestrationOwnerReference;
    trust: ArtifactTrust;
  };
  /** Parent artifacts this one derives from. */
  parents?: Array<{
    apiVersion: string;
    kind: string;
    name: string;
  }>;
  trust: ArtifactTrust;
}

export interface ArtifactRecordStatus extends OrchestrationResourceStatus {
  /** Append-only evidence written only by the trusted artifact review actor. */
  reviews?: ArtifactReviewEvidence[];
  quarantined?: boolean;
  quarantineReason?: string;
  /** Downstream artifact names derived from this one (lineage). */
  derivedBy?: string[];
}

export type ArtifactRecordManifest = OrchestrationResourceManifest<ArtifactRecordSpec>;

export interface ArtifactRecordResource extends OrchestrationTypeMeta {
  metadata: OrchestrationObjectMetadata;
  spec: ArtifactRecordSpec;
  status?: ArtifactRecordStatus;
}

export function createArtifactRecordManifest(name: string, spec: ArtifactRecordSpec): ArtifactRecordManifest {
  return {
    apiVersion: ARTIFACT_RECORD_API_VERSION,
    kind: ARTIFACT_RECORD_KIND,
    metadata: { name },
    spec,
  };
}

export function isArtifactRecord(resource: { apiVersion?: string; kind?: string }): resource is ArtifactRecordResource {
  return resource.apiVersion === ARTIFACT_RECORD_API_VERSION && resource.kind === ARTIFACT_RECORD_KIND;
}

// ─── DriverManifest (drivers.memeloop.io/v1alpha1) ────────────────────

export const DRIVER_MANIFEST_API_VERSION = 'drivers.memeloop.io/v1alpha1';
export const DRIVER_MANIFEST_KIND = 'DriverManifest';

/**
 * Control-plane representation of a registered driver (plan §11, 24.62).
 * A RuntimeClass/NetworkClass/ModelClass/scheduler can only reference a
 * driver whose manifest is registered and conformance-checked; external
 * orchestrator drivers register through the CLI discovery loader.
 */
export interface DriverManifestSpec {
  driverType: 'network' | 'model-provider' | 'tool-execution' | 'storage' | 'credential' | 'external-orchestrator';
  /** Driver package version (from getCapabilities or the package manifest). */
  version: string;
  capabilities: Record<string, boolean | string | number>;
  supportsCancellation: boolean;
  supportsBackpressure: boolean;
  supportsAdoption: boolean;
  supportsFencing: boolean;
  /** External orchestrators: the resource kinds this driver manages. */
  manages?: Array<'AgentWorkload' | 'ToolOperation'>;
  /** External orchestrators: co-located scheduling support. */
  supportsColocation?: boolean;
}

export interface DriverManifestStatus extends OrchestrationResourceStatus {
  phase?: 'Ready' | 'Failed';
  registeredAt?: string;
  error?: OrchestrationErrorData;
}

export type DriverManifestManifest = OrchestrationResourceManifest<DriverManifestSpec>;

export interface DriverManifestResource extends OrchestrationTypeMeta {
  metadata: OrchestrationObjectMetadata;
  spec: DriverManifestSpec;
  status?: DriverManifestStatus;
}

export function createDriverManifestManifest(name: string, spec: DriverManifestSpec): DriverManifestManifest {
  return {
    apiVersion: DRIVER_MANIFEST_API_VERSION,
    kind: DRIVER_MANIFEST_KIND,
    metadata: { name },
    spec,
  };
}

export function isDriverManifest(resource: { apiVersion?: string; kind?: string }): resource is DriverManifestResource {
  return resource.apiVersion === DRIVER_MANIFEST_API_VERSION && resource.kind === DRIVER_MANIFEST_KIND;
}
