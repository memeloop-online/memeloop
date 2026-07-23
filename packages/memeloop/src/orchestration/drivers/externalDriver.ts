import type { ControlStoreActor } from '../controlStore.js';
import { ORCHESTRATION_ERROR_CODES, type OrchestrationErrorData } from '../errors.js';
import type { AgentWorkloadResource, ToolOperationResource, ToolOperationResult } from '../resources.js';

const RUNTIME_RESULT_PREFIX = 'MEMELOOP_RESULT ';

export interface ExternalRuntimeResult {
  phase: 'Completed' | 'Failed' | 'Cancelled';
  summary?: string;
  result?: ToolOperationResult;
  error?: OrchestrationErrorData;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOrchestrationErrorData(value: unknown): value is OrchestrationErrorData {
  if (!isRecord(value)) return false;
  return (
    typeof value.code === 'string' &&
    ORCHESTRATION_ERROR_CODES.includes(value.code as OrchestrationErrorData['code']) &&
    typeof value.message === 'string' &&
    typeof value.retryable === 'boolean' &&
    (value.retryAfterMs === undefined ||
      (typeof value.retryAfterMs === 'number' && Number.isFinite(value.retryAfterMs))) &&
    (value.reason === undefined || typeof value.reason === 'string') &&
    (value.details === undefined || isRecord(value.details))
  );
}

/** Parse the last structured worker-result line from a bounded log tail. */
export function parseExternalRuntimeResult(logTail: string): ExternalRuntimeResult | undefined {
  const offset = logTail.lastIndexOf(RUNTIME_RESULT_PREFIX);
  if (offset < 0) return undefined;
  const line = logTail
    .slice(offset + RUNTIME_RESULT_PREFIX.length)
    .split(/\r?\n/, 1)[0]
    ?.trim();
  if (!line) return undefined;
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (!isRecord(value)) return undefined;
    if (value.phase !== 'Completed' && value.phase !== 'Failed' && value.phase !== 'Cancelled') {
      return undefined;
    }
    if (value.summary !== undefined && typeof value.summary !== 'string') return undefined;
    if (
      value.result !== undefined &&
      (!isRecord(value.result) ||
        (value.result.error !== undefined && !isOrchestrationErrorData(value.result.error)) ||
        (value.result.evidenceRef !== undefined && typeof value.result.evidenceRef !== 'string'))
    ) {
      return undefined;
    }
    if (value.error !== undefined && !isOrchestrationErrorData(value.error)) return undefined;
    return value as unknown as ExternalRuntimeResult;
  } catch {
    return undefined;
  }
}

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
  phase: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Cancelled' | 'Unknown';
  message?: string;
  /** Structured, validated `MEMELOOP_RESULT` recovered from the worker. */
  runtimeResult?: ExternalRuntimeResult;
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
  /**
   * Whether repeated placement of the same immutable MemeLoop resource UID
   * adopts the native object. Required for crash-safe controller recovery.
   */
  supportsAdoption: boolean;
  /** Maximum concurrent workloads this driver can handle. */
  maxConcurrency?: number;
}

export interface ExternalWorkloadPlacementContext {
  /** Admitted source resolved from the content-addressed artifact store. */
  scriptSource?: string;
  /**
   * Single-use worker bootstrap secret. Drivers must materialize it through
   * their native secret mechanism as a read-only file, never argv, ordinary
   * environment, labels, annotations, provider metadata, or ControlStore.
   */
  workerBootstrap?: ExternalWorkerBootstrapSecret;
  /** Portable cancellation for placement requests. */
  signal?: AbortSignal;
}

export interface ExternalWorkerBootstrapSecret {
  apiVersion: 'worker.memeloop.io/v1alpha1';
  gatewayUrl: string;
  gatewayPublicKey: string;
  gatewayKeyFingerprint: string;
  /** Optional PEM CA certificate for an internal HTTPS worker gateway. */
  gatewayCaCertificate?: string;
  enrollmentName: string;
  bootstrapToken: string;
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
    context?: ExternalWorkloadPlacementContext,
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
