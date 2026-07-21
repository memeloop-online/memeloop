import type { ControlStoreActor } from '../controlStore.js';
import type { AgentWorkloadResource, ToolOperationResource } from '../resources.js';

/**
 * External orchestrator driver contract (24.62).
 *
 * Every external orchestrator (Docker Swarm, Kubernetes/K3s, Nomad, etc.)
 * implements this portable contract so that the memeloop control plane can
 * map AgentWorkload and ToolOperation resources without importing any
 * backend SDK into core or the default CLI.
 *
 * Driver packages (memeloop-swarm, memeloop-k8s, etc.) are separate optional
 * Node packages that import this contract from `memeloop` and register
 * themselves through the ControlStore's driver manifest system.
 */

export interface ExternalPlacementResult {
  /** External orchestrator's native resource identifier (service name, pod name, job name). */
  externalId: string;
  /** The node where the workload or operation was placed. */
  nodeName: string;
  /** Provider-specific metadata (e.g. Docker service ID, K8s UID). */
  providerMetadata?: Record<string, string>;
}

export interface ExternalStatusResult {
  externalId: string;
  phase: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown';
  message?: string;
  /** When the external orchestrator last reported this status. */
  observedAt: string;
  /** Resource usage reported by the external runtime. */
  resources?: {
    cpuCores?: number;
    memoryBytes?: number;
  };
}

export interface ExternalDriverCapabilities {
  name: string;
  version: string;
  /** What the driver manages: workloads, tool-operations, or both. */
  manages: Array<'AgentWorkload' | 'ToolOperation'>;
  /** Whether the driver supports co-located scheduling (workload + tool on same node). */
  supportsColocation: boolean;
  /** Maximum concurrent workloads this driver can handle. */
  maxConcurrency?: number;
}

/**
 * Portable external orchestrator driver.
 *
 * Implementations translate between memeloop orchestration resources and
 * the external orchestrator's native API. The control plane never calls
 * Docker/K8s SDKs directly — it always goes through this contract.
 */
export interface ExternalOrchestrationDriver {
  /** Return capabilities so the control plane knows what to route. */
  getCapabilities(): Promise<ExternalDriverCapabilities>;

  /** Place an AgentWorkload on the external orchestrator. */
  placeWorkload(
    workload: AgentWorkloadResource,
    actor: ControlStoreActor,
  ): Promise<ExternalPlacementResult>;

  /** Get the current status of a placed workload. */
  getWorkloadStatus(externalId: string): Promise<ExternalStatusResult>;

  /** Stop and remove a placed workload. */
  stopWorkload(externalId: string, actor: ControlStoreActor): Promise<void>;

  /** Execute a ToolOperation on the external orchestrator. */
  executeToolOperation(
    operation: ToolOperationResource,
    actor: ControlStoreActor,
  ): Promise<ExternalPlacementResult>;

  /** Get the current status of a tool operation execution. */
  getToolOperationStatus(externalId: string): Promise<ExternalStatusResult>;

  /** Cancel a running tool operation. */
  cancelToolOperation(externalId: string, actor: ControlStoreActor): Promise<void>;

  /** List all workloads currently managed by this driver. */
  listWorkloads(): Promise<ExternalStatusResult[]>;

  /** List all tool operations currently managed by this driver. */
  listToolOperations(): Promise<ExternalStatusResult[]>;

  /** Health check for the driver connection. */
  getHealth(): Promise<{ healthy: boolean; detail?: string; checkedAt: string }>;
}
