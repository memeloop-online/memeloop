import type {
  AgentWorkloadResource,
  ControlStoreActor,
  ExternalDriverCapabilities,
  ExternalOrchestrationDriver,
  ExternalPlacementResult,
  ExternalStatusResult,
  ExternalWorkloadPlacementContext,
  ToolOperationResource,
} from 'memeloop';
import { OrchestrationError, parseExternalRuntimeResult } from 'memeloop';

import { DockerEngineClient } from './engineClient.js';
import type { DockerEngineClientOptions } from './engineClient.js';
import { toSwarmDriverError } from './errors.js';
import {
  ANNOTATION_RUNTIME_COMMAND,
  ANNOTATION_RUNTIME_CPU,
  ANNOTATION_RUNTIME_ENV,
  ANNOTATION_RUNTIME_IMAGE,
  ANNOTATION_RUNTIME_MEMORY,
  ENV_WORKLOAD,
  ENV_WORKLOAD_SCRIPT,
  LABEL_IDEMPOTENCY_KEY,
  LABEL_MANAGED_BY,
  LABEL_OPERATION_NAME,
  LABEL_OPERATION_NAMESPACE,
  LABEL_OPERATION_UID,
  LABEL_RESOURCE_KIND,
  LABEL_WORKLOAD_NAME,
  LABEL_WORKLOAD_NAMESPACE,
  LABEL_WORKLOAD_UID,
  MANAGED_BY_VALUE,
  sanitizeLabelValue,
  toolOperationServiceName,
  workloadServiceName,
} from './labels.js';

/** Per-call options accepted by every driver method (optional third parameter). */
export interface SwarmDriverCallOptions {
  /** Cancellation signal honoured by the underlying HTTP request. */
  signal?: AbortSignal;
}

export interface SwarmDriverOptions extends DockerEngineClientOptions {
  /**
   * Fallback image for AgentWorkloads without a runtime-image annotation.
   * Configure this to the deployed `@memeloop/worker-runtime` image when
   * routing admitted script workloads through this driver.
   */
  defaultWorkloadImage?: string;
  /**
   * Fallback container image for ToolOperation executions whose metadata does
   * not carry the `memeloop.io/runtime-image` annotation. When neither is
   * present, `executeToolOperation` fails with an `INVALID` error.
   */
  defaultToolImage?: string;
}

/* ------------------------------------------------------------------ */
/* Minimal Docker Engine API shapes (only fields the driver consumes)  */
/* ------------------------------------------------------------------ */

interface EngineServiceSpec {
  Name?: string;
  Labels?: Record<string, string>;
  Mode?: { Replicated?: { Replicas?: number }; ReplicatedJob?: { MaxConcurrent?: number; TotalCompletions?: number } };
  TaskTemplate?: {
    ContainerSpec?: { Labels?: Record<string, string> };
    Placement?: { Constraints?: string[] };
  };
}

interface EngineService {
  ID: string;
  Spec?: EngineServiceSpec;
}

interface EngineTask {
  ID: string;
  ServiceID: string;
  NodeID?: string;
  Status?: { State?: string; Timestamp?: string; Err?: string };
  DesiredState?: string;
}

const RUNNING_TASK_STATES = new Set(['preparing', 'starting', 'running']);
const FAILED_TASK_STATES = new Set(['failed', 'rejected']);
const FINISHED_TASK_STATES = new Set(['complete', 'shutdown']);
const MAX_INLINE_SCRIPT_BYTES = 96 * 1024;
const MAX_RUNTIME_LOG_BYTES = 128 * 1024;

