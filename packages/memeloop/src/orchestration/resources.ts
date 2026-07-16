import type { OrchestrationObjectMetadata, OrchestrationOwnerReference, OrchestrationResourceManifest, OrchestrationResourceStatus, OrchestrationTypeMeta } from './client.js';

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
