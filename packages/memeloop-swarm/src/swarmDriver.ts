import fs from 'node:fs';

import type {
  AgentWorkloadResource,
  AgentWorkloadResourceRequirements,
  ControlStoreActor,
  ExternalDriverCapabilities,
  ExternalOrchestrationDriver,
  ExternalPlacementResult,
  ExternalStatusResult,
  ExternalToolContract,
  ExternalWorkloadPlacementContext,
  ExternalWorkloadRuntimeContract,
  ToolOperationResource,
} from 'memeloop';
import {
  assertExternalToolContracts,
  assertExternalToolOperationContract,
  assertExternalWorkloadRuntimeContracts,
  createMinimalExternalRuntimeToolContracts,
  OrchestrationError,
  parseExternalRuntimeResult,
  resolveExternalWorkloadResources,
  resolveExternalWorkloadRuntime,
} from 'memeloop';

import { DockerEngineClient } from './engineClient.js';
import type { DockerEngineClientOptions } from './engineClient.js';
import { toSwarmDriverError } from './errors.js';
import {
  ANNOTATION_RUNTIME_COMMAND,
  ANNOTATION_RUNTIME_ENV,
  ANNOTATION_RUNTIME_IMAGE,
  ENV_WORKER_BOOTSTRAP_FILE,
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
  WORKER_BOOTSTRAP_PATH,
  workloadServiceName,
} from './labels.js';

/** Per-call options accepted by every driver method (optional third parameter). */
export interface SwarmDriverCallOptions {
  /** Cancellation signal honoured by the underlying HTTP request. */
  signal?: AbortSignal;
}