/**
 * Docker Swarm backend for the memeloop `ExternalOrchestrationDriver`
 * contract (docs/AGENT_ORCHESTRATION_PLAN.md §24.62).
 *
 * Resource mapping (documented minimal mapping — the portable
 * AgentWorkload/ToolOperation specs do not name container images, so runtime
 * details travel in `metadata.annotations`):
 *
 * | memeloop field                                   | Swarm service field                                             |
 * | ------------------------------------------------ | --------------------------------------------------------------- |
 * | annotation `memeloop.io/runtime-image` (required) | `TaskTemplate.ContainerSpec.Image`                             |
 * | annotation `memeloop.io/runtime-command` (JSON)   | `TaskTemplate.ContainerSpec.Command`                           |
 * | annotation `memeloop.io/runtime-env` (JSON)       | `TaskTemplate.ContainerSpec.Env` (`K=V` entries)               |
 * | annotation `memeloop.io/runtime-cpu` (cores)      | `Resources.{Limits,Reservations}.NanoCPUs`                     |
 * | annotation `memeloop.io/runtime-memory` (bytes)   | `Resources.{Limits,Reservations}.MemoryBytes`                  |
 * | `spec.placement.nodeSelector`                     | `Placement.Constraints` (`node.labels.<k>==<v>`)               |
 * | `spec.placement.requiredNode`                     | `Placement.Constraints` (`node.hostname==<node>`)              |
 * | `spec.placement.antiAffinity`                     | rejected with `UNSUPPORTED` (Swarm cannot express it)          |
 * | `spec.completionPolicy` = `complete`              | `Mode.ReplicatedJob` + `RestartPolicy none`                    |
 * | `spec.completionPolicy` = `daemon`                | `Mode.Replicated` + `RestartPolicy any`                        |
 * | `spec.completionPolicy` = `detach`/unset          | `Mode.Replicated` + `RestartPolicy on-failure`                 |
 * | ToolOperation identity                            | `io.memeloop.operation.*` labels + `MEMELOOP_TOOL_OPERATION` env |
 *
 * Isolation honesty: Swarm provides namespace-level (container) isolation
 * only. The driver never claims host-level isolation.
 */
export class SwarmOrchestrationDriver implements ExternalOrchestrationDriver {
  private readonly client: DockerEngineClient;
  private readonly defaultWorkloadImage?: string;
  private readonly defaultToolImage?: string;

  constructor(options: SwarmDriverOptions = {}) {
    this.client = new DockerEngineClient(options);
    this.defaultWorkloadImage = options.defaultWorkloadImage;
    this.defaultToolImage = options.defaultToolImage;
  }

  /** Report driver capabilities derived from `GET /info` and `GET /version`. */
  async getCapabilities(): Promise<ExternalDriverCapabilities> {
    try {
      const [info, version] = await Promise.all([
        this.client.request<{ Swarm?: { LocalNodeState?: string } }>('GET', '/info'),
        this.client.request<{ Version?: string; ApiVersion?: string }>('GET', '/version'),
      ]);
      return {
        name: 'memeloop-swarm',
        version: `${version.Version ?? 'unknown'} (api ${version.ApiVersion ?? 'unknown'})`,
        manages: ['AgentWorkload', 'ToolOperation'],
        // Explicit co-location: nodeSelector/requiredNode become Swarm
        // placement constraints on the created service. Only meaningful when
        // this engine is an active Swarm member.
        supportsColocation: info.Swarm?.LocalNodeState === 'active',
        supportsAdoption: true,
      };
    } catch (error) {
      throw toSwarmDriverError(error, 'getCapabilities');
    }
  }

  /** Create a Swarm service from an AgentWorkload. */
  async placeWorkload(
    workload: AgentWorkloadResource,
    _actor: ControlStoreActor,
    options: SwarmDriverCallOptions & ExternalWorkloadPlacementContext = {},
  ): Promise<ExternalPlacementResult> {
    try {
      // Adopt by immutable MemeLoop UID after controller restart. This closes
      // the crash window between Docker service creation and ControlStore
      // status persistence without relying on a best-effort name collision.
      const existing = await this.findServiceByLabel(LABEL_WORKLOAD_UID, workload.metadata.uid, options.signal);
      if (existing) {
        return {
          externalId: existing.Spec?.Name ?? existing.ID,
          nodeName: await this.resolveServiceNode(existing.ID, options.signal) ??
            workload.spec.placement?.requiredNode ??
            'unassigned',
          providerMetadata: {
            'swarm.service.id': existing.ID,
            'memeloop.adopted': 'true',
          },
        };
      }
      if (options.scriptSource !== undefined && Buffer.byteLength(options.scriptSource, 'utf8') > MAX_INLINE_SCRIPT_BYTES) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: `placeWorkload(${workload.metadata.name}): script exceeds inline runtime limit ${MAX_INLINE_SCRIPT_BYTES} bytes`,
          retryable: false,
        });
      }
      const name = workloadServiceName(workload.metadata.name, workload.metadata.uid);
      const labels: Record<string, string> = {
        [LABEL_MANAGED_BY]: MANAGED_BY_VALUE,
        [LABEL_RESOURCE_KIND]: 'AgentWorkload',
        [LABEL_WORKLOAD_UID]: sanitizeLabelValue(workload.metadata.uid),
        [LABEL_WORKLOAD_NAME]: sanitizeLabelValue(workload.metadata.name),
        [LABEL_WORKLOAD_NAMESPACE]: sanitizeLabelValue(workload.metadata.namespace ?? 'default'),
      };
      const containerSpec = this.buildContainerSpec(workload.metadata.annotations, labels);
      const image = workload.metadata.annotations?.[ANNOTATION_RUNTIME_IMAGE] ?? this.defaultWorkloadImage;
      if (!image) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: `placeWorkload(${workload.metadata.name}): no runtime image — set annotation ${ANNOTATION_RUNTIME_IMAGE} or driver defaultWorkloadImage`,
          retryable: false,
        });
      }
      containerSpec.Image = image;
      containerSpec.Env = [
        ...containerSpec.Env ?? [],
        `${ENV_WORKLOAD}=${
          JSON.stringify({
            apiVersion: workload.apiVersion,
            kind: workload.kind,
            name: workload.metadata.name,
            namespace: workload.metadata.namespace ?? 'default',
            uid: workload.metadata.uid,
            generation: workload.metadata.generation,
            spec: workload.spec,
          })
        }`,
        ...(options.scriptSource !== undefined ? [`${ENV_WORKLOAD_SCRIPT}=${options.scriptSource}`] : []),
      ];
      const serviceSpec = {
        Name: name,
        Labels: labels,
        TaskTemplate: {
          ContainerSpec: containerSpec,
          Resources: this.buildResources(workload.metadata.annotations),
          RestartPolicy: this.buildWorkloadRestartPolicy(workload),
          Placement: { Constraints: this.buildPlacementConstraints(workload) },
        },
        Mode: this.buildWorkloadMode(workload),
      };
      const created = await this.client.request<{ ID: string }>('POST', '/services/create', {
        body: serviceSpec,
        signal: options.signal,
      });
      const nodeName = await this.resolveServiceNode(created.ID, options.signal) ??
        workload.spec.placement?.requiredNode ??
        'unassigned';
      return {
        externalId: name,
        nodeName,
        providerMetadata: { 'swarm.service.id': created.ID },
      };
    } catch (error) {
      throw toSwarmDriverError(error, `placeWorkload(${workload.metadata.name})`);
    }
  }

  /** Inspect a workload service and fold its task states into a status phase. */
  async getWorkloadStatus(externalId: string, options: SwarmDriverCallOptions = {}): Promise<ExternalStatusResult> {
    try {
      const service = await this.getService(externalId, options.signal);
      const tasks = await this.listTasks({ service: { [service.ID]: true } }, options.signal);
      return await this.withRuntimeResult(this.statusFromTasks(externalId, tasks), externalId, options.signal);
    } catch (error) {
      throw toSwarmDriverError(error, `getWorkloadStatus(${externalId})`);
    }
  }

  /** Remove the Swarm service backing a workload. */
  async stopWorkload(externalId: string, _actor: ControlStoreActor, options: SwarmDriverCallOptions = {}): Promise<void> {
    try {
      await this.client.request('DELETE', `/services/${encodeURIComponent(externalId)}`, { signal: options.signal });
    } catch (error) {
      throw toSwarmDriverError(error, `stopWorkload(${externalId})`);
    }
  }

  /**
   * Execute a ToolOperation as a one-shot replicated-job Swarm service with
   * `RestartPolicy: none`. When `spec.idempotencyKey` is set, an existing
   * service carrying the same idempotency-key label is adopted instead of
   * creating a duplicate.
   */
  async executeToolOperation(
    operation: ToolOperationResource,
    _actor: ControlStoreActor,
    options: SwarmDriverCallOptions = {},
  ): Promise<ExternalPlacementResult> {
    try {
      const annotations = operation.metadata.annotations;
      const idempotencyKey = operation.spec.idempotencyKey;
      const existingByUid = await this.findServiceByLabel(LABEL_OPERATION_UID, operation.metadata.uid, options.signal);
      if (existingByUid) {
        return {
          externalId: existingByUid.Spec?.Name ?? existingByUid.ID,
          nodeName: await this.resolveServiceNode(existingByUid.ID, options.signal) ?? 'unassigned',
          providerMetadata: { 'swarm.service.id': existingByUid.ID, 'memeloop.adopted': 'true' },
        };
      }
      if (idempotencyKey) {
        const existing = await this.findServiceByLabel(LABEL_IDEMPOTENCY_KEY, idempotencyKey, options.signal);
        if (existing) {
          const name = existing.Spec?.Name ?? existing.ID;
          return {
            externalId: name,
            nodeName: await this.resolveServiceNode(existing.ID, options.signal) ?? 'unassigned',
            providerMetadata: { 'swarm.service.id': existing.ID, 'memeloop.adopted': 'true' },
          };
        }
      }
      const image = annotations?.[ANNOTATION_RUNTIME_IMAGE] ?? this.defaultToolImage;
      if (!image) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: `executeToolOperation(${operation.metadata.name}): no runtime image — set annotation ${ANNOTATION_RUNTIME_IMAGE} or driver defaultToolImage`,
          retryable: false,
        });
      }
      const name = toolOperationServiceName(operation.metadata.name, operation.metadata.uid);
      const labels: Record<string, string> = {
        [LABEL_MANAGED_BY]: MANAGED_BY_VALUE,
        [LABEL_RESOURCE_KIND]: 'ToolOperation',
        [LABEL_OPERATION_UID]: sanitizeLabelValue(operation.metadata.uid),
        [LABEL_OPERATION_NAME]: sanitizeLabelValue(operation.metadata.name),
        [LABEL_OPERATION_NAMESPACE]: sanitizeLabelValue(operation.metadata.namespace ?? 'default'),
        ...(idempotencyKey ? { [LABEL_IDEMPOTENCY_KEY]: sanitizeLabelValue(idempotencyKey) } : {}),
      };
      const containerSpec = this.buildContainerSpec(annotations, labels);
      containerSpec.Image = image;
      containerSpec.Env = [
        ...containerSpec.Env ?? [],
        `MEMELOOP_TOOL_OPERATION=${
          JSON.stringify({
            toolRef: operation.spec.toolRef,
            arguments: operation.spec.arguments ?? {},
            effect: operation.spec.effect,
            idempotencyKey: idempotencyKey ?? null,
          })
        }`,
      ];
      const serviceSpec = {
        Name: name,
        Labels: labels,
        TaskTemplate: {
          ContainerSpec: containerSpec,
          RestartPolicy: { Condition: 'none' },
        },
        Mode: { ReplicatedJob: { MaxConcurrent: 1, TotalCompletions: 1 } },
      };
      const created = await this.client.request<{ ID: string }>('POST', '/services/create', {
        body: serviceSpec,
        signal: options.signal,
      });
      return {
        externalId: name,
        nodeName: await this.resolveServiceNode(created.ID, options.signal) ?? 'unassigned',
        providerMetadata: { 'swarm.service.id': created.ID },
      };
    } catch (error) {
      throw toSwarmDriverError(error, `executeToolOperation(${operation.metadata.name})`);
    }
  }

  /** Inspect the one-shot service backing a tool operation. */
  async getToolOperationStatus(externalId: string, options: SwarmDriverCallOptions = {}): Promise<ExternalStatusResult> {
    try {
      const service = await this.getService(externalId, options.signal);
      const tasks = await this.listTasks({ service: { [service.ID]: true } }, options.signal);
      return await this.withRuntimeResult(this.statusFromTasks(externalId, tasks), externalId, options.signal);
    } catch (error) {
      throw toSwarmDriverError(error, `getToolOperationStatus(${externalId})`);
    }
  }

  /** Cancel a tool operation by deleting its one-shot service. */
  async cancelToolOperation(externalId: string, _actor: ControlStoreActor, options: SwarmDriverCallOptions = {}): Promise<void> {
    try {
      await this.client.request('DELETE', `/services/${encodeURIComponent(externalId)}`, { signal: options.signal });
    } catch (error) {
      throw toSwarmDriverError(error, `cancelToolOperation(${externalId})`);
    }
  }

  /** List every memeloop-managed workload service with its folded status. */
  async listWorkloads(options: SwarmDriverCallOptions = {}): Promise<ExternalStatusResult[]> {
    return await this.listByKind('AgentWorkload', options.signal);
  }

  /** List every memeloop-managed tool-operation service with its folded status. */
  async listToolOperations(options: SwarmDriverCallOptions = {}): Promise<ExternalStatusResult[]> {
    return await this.listByKind('ToolOperation', options.signal);
  }

  /** Probe `GET /_ping`; never throws — unhealthy is a value, not an error. */
  async getHealth(options: SwarmDriverCallOptions = {}): Promise<{ healthy: boolean; detail?: string; checkedAt: string }> {
    const checkedAt = new Date().toISOString();
    try {
      const body = await this.client.request<string>('GET', '/_ping', { signal: options.signal });
      return { healthy: true, detail: typeof body === 'string' ? body.trim() : 'OK', checkedAt };
    } catch (error) {
      const mapped = toSwarmDriverError(error, 'getHealth');
      return { healthy: false, detail: `${mapped.code}: ${mapped.message}`, checkedAt };
    }
  }

  /* ---------------------------- internals ---------------------------- */

  private buildContainerSpec(
    annotations: Record<string, string> | undefined,
    labels: Record<string, string>,
  ): {
    Image?: string;
    Command?: string[];
    Env?: string[];
    Labels: Record<string, string>;
    ReadOnly: boolean;
    Init: boolean;
    CapabilityDrop: string[];
  } {
    const image = annotations?.[ANNOTATION_RUNTIME_IMAGE];
    return {
      ...(image ? { Image: image } : {}),
      ...this.parseJsonAnnotation<string[]>(annotations, ANNOTATION_RUNTIME_COMMAND, (value) => ({
        Command: value,
      })),
      ...this.parseJsonAnnotation<Record<string, string>>(annotations, ANNOTATION_RUNTIME_ENV, (value) => ({
        Env: Object.entries(value).map(([key, value_]) => `${key}=${value_}`),
      })),
      ReadOnly: true,
      Init: true,
      CapabilityDrop: ['ALL'],
      // Task-level labels allow label-filtered `GET /tasks` for list/status.
      Labels: { ...labels },
    };
  }

  private buildResources(annotations: Record<string, string> | undefined): {
    Limits?: { NanoCPUs?: number; MemoryBytes?: number };
    Reservations?: { NanoCPUs?: number; MemoryBytes?: number };
  } {
    const cpuText = annotations?.[ANNOTATION_RUNTIME_CPU];
    const memoryText = annotations?.[ANNOTATION_RUNTIME_MEMORY];
    const resources: { NanoCPUs?: number; MemoryBytes?: number } = {};
    if (cpuText !== undefined) {
      const cpu = Number.parseFloat(cpuText);
      if (!Number.isFinite(cpu) || cpu <= 0) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: `annotation ${ANNOTATION_RUNTIME_CPU} must be a positive number of CPU cores, got ${JSON.stringify(cpuText)}`,
          retryable: false,
        });
      }
      resources.NanoCPUs = Math.round(cpu * 1e9);
    }
    if (memoryText !== undefined) {
      const memory = Number.parseInt(memoryText, 10);
      if (!Number.isFinite(memory) || memory <= 0) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: `annotation ${ANNOTATION_RUNTIME_MEMORY} must be a positive byte count, got ${JSON.stringify(memoryText)}`,
          retryable: false,
        });
      }
      resources.MemoryBytes = memory;
    }
    if (resources.NanoCPUs === undefined && resources.MemoryBytes === undefined) return {};
    return { Limits: { ...resources }, Reservations: { ...resources } };
  }

  private buildWorkloadRestartPolicy(workload: AgentWorkloadResource): { Condition: string } {
    switch (workload.spec.completionPolicy) {
      case 'complete':
        return { Condition: 'none' };
      case 'daemon':
        return { Condition: 'any' };
      default:
        return { Condition: 'on-failure' };
    }
  }

  private buildWorkloadMode(workload: AgentWorkloadResource): Record<string, unknown> {
    if (workload.spec.completionPolicy === 'complete') {
      return { ReplicatedJob: { MaxConcurrent: 1, TotalCompletions: 1 } };
    }
    return { Replicated: { Replicas: 1 } };
  }

  /**
   * Translate memeloop placement into Swarm placement constraints. This is the
   * explicit co-location contract: `nodeSelector` becomes `node.labels.*`
   * equality constraints and `requiredNode` becomes a `node.hostname`
   * constraint. `antiAffinity` cannot be expressed in Swarm and is rejected
   * rather than silently dropped.
   */
  private buildPlacementConstraints(workload: AgentWorkloadResource): string[] {
    const placement = workload.spec.placement;
    if (!placement) return [];
    if (placement.antiAffinity && placement.antiAffinity.length > 0) {
      throw new OrchestrationError({
        code: 'UNSUPPORTED',
        message: 'Docker Swarm cannot express workload anti-affinity; split the placement across drivers or relax the requirement',
        retryable: false,
        details: { antiAffinity: placement.antiAffinity },
      });
    }
    const constraints: string[] = [];
    for (const [key, value] of Object.entries(placement.nodeSelector ?? {})) {
      constraints.push(`node.labels.${key}==${value}`);
    }
    if (placement.requiredNode) {
      constraints.push(`node.hostname==${placement.requiredNode}`);
    }
    return constraints;
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  private parseJsonAnnotation<T>(
    annotations: Record<string, string> | undefined,
    key: string,
    build: (value: T) => Record<string, unknown>,
  ): Record<string, unknown> {
    const raw = annotations?.[key];
    if (raw === undefined) return {};
    try {
      return build(JSON.parse(raw) as T);
    } catch {
      throw new OrchestrationError({
        code: 'INVALID',
        message: `annotation ${key} is not valid JSON: ${JSON.stringify(raw)}`,
        retryable: false,
      });
    }
  }

  private async getService(externalId: string, signal?: AbortSignal): Promise<EngineService> {
    return await this.client.request<EngineService>('GET', `/services/${encodeURIComponent(externalId)}`, { signal });
  }

  private async findServiceByLabel(labelKey: string, labelValue: string, signal?: AbortSignal): Promise<EngineService | undefined> {
    const filters = JSON.stringify({ label: [`${labelKey}=${sanitizeLabelValue(labelValue)}`] });
    const services = await this.client.request<EngineService[]>('GET', '/services', {
      query: { filters },
      signal,
    });
    return services[0];
  }

  private async listTasks(filters: Record<string, Record<string, boolean>>, signal?: AbortSignal): Promise<EngineTask[]> {
    return await this.client.request<EngineTask[]>('GET', '/tasks', {
      query: { filters: JSON.stringify(filters) },
      signal,
    });
  }

  private async resolveServiceNode(serviceId: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const tasks = await this.listTasks({ service: { [serviceId]: true } }, signal);
      return tasks.find((task) => task.NodeID)?.NodeID;
    } catch {
      return undefined;
    }
  }

  private statusFromTasks(externalId: string, tasks: EngineTask[]): ExternalStatusResult {
    // Prefer tasks the orchestrator still wants running; when none remain
    // (e.g. a finished one-shot job), fall back to the terminal tasks so the
    // Succeeded/Failed evidence is not lost.
    const live = tasks.filter((task) => task.DesiredState !== 'shutdown');
    const relevant = live.length > 0 ? live : tasks;
    const observedAt = relevant
      .map((task) => task.Status?.Timestamp)
      .filter((t): t is string => typeof t === 'string')
      .sort()
      .at(-1) ?? new Date().toISOString();
    const failed = relevant.find((task) => FAILED_TASK_STATES.has(task.Status?.State ?? ''));
    if (failed) {
      return {
        externalId,
        phase: 'Failed',
        message: failed.Status?.Err ?? `task ${failed.ID} ${failed.Status?.State}`,
        observedAt,
      };
    }
    if (relevant.some((task) => task.Status?.State === 'running')) {
      return { externalId, phase: 'Running', observedAt };
    }
    if (relevant.some((task) => RUNNING_TASK_STATES.has(task.Status?.State ?? ''))) {
      return { externalId, phase: 'Pending', observedAt };
    }
    if (relevant.length > 0 && relevant.every((task) => FINISHED_TASK_STATES.has(task.Status?.State ?? ''))) {
      return { externalId, phase: 'Succeeded', observedAt };
    }
    return { externalId, phase: 'Pending', observedAt };
  }

  private async withRuntimeResult(
    status: ExternalStatusResult,
    externalId: string,
    signal?: AbortSignal,
  ): Promise<ExternalStatusResult> {
    if (status.phase !== 'Succeeded' && status.phase !== 'Failed') return status;
    const logTail = await this.client.request<string>('GET', `/services/${encodeURIComponent(externalId)}/logs`, {
      query: { stdout: '1', stderr: '0', tail: '20', timestamps: '0' },
      signal,
      maxResponseBytes: MAX_RUNTIME_LOG_BYTES,
    });
    if (typeof logTail !== 'string') return status;
    const runtimeResult = parseExternalRuntimeResult(logTail);
    return runtimeResult ? { ...status, runtimeResult } : status;
  }

  private async listByKind(kind: 'AgentWorkload' | 'ToolOperation', signal?: AbortSignal): Promise<ExternalStatusResult[]> {
    try {
      const filters = JSON.stringify({ label: [`${LABEL_MANAGED_BY}=${MANAGED_BY_VALUE}`, `${LABEL_RESOURCE_KIND}=${kind}`] });
      const [services, tasks] = await Promise.all([
        this.client.request<EngineService[]>('GET', '/services', { query: { filters }, signal }),
        this.listTasks({ label: { [`${LABEL_MANAGED_BY}=${MANAGED_BY_VALUE}`]: true, [`${LABEL_RESOURCE_KIND}=${kind}`]: true } }, signal),
      ]);
      const tasksByService = new Map<string, EngineTask[]>();
      for (const task of tasks) {
        const bucket = tasksByService.get(task.ServiceID) ?? [];
        bucket.push(task);
        tasksByService.set(task.ServiceID, bucket);
      }
      return services.map((service) => {
        const externalId = service.Spec?.Name ?? service.ID;
        return this.statusFromTasks(externalId, tasksByService.get(service.ID) ?? []);
      });
    } catch (error) {
      throw toSwarmDriverError(error, `list(${kind})`);
    }
  }
}