export interface SwarmDriverOptions extends DockerEngineClientOptions {
  /**
   * Shorthand for a host-owned `default` workload runtime contract.
   * Workload-supplied image/command/environment annotations are rejected.
   */
  defaultWorkloadImage?: string;
  /** Host-owned runtimeClass mappings; supersedes runtime annotations. */
  workloadRuntimes?: ExternalWorkloadRuntimeContract[];
  /**
   * Fallback container image for ToolOperation executions whose metadata does
   * not carry the `memeloop.io/runtime-image` annotation. When neither is
   * present, `executeToolOperation` fails with an `INVALID` error.
   */
  defaultToolImage?: string;
  /**
   * Path to a 0600/0400 JSON Docker AuthConfig used only as the
   * X-Registry-Auth header for service creation. The file is re-read for
   * credential rotation and never copied into service state.
   */
  registryAuthFile?: string;
  /**
   * Trusted contracts implemented by configured tool images. When omitted,
   * only the two bundled minimal-runtime tools are admitted for
   * `defaultToolImage`.
   */
  toolContracts?: ExternalToolContract[];
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
const DEFAULT_WORKLOAD_RESOURCES = {
  cpuMillicores: 1000,
  memoryBytes: 512 * 1024 * 1024,
} as const;

/**
 * Docker Swarm backend for the memeloop `ExternalOrchestrationDriver`
 * contract (docs/AGENT_ORCHESTRATION_PLAN.md §24.62).
 *
 * Resource mapping (documented minimal mapping — executable runtime details
 * come from host-owned contracts, not workload-authored annotations):
 *
 * | memeloop field                                   | Swarm service field                                             |
 * | ------------------------------------------------ | --------------------------------------------------------------- |
 * | `spec.runtimeClass`                              | host-owned `workloadRuntimes` image/command/environment        |
 * | `spec.resources.cpuMillicores`                    | `Resources.{Limits,Reservations}.NanoCPUs`                     |
 * | `spec.resources.memoryBytes`                      | `Resources.{Limits,Reservations}.MemoryBytes`                  |
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
  private readonly workloadRuntimes: ExternalWorkloadRuntimeContract[];
  private readonly defaultToolImage?: string;
  private readonly registryAuthFile?: string;
  private readonly toolContracts: ExternalToolContract[];

  constructor(options: SwarmDriverOptions = {}) {
    this.client = new DockerEngineClient(options);
    this.workloadRuntimes = structuredClone(
      options.workloadRuntimes ??
        (options.defaultWorkloadImage
          ? [{
            runtimeClass: 'default',
            image: options.defaultWorkloadImage,
            resources: DEFAULT_WORKLOAD_RESOURCES,
          }]
          : []),
    );
    assertExternalWorkloadRuntimeContracts(this.workloadRuntimes);
    this.defaultToolImage = options.defaultToolImage;
    this.registryAuthFile = options.registryAuthFile;
    this.toolContracts = structuredClone(
      options.toolContracts ??
        (options.defaultToolImage
          ? createMinimalExternalRuntimeToolContracts(options.defaultToolImage)
          : []),
    );
    assertExternalToolContracts(this.toolContracts);
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
        toolContracts: structuredClone(this.toolContracts),
        workloadRuntimes: structuredClone(this.workloadRuntimes),
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
    let bootstrapSecretId: string | undefined;
    let bootstrapSecretName: string | undefined;
    try {
      const runtime = resolveExternalWorkloadRuntime(workload, this.workloadRuntimes);
      const workloadResources = resolveExternalWorkloadResources(workload, runtime);
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
      const containerSpec = this.buildContainerSpec(undefined, labels);
      containerSpec.Image = runtime.image;
      if (runtime.command) containerSpec.Command = [...runtime.command];
      if (runtime.environment) {
        containerSpec.Env = Object.entries(runtime.environment)
          .map(([key, value]) => `${key}=${value}`);
      }
      if (options.workerBootstrap) {
        bootstrapSecretName = `${name}-bootstrap`;
        // The deterministic Secret may be an orphan from a controller crash
        // before service creation. No service with this workload UID exists
        // (checked above), so it is safe to replace with the new enrollment.
        await this.deleteBootstrapSecrets(bootstrapSecretName, options.signal);
        const secret = await this.client.request<{ ID: string }>('POST', '/secrets/create', {
          body: {
            Name: bootstrapSecretName,
            Labels: labels,
            Data: Buffer.from(JSON.stringify(options.workerBootstrap), 'utf8').toString('base64'),
          },
          signal: options.signal,
        });
        bootstrapSecretId = secret.ID;
        containerSpec.Secrets = [{
          File: {
            Name: 'memeloop-bootstrap.json',
            UID: '1000',
            GID: '1000',
            Mode: 0o400,
          },
          SecretID: secret.ID,
          SecretName: bootstrapSecretName,
        }];
      }
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
        ...(bootstrapSecretId ? [`${ENV_WORKER_BOOTSTRAP_FILE}=${WORKER_BOOTSTRAP_PATH}`] : []),
      ];
      const serviceSpec = {
        Name: name,
        Labels: labels,
        TaskTemplate: {
          ContainerSpec: containerSpec,
          Resources: this.buildResources(workloadResources),
          RestartPolicy: this.buildWorkloadRestartPolicy(workload),
          Placement: { Constraints: this.buildPlacementConstraints(workload) },
        },
        Mode: this.buildWorkloadMode(workload),
      };
      const registryAuth = this.readRegistryAuth();
      const created = await this.client.request<{ ID: string }>('POST', '/services/create', {
        body: serviceSpec,
        signal: options.signal,
        ...(registryAuth ? { registryAuth } : {}),
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
      if (bootstrapSecretId) {
        try {
          // Service creation can succeed even when its HTTP response is lost.
          // Do not remove a Secret from an adopted live service.
          const workloadExists = Boolean(
            await this.findServiceByLabel(LABEL_WORKLOAD_UID, workload.metadata.uid, options.signal),
          );
          if (!workloadExists) {
            await this.client.request('DELETE', `/secrets/${encodeURIComponent(bootstrapSecretId)}`, {
              signal: options.signal,
            });
          }
        } catch {
          // Preserve both the Secret and placement error on uncertainty. A
          // retry adopts the service or replaces the orphan Secret.
        }
      }
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
      await this.deleteBootstrapSecrets(`${externalId}-bootstrap`, options.signal);
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
      if (
        annotations?.[ANNOTATION_RUNTIME_COMMAND] !== undefined ||
        annotations?.[ANNOTATION_RUNTIME_ENV] !== undefined ||
        annotations?.['memeloop.io/runtime-cpu'] !== undefined ||
        annotations?.['memeloop.io/runtime-memory'] !== undefined
      ) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: 'ToolOperation runtime command and environment are host-owned and cannot be supplied by the resource',
          retryable: false,
        });
      }
      const selectedImage = annotations?.[ANNOTATION_RUNTIME_IMAGE] ?? this.defaultToolImage;
      const contract = assertExternalToolOperationContract(operation, this.toolContracts, selectedImage);
      const image = selectedImage ?? contract.runtimeImages[0];
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
          Resources: this.buildResources(contract.resources),
          RestartPolicy: { Condition: 'none' },
        },
        Mode: { ReplicatedJob: { MaxConcurrent: 1, TotalCompletions: 1 } },
      };
      const registryAuth = this.readRegistryAuth();
      const created = await this.client.request<{ ID: string }>('POST', '/services/create', {
        body: serviceSpec,
        signal: options.signal,
        ...(registryAuth ? { registryAuth } : {}),
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

  private readRegistryAuth(): string | undefined {
    if (!this.registryAuthFile) return undefined;
    const stat = fs.statSync(this.registryAuthFile);
    if (!stat.isFile() || stat.size < 2 || stat.size > 16 * 1024) {
      throw new Error('registryAuthFile must be a regular JSON file no larger than 16 KiB');
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error('registryAuthFile must not be readable or writable by group/others');
    }
    const raw = fs.readFileSync(this.registryAuthFile);
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('registryAuthFile must contain one Docker AuthConfig object');
    }
    const record = parsed as Record<string, unknown>;
    const allowed = new Set([
      'username',
      'password',
      'auth',
      'email',
      'serveraddress',
      'identitytoken',
      'registrytoken',
    ]);
    const hasCredential = ['auth', 'identitytoken', 'registrytoken']
      .some((key) => typeof record[key] === 'string') ||
      (typeof record.username === 'string' && typeof record.password === 'string');
    if (
      Object.keys(record).some((key) => !allowed.has(key)) ||
      Object.values(record).some((value) => typeof value !== 'string') ||
      !hasCredential
    ) {
      throw new Error('registryAuthFile contains an invalid Docker AuthConfig');
    }
    return raw.toString('base64url');
  }

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
    Secrets?: Array<{
      File: { Name: string; UID: string; GID: string; Mode: number };
      SecretID: string;
      SecretName: string;
    }>;
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

  private async deleteBootstrapSecrets(name: string, signal?: AbortSignal): Promise<void> {
    const secrets = await this.client.request<Array<{ ID: string }>>('GET', '/secrets', {
      query: { filters: JSON.stringify({ name: [name] }) },
      signal,
    });
    for (const secret of secrets) {
      await this.client.request('DELETE', `/secrets/${encodeURIComponent(secret.ID)}`, { signal });
    }
  }

  private buildResources(requirements: AgentWorkloadResourceRequirements | undefined): {
    Limits?: { NanoCPUs?: number; MemoryBytes?: number };
    Reservations?: { NanoCPUs?: number; MemoryBytes?: number };
  } {
    const resources: { NanoCPUs?: number; MemoryBytes?: number } = {};
    if (requirements?.cpuMillicores !== undefined) {
      if (!Number.isSafeInteger(requirements.cpuMillicores) || requirements.cpuMillicores <= 0) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: 'spec.resources.cpuMillicores must be a positive safe integer',
          retryable: false,
        });
      }
      resources.NanoCPUs = requirements.cpuMillicores * 1_000_000;
    }
    if (requirements?.memoryBytes !== undefined) {
      if (!Number.isSafeInteger(requirements.memoryBytes) || requirements.memoryBytes <= 0) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: 'spec.resources.memoryBytes must be a positive safe integer',
          retryable: false,
        });
      }
      resources.MemoryBytes = requirements.memoryBytes;
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
