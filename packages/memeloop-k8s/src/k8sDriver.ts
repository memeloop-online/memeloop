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

import { KubernetesApiClient } from './apiClient.js';
import type { KubernetesApiClientOptions } from './apiClient.js';
import { toK8sDriverError } from './errors.js';
import {
  ANNOTATION_RUNTIME_COMMAND,
  ANNOTATION_RUNTIME_ENV,
  ANNOTATION_RUNTIME_IMAGE,
  ENV_TOOL_OPERATION,
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
  toolOperationJobName,
  WORKER_BOOTSTRAP_PATH,
  workloadObjectName,
} from './labels.js';

/** Per-call options accepted by every driver method (optional third parameter). */
export interface K8sDriverCallOptions {
  /** Cancellation signal honoured by the underlying HTTPS request. */
  signal?: AbortSignal;
}

const MAX_INLINE_SCRIPT_BYTES = 96 * 1024;
const MAX_RUNTIME_LOG_BYTES = 128 * 1024;

export interface K8sDriverOptions extends KubernetesApiClientOptions {
  /** Namespace the driver manages. Defaults to `default`. */
  namespace?: string;
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
   * Existing namespace-local image-pull Secret names. Credential material
   * stays in Kubernetes and never enters the driver manifest or pod env.
   */
  imagePullSecrets?: string[];
  /** `ttlSecondsAfterFinished` for ToolOperation Jobs. Defaults to 3600. */
  toolJobTtlSecondsAfterFinished?: number;
  /**
   * Trusted contracts implemented by configured tool images. When omitted,
   * only the two bundled minimal-runtime tools are admitted for
   * `defaultToolImage`.
   */
  toolContracts?: ExternalToolContract[];
}

/* ------------------------------------------------------------------ */
/* Minimal Kubernetes API shapes (only fields the driver consumes)     */
/* ------------------------------------------------------------------ */

interface K8sObjectMeta {
  name?: string;
  uid?: string;
  labels?: Record<string, string>;
}

interface K8sJobCondition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
}

interface K8sJob {
  metadata?: K8sObjectMeta;
  status?: {
    active?: number;
    succeeded?: number;
    failed?: number;
    conditions?: K8sJobCondition[];
  };
}

interface K8sDeployment {
  metadata?: K8sObjectMeta;
  status?: {
    replicas?: number;
    readyReplicas?: number;
    updatedReplicas?: number;
    conditions?: K8sJobCondition[];
  };
}

interface K8sList<T> {
  items?: T[];
}

interface K8sPod {
  metadata?: K8sObjectMeta;
  spec?: { nodeName?: string };
}

const DEFAULT_NAMESPACE = 'default';
const DEFAULT_TOOL_JOB_TTL_SECONDS = 3600;
const DEFAULT_WORKLOAD_RESOURCES = {
  cpuMillicores: 1000,
  memoryBytes: 512 * 1024 * 1024,
} as const;

/**
 * Kubernetes/K3s backend for the memeloop `ExternalOrchestrationDriver`
 * contract (docs/AGENT_ORCHESTRATION_PLAN.md §24.62).
 *
 * Resource mapping (namespace-scoped; executable runtime details come from
 * host-owned contracts, not workload-authored annotations):
 *
 * | memeloop field                                    | Kubernetes field                                              |
 * | ------------------------------------------------- | ------------------------------------------------------------- |
 * | `spec.completionPolicy` = `complete`/unset        | `batch/v1 Job` (run-once)                                     |
 * | `spec.completionPolicy` = `daemon`/`detach`       | `apps/v1 Deployment` (service lifecycle)                      |
 * | `spec.runtimeClass`                               | host-owned `workloadRuntimes` image/command/environment       |
 * | `spec.resources.cpuMillicores` / `memoryBytes`    | container `resources.{requests,limits}`                       |
 * | `spec.placement.nodeSelector`                     | pod template `nodeSelector`                                   |
 * | `spec.placement.requiredNode`                     | pod template `nodeName`                                       |
 * | `spec.placement.antiAffinity`                     | `podAntiAffinity` required term on `memeloop.io/workload-name` |
 * | ToolOperation                                     | `batch/v1 Job`, `backoffLimit: 0`, `ttlSecondsAfterFinished`  |
 * | identity                                          | `memeloop.io/*` labels + `MEMELOOP_*` env payloads            |
 *
 * Isolation honesty: namespace + container isolation only; the driver never
 * claims host-level isolation. Co-location is explicit through
 * `nodeSelector`/`nodeName`/affinity on the created pod template.
 */
export class KubernetesOrchestrationDriver implements ExternalOrchestrationDriver {
  private readonly client: KubernetesApiClient;
  private readonly namespace: string;
  private readonly workloadRuntimes: ExternalWorkloadRuntimeContract[];
  private readonly defaultToolImage?: string;
  private readonly imagePullSecrets: string[];
  private readonly toolJobTtlSeconds: number;
  private readonly toolContracts: ExternalToolContract[];

  constructor(options: K8sDriverOptions) {
    this.client = new KubernetesApiClient(options);
    this.namespace = options.namespace ?? DEFAULT_NAMESPACE;
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
    this.toolContracts = structuredClone(
      options.toolContracts ??
        (options.defaultToolImage
          ? createMinimalExternalRuntimeToolContracts(options.defaultToolImage)
          : []),
    );
    assertExternalToolContracts(this.toolContracts);
    this.imagePullSecrets = [...new Set(options.imagePullSecrets ?? [])];
    if (
      this.imagePullSecrets.some((name) => name.length > 253 || !/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(name))
    ) {
      throw new Error('imagePullSecrets must contain valid non-empty Kubernetes object names');
    }
    this.toolJobTtlSeconds = options.toolJobTtlSecondsAfterFinished ?? DEFAULT_TOOL_JOB_TTL_SECONDS;
  }

  /** Report capabilities from `/version` plus `batch/v1` and `apps/v1` discovery. */
  async getCapabilities(): Promise<ExternalDriverCapabilities> {
    try {
      const [version, batch, apps] = await Promise.all([
        this.client.request<{ gitVersion?: string }>('GET', '/version'),
        this.client.request<{ groupVersion?: string }>('GET', '/apis/batch/v1'),
        this.client.request<{ groupVersion?: string }>('GET', '/apis/apps/v1'),
      ]);
      if (batch.groupVersion !== 'batch/v1' || apps.groupVersion !== 'apps/v1') {
        throw new OrchestrationError({
          code: 'UNSUPPORTED',
          message: 'API server does not serve batch/v1 and apps/v1; the driver requires both',
          retryable: false,
        });
      }
      return {
        name: 'memeloop-k8s',
        version: version.gitVersion ?? 'unknown',
        manages: ['AgentWorkload', 'ToolOperation'],
        supportsColocation: true,
        supportsAdoption: true,
        toolContracts: structuredClone(this.toolContracts),
        workloadRuntimes: structuredClone(this.workloadRuntimes),
      };
    } catch (error) {
      throw toK8sDriverError(error, 'getCapabilities');
    }
  }

  /** Create a Job (run-once) or Deployment (service lifecycle) from an AgentWorkload. */
  async placeWorkload(
    workload: AgentWorkloadResource,
    _actor: ControlStoreActor,
    options: K8sDriverCallOptions & ExternalWorkloadPlacementContext = {},
  ): Promise<ExternalPlacementResult> {
    const name = workloadObjectName(workload.metadata.name, workload.metadata.uid);
    let bootstrapSecretCreated = false;
    try {
      const runtime = resolveExternalWorkloadRuntime(workload, this.workloadRuntimes);
      const workloadResources = resolveExternalWorkloadResources(workload, runtime);
      // Placement is an external side effect. Adopt by immutable MemeLoop UID
      // so a controller crash after POST but before status persistence cannot
      // create a duplicate Job/Deployment on retry.
      const workloadUid = sanitizeLabelValue(workload.metadata.uid);
      const selector = `${LABEL_WORKLOAD_UID}=${workloadUid}`;
      const [existingJobs, existingDeployments] = await Promise.all([
        this.client.request<K8sList<K8sJob>>('GET', `/apis/batch/v1/namespaces/${this.namespace}/jobs`, {
          query: { labelSelector: selector },
          signal: options.signal,
        }),
        this.client.request<K8sList<K8sDeployment>>('GET', `/apis/apps/v1/namespaces/${this.namespace}/deployments`, {
          query: { labelSelector: selector },
          signal: options.signal,
        }),
      ]);
      const existingJob = existingJobs.items?.[0];
      const existingDeployment = existingDeployments.items?.[0];
      const existing = existingJob ?? existingDeployment;
      if (existing?.metadata?.name) {
        return {
          externalId: existing.metadata.name,
          nodeName: await this.resolvePodNode(selector, options.signal) ??
            workload.spec.placement?.requiredNode ??
            'unscheduled',
          providerMetadata: {
            'k8s.namespace': this.namespace,
            'k8s.kind': existingJob ? 'Job' : 'Deployment',
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
      const labels: Record<string, string> = {
        [LABEL_MANAGED_BY]: MANAGED_BY_VALUE,
        [LABEL_RESOURCE_KIND]: 'AgentWorkload',
        [LABEL_WORKLOAD_UID]: workloadUid,
        [LABEL_WORKLOAD_NAME]: sanitizeLabelValue(workload.metadata.name),
        [LABEL_WORKLOAD_NAMESPACE]: sanitizeLabelValue(workload.metadata.namespace ?? 'default'),
      };
      const bootstrapSecretName = options.workerBootstrap ? `${name}-bootstrap` : undefined;
      if (options.workerBootstrap) {
        // A controller may have crashed after creating the deterministic
        // Secret but before creating the workload. Since the UID lookup above
        // proved that no workload exists, replacing that orphan is safe and
        // lets a freshly issued one-time enrollment token take effect.
        await this.tryDeleteSecret(`${name}-bootstrap`, options.signal);
        await this.client.request('POST', `/api/v1/namespaces/${this.namespace}/secrets`, {
          body: {
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: {
              name: bootstrapSecretName,
              namespace: this.namespace,
              labels,
            },
            type: 'Opaque',
            stringData: {
              'bootstrap.json': JSON.stringify(options.workerBootstrap),
            },
          },
          signal: options.signal,
        });
        bootstrapSecretCreated = true;
      }
      const podTemplate = this.buildPodTemplate(labels, {
        image: runtime.image,
        ...(runtime.command ? { command: runtime.command } : {}),
        ...(runtime.environment ? { environment: runtime.environment } : {}),
        resources: workloadResources,
        extraEnv: [{
          name: ENV_WORKLOAD,
          value: JSON.stringify({
            apiVersion: workload.apiVersion,
            kind: workload.kind,
            name: workload.metadata.name,
            namespace: workload.metadata.namespace ?? 'default',
            uid: workload.metadata.uid,
            generation: workload.metadata.generation,
            spec: workload.spec,
          }),
        }, ...(options.scriptSource !== undefined ? [{ name: ENV_WORKLOAD_SCRIPT, value: options.scriptSource }] : [])],
        ...(bootstrapSecretName ? { bootstrapSecretName } : {}),
        restartPolicy: this.isServiceLifecycle(workload) ? 'Always' : 'Never',
        placement: workload.spec.placement,
      });
      const useDeployment = this.isServiceLifecycle(workload);
      if (useDeployment) {
        await this.client.request('POST', `/apis/apps/v1/namespaces/${this.namespace}/deployments`, {
          body: {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: { name, namespace: this.namespace, labels },
            spec: {
              replicas: 1,
              selector: { matchLabels: { [LABEL_WORKLOAD_UID]: labels[LABEL_WORKLOAD_UID] } },
              template: podTemplate,
            },
          },
          signal: options.signal,
        });
      } else {
        await this.client.request('POST', `/apis/batch/v1/namespaces/${this.namespace}/jobs`, {
          body: {
            apiVersion: 'batch/v1',
            kind: 'Job',
            metadata: { name, namespace: this.namespace, labels },
            spec: {
              backoffLimit: 1,
              template: podTemplate,
            },
          },
          signal: options.signal,
        });
      }
      const nodeName = await this.resolvePodNode(`${LABEL_WORKLOAD_UID}=${labels[LABEL_WORKLOAD_UID]}`, options.signal) ??
        workload.spec.placement?.requiredNode ??
        'unscheduled';
      return {
        externalId: name,
        nodeName,
        providerMetadata: {
          'k8s.namespace': this.namespace,
          'k8s.kind': useDeployment ? 'Deployment' : 'Job',
        },
      };
    } catch (error) {
      if (bootstrapSecretCreated) {
        try {
          // A timed-out POST may have created the workload even though the
          // client never received its response. Preserve the Secret whenever
          // adoption finds the workload (or the adoption check is uncertain);
          // only a confirmed absence makes cleanup safe.
          const workloadExists = await this.hasWorkloadWithUid(workload.metadata.uid, options.signal);
          if (!workloadExists) await this.tryDeleteSecret(`${name}-bootstrap`, options.signal);
        } catch {
          // Preserve both the Secret and the placement error on uncertainty.
          // A later retry adopts the workload or replaces the orphan Secret.
        }
      }
      throw toK8sDriverError(error, `placeWorkload(${workload.metadata.name})`);
    }
  }

  /**
   * Inspect a workload by name. The name alone does not record whether the
   * workload is a Job or a Deployment, so the driver probes Job first and
   * falls back to Deployment; two consecutive 404s surface as `NOT_FOUND`.
   */
  async getWorkloadStatus(externalId: string, options: K8sDriverCallOptions = {}): Promise<ExternalStatusResult> {
    try {
      const job = await this.tryGetJob(externalId, options.signal);
      if (job) return await this.withRuntimeResult(this.statusFromJob(externalId, job), job.metadata?.labels, options.signal);
      const deployment = await this.tryGetDeployment(externalId, options.signal);
      if (deployment) return this.statusFromDeployment(externalId, deployment);
      throw new OrchestrationError({
        code: 'NOT_FOUND',
        message: `workload ${externalId} not found as Job or Deployment in namespace ${this.namespace}`,
        retryable: false,
      });
    } catch (error) {
      throw toK8sDriverError(error, `getWorkloadStatus(${externalId})`);
    }
  }

  /** Delete the Job or Deployment backing a workload (foreground propagation). */
  async stopWorkload(externalId: string, _actor: ControlStoreActor, options: K8sDriverCallOptions = {}): Promise<void> {
    try {
      const deletedJob = await this.tryDelete('jobs', externalId, options.signal);
      const deletedDeployment = deletedJob
        ? false
        : await this.tryDelete('deployments', externalId, options.signal);
      if (!deletedJob && !deletedDeployment) {
        throw new OrchestrationError({
          code: 'NOT_FOUND',
          message: `workload ${externalId} not found as Job or Deployment in namespace ${this.namespace}`,
          retryable: false,
        });
      }
      await this.tryDeleteSecret(`${externalId}-bootstrap`, options.signal);
    } catch (error) {
      throw toK8sDriverError(error, `stopWorkload(${externalId})`);
    }
  }

  /**
   * Execute a ToolOperation as a `batch/v1` Job with `backoffLimit: 0` and
   * `ttlSecondsAfterFinished`. When `spec.idempotencyKey` is set, an existing
   * Job carrying the same idempotency-key label is adopted instead of
   * creating a duplicate.
   */
  async executeToolOperation(
    operation: ToolOperationResource,
    _actor: ControlStoreActor,
    options: K8sDriverCallOptions = {},
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
      const uidSelector = `${LABEL_OPERATION_UID}=${sanitizeLabelValue(operation.metadata.uid)}`;
      const existingByUid = await this.client.request<K8sList<K8sJob>>(
        'GET',
        `/apis/batch/v1/namespaces/${this.namespace}/jobs`,
        { query: { labelSelector: uidSelector }, signal: options.signal },
      );
      const adoptedByUid = existingByUid.items?.[0];
      if (adoptedByUid?.metadata?.name) {
        return {
          externalId: adoptedByUid.metadata.name,
          nodeName: await this.resolvePodNode(uidSelector, options.signal) ?? 'unscheduled',
          providerMetadata: { 'k8s.namespace': this.namespace, 'memeloop.adopted': 'true' },
        };
      }
      if (idempotencyKey) {
        const selector = `${LABEL_IDEMPOTENCY_KEY}=${sanitizeLabelValue(idempotencyKey)}`;
        const existing = await this.client.request<K8sList<K8sJob>>(
          'GET',
          `/apis/batch/v1/namespaces/${this.namespace}/jobs`,
          { query: { labelSelector: selector }, signal: options.signal },
        );
        const adopted = existing.items?.[0];
        if (adopted?.metadata?.name) {
          return {
            externalId: adopted.metadata.name,
            nodeName: await this.resolvePodNode(selector, options.signal) ?? 'unscheduled',
            providerMetadata: { 'k8s.namespace': this.namespace, 'memeloop.adopted': 'true' },
          };
        }
      }
      const name = toolOperationJobName(operation.metadata.name, operation.metadata.uid);
      const labels: Record<string, string> = {
        [LABEL_MANAGED_BY]: MANAGED_BY_VALUE,
        [LABEL_RESOURCE_KIND]: 'ToolOperation',
        [LABEL_OPERATION_UID]: sanitizeLabelValue(operation.metadata.uid),
        [LABEL_OPERATION_NAME]: sanitizeLabelValue(operation.metadata.name),
        [LABEL_OPERATION_NAMESPACE]: sanitizeLabelValue(operation.metadata.namespace ?? 'default'),
        ...(idempotencyKey ? { [LABEL_IDEMPOTENCY_KEY]: sanitizeLabelValue(idempotencyKey) } : {}),
      };
      const podTemplate = this.buildPodTemplate(labels, {
        image,
        resources: contract.resources,
        extraEnv: [{
          name: ENV_TOOL_OPERATION,
          value: JSON.stringify({
            toolRef: operation.spec.toolRef,
            arguments: operation.spec.arguments ?? {},
            effect: operation.spec.effect,
            idempotencyKey: idempotencyKey ?? null,
          }),
        }],
        restartPolicy: 'Never',
      });
      await this.client.request('POST', `/apis/batch/v1/namespaces/${this.namespace}/jobs`, {
        body: {
          apiVersion: 'batch/v1',
          kind: 'Job',
          metadata: { name, namespace: this.namespace, labels },
          spec: {
            backoffLimit: 0,
            ttlSecondsAfterFinished: this.toolJobTtlSeconds,
            template: podTemplate,
          },
        },
        signal: options.signal,
      });
      return {
        externalId: name,
        nodeName: await this.resolvePodNode(`${LABEL_OPERATION_UID}=${labels[LABEL_OPERATION_UID]}`, options.signal) ?? 'unscheduled',
        providerMetadata: { 'k8s.namespace': this.namespace },
      };
    } catch (error) {
      throw toK8sDriverError(error, `executeToolOperation(${operation.metadata.name})`);
    }
  }

  /** Inspect the Job backing a tool operation. */
  async getToolOperationStatus(externalId: string, options: K8sDriverCallOptions = {}): Promise<ExternalStatusResult> {
    try {
      const job = await this.tryGetJob(externalId, options.signal);
      if (!job) {
        throw new OrchestrationError({
          code: 'NOT_FOUND',
          message: `tool operation Job ${externalId} not found in namespace ${this.namespace}`,
          retryable: false,
        });
      }
      return await this.withRuntimeResult(this.statusFromJob(externalId, job), job.metadata?.labels, options.signal);
    } catch (error) {
      throw toK8sDriverError(error, `getToolOperationStatus(${externalId})`);
    }
  }

  /** Cancel a tool operation by deleting its Job with foreground propagation. */
  async cancelToolOperation(externalId: string, _actor: ControlStoreActor, options: K8sDriverCallOptions = {}): Promise<void> {
    try {
      const deleted = await this.tryDelete('jobs', externalId, options.signal);
      if (!deleted) {
        throw new OrchestrationError({
          code: 'NOT_FOUND',
          message: `tool operation Job ${externalId} not found in namespace ${this.namespace}`,
          retryable: false,
        });
      }
    } catch (error) {
      throw toK8sDriverError(error, `cancelToolOperation(${externalId})`);
    }
  }

  /** List every memeloop-managed workload (Jobs and Deployments) with status. */
  async listWorkloads(options: K8sDriverCallOptions = {}): Promise<ExternalStatusResult[]> {
    try {
      const selector = `${LABEL_MANAGED_BY}=${MANAGED_BY_VALUE},${LABEL_RESOURCE_KIND}=AgentWorkload`;
      const [jobs, deployments] = await Promise.all([
        this.client.request<K8sList<K8sJob>>('GET', `/apis/batch/v1/namespaces/${this.namespace}/jobs`, {
          query: { labelSelector: selector },
          signal: options.signal,
        }),
        this.client.request<K8sList<K8sDeployment>>('GET', `/apis/apps/v1/namespaces/${this.namespace}/deployments`, {
          query: { labelSelector: selector },
          signal: options.signal,
        }),
      ]);
      return [
        ...(jobs.items ?? []).map((job) => this.statusFromJob(job.metadata?.name ?? 'unknown', job)),
        ...(deployments.items ?? []).map((deployment) => this.statusFromDeployment(deployment.metadata?.name ?? 'unknown', deployment)),
      ];
    } catch (error) {
      throw toK8sDriverError(error, 'listWorkloads');
    }
  }

  /** List every memeloop-managed tool-operation Job with status. */
  async listToolOperations(options: K8sDriverCallOptions = {}): Promise<ExternalStatusResult[]> {
    try {
      const selector = `${LABEL_MANAGED_BY}=${MANAGED_BY_VALUE},${LABEL_RESOURCE_KIND}=ToolOperation`;
      const jobs = await this.client.request<K8sList<K8sJob>>('GET', `/apis/batch/v1/namespaces/${this.namespace}/jobs`, {
        query: { labelSelector: selector },
        signal: options.signal,
      });
      return (jobs.items ?? []).map((job) => this.statusFromJob(job.metadata?.name ?? 'unknown', job));
    } catch (error) {
      throw toK8sDriverError(error, 'listToolOperations');
    }
  }

  /** Probe `/healthz` and `/version`; never throws — unhealthy is a value. */
  async getHealth(options: K8sDriverCallOptions = {}): Promise<{ healthy: boolean; detail?: string; checkedAt: string }> {
    const checkedAt = new Date().toISOString();
    try {
      await this.client.request<string>('GET', '/healthz', { signal: options.signal });
      const version = await this.client.request<{ gitVersion?: string }>('GET', '/version', { signal: options.signal });
      return { healthy: true, detail: `healthz ok, server ${version.gitVersion ?? 'unknown'}`, checkedAt };
    } catch (error) {
      const mapped = toK8sDriverError(error, 'getHealth');
      return { healthy: false, detail: `${mapped.code}: ${mapped.message}`, checkedAt };
    }
  }

  /* ---------------------------- internals ---------------------------- */

  private isServiceLifecycle(workload: AgentWorkloadResource): boolean {
    return workload.spec.completionPolicy === 'daemon' || workload.spec.completionPolicy === 'detach';
  }

  private buildPodTemplate(
    labels: Record<string, string>,
    extras: {
      image?: string;
      command?: string[];
      environment?: Record<string, string>;
      resources?: AgentWorkloadResourceRequirements;
      extraEnv: Array<{ name: string; value: string }>;
      bootstrapSecretName?: string;
      restartPolicy: 'Always' | 'Never';
      placement?: AgentWorkloadResource['spec']['placement'];
    },
  ): Record<string, unknown> {
    const container: Record<string, unknown> = {
      name: 'memeloop',
      ...(extras.image ? { image: extras.image } : {}),
      env: [
        ...Object.entries(extras.environment ?? {})
          .map(([name, value]) => ({ name, value })),
        ...extras.extraEnv,
      ],
      ...(extras.command ? { command: [...extras.command] } : {}),
      securityContext: {
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ['ALL'] },
      },
      ...this.buildResources(extras.resources),
    };
    if (extras.bootstrapSecretName) {
      (container.env as Array<{ name: string; value: string }>).push({
        name: ENV_WORKER_BOOTSTRAP_FILE,
        value: WORKER_BOOTSTRAP_PATH,
      });
      container.volumeMounts = [{
        name: 'worker-bootstrap',
        mountPath: WORKER_BOOTSTRAP_PATH,
        subPath: 'bootstrap.json',
        readOnly: true,
      }];
    }
    const podSpec: Record<string, unknown> = {
      restartPolicy: extras.restartPolicy,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      securityContext: {
        runAsNonRoot: true,
        seccompProfile: { type: 'RuntimeDefault' },
        ...(extras.bootstrapSecretName
          ? {
            fsGroup: 1000,
            fsGroupChangePolicy: 'OnRootMismatch',
          }
          : {}),
      },
      containers: [container],
      ...(this.imagePullSecrets.length > 0
        ? { imagePullSecrets: this.imagePullSecrets.map((name) => ({ name })) }
        : {}),
      ...(extras.bootstrapSecretName
        ? {
          volumes: [{
            name: 'worker-bootstrap',
            secret: {
              secretName: extras.bootstrapSecretName,
              // Kubernetes Secret volumes are root-owned; fsGroup 1000 plus
              // group-read is required for the numeric non-root worker.
              defaultMode: 0o440,
            },
          }],
        }
        : {}),
    };
    if (extras.placement) {
      // Explicit co-location: nodeSelector + nodeName + anti-affinity terms
      // are written onto the pod template, never implied.
      if (extras.placement.nodeSelector && Object.keys(extras.placement.nodeSelector).length > 0) {
        podSpec.nodeSelector = { ...extras.placement.nodeSelector };
      }
      if (extras.placement.requiredNode) {
        podSpec.nodeName = extras.placement.requiredNode;
      }
      if (extras.placement.antiAffinity && extras.placement.antiAffinity.length > 0) {
        podSpec.affinity = {
          podAntiAffinity: {
            requiredDuringSchedulingIgnoredDuringExecution: [{
              labelSelector: {
                matchExpressions: [{
                  key: LABEL_WORKLOAD_NAME,
                  operator: 'In',
                  values: extras.placement.antiAffinity.map(sanitizeLabelValue),
                }],
              },
              topologyKey: 'kubernetes.io/hostname',
            }],
          },
        };
      }
    }
    return { metadata: { labels }, spec: podSpec };
  }

  private buildResources(requirements: AgentWorkloadResourceRequirements | undefined): { resources?: Record<string, unknown> } {
    const quantities: Record<string, string> = {};
    if (requirements?.cpuMillicores !== undefined) {
      if (!Number.isSafeInteger(requirements.cpuMillicores) || requirements.cpuMillicores <= 0) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: 'spec.resources.cpuMillicores must be a positive safe integer',
          retryable: false,
        });
      }
      quantities.cpu = `${requirements.cpuMillicores}m`;
    }
    if (requirements?.memoryBytes !== undefined) {
      if (!Number.isSafeInteger(requirements.memoryBytes) || requirements.memoryBytes <= 0) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: 'spec.resources.memoryBytes must be a positive safe integer',
          retryable: false,
        });
      }
      quantities.memory = String(requirements.memoryBytes);
    }
    if (Object.keys(quantities).length === 0) return {};
    return { resources: { requests: { ...quantities }, limits: { ...quantities } } };
  }

  private async tryGetJob(name: string, signal?: AbortSignal): Promise<K8sJob | undefined> {
    try {
      return await this.client.request<K8sJob>('GET', `/apis/batch/v1/namespaces/${this.namespace}/jobs/${encodeURIComponent(name)}`, { signal });
    } catch (error) {
      if (error instanceof OrchestrationError && error.code === 'NOT_FOUND') return undefined;
      throw error;
    }
  }

  private async tryGetDeployment(name: string, signal?: AbortSignal): Promise<K8sDeployment | undefined> {
    try {
      return await this.client.request<K8sDeployment>('GET', `/apis/apps/v1/namespaces/${this.namespace}/deployments/${encodeURIComponent(name)}`, { signal });
    } catch (error) {
      if (error instanceof OrchestrationError && error.code === 'NOT_FOUND') return undefined;
      throw error;
    }
  }

  /** Delete with foreground propagation; returns false when the object does not exist. */
  private async tryDelete(resource: 'jobs' | 'deployments', name: string, signal?: AbortSignal): Promise<boolean> {
    const group = resource === 'jobs' ? 'batch/v1' : 'apps/v1';
    try {
      await this.client.request(
        'DELETE',
        `/apis/${group}/namespaces/${this.namespace}/${resource}/${encodeURIComponent(name)}`,
        { query: { propagationPolicy: 'Foreground' }, signal },
      );
      return true;
    } catch (error) {
      if (error instanceof OrchestrationError && error.code === 'NOT_FOUND') return false;
      throw error;
    }
  }

  private async tryDeleteSecret(name: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.client.request(
        'DELETE',
        `/api/v1/namespaces/${this.namespace}/secrets/${encodeURIComponent(name)}`,
        { signal },
      );
    } catch (error) {
      if (!(error instanceof OrchestrationError) || error.code !== 'NOT_FOUND') throw error;
    }
  }

  private async hasWorkloadWithUid(uid: string, signal?: AbortSignal): Promise<boolean> {
    const selector = `${LABEL_WORKLOAD_UID}=${sanitizeLabelValue(uid)}`;
    const [jobs, deployments] = await Promise.all([
      this.client.request<K8sList<K8sJob>>('GET', `/apis/batch/v1/namespaces/${this.namespace}/jobs`, {
        query: { labelSelector: selector },
        signal,
      }),
      this.client.request<K8sList<K8sDeployment>>('GET', `/apis/apps/v1/namespaces/${this.namespace}/deployments`, {
        query: { labelSelector: selector },
        signal,
      }),
    ]);
    return Boolean(jobs.items?.length || deployments.items?.length);
  }

  private async resolvePodNode(labelSelector: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const pods = await this.client.request<K8sList<K8sPod>>('GET', `/api/v1/namespaces/${this.namespace}/pods`, {
        query: { labelSelector },
        signal,
      });
      return pods.items?.find((pod) => pod.spec?.nodeName)?.spec?.nodeName;
    } catch {
      return undefined;
    }
  }

  private async withRuntimeResult(
    status: ExternalStatusResult,
    labels: Record<string, string> | undefined,
    signal?: AbortSignal,
  ): Promise<ExternalStatusResult> {
    if (status.phase !== 'Succeeded' && status.phase !== 'Failed') return status;
    const uidLabel = labels?.[LABEL_WORKLOAD_UID] !== undefined
      ? LABEL_WORKLOAD_UID
      : labels?.[LABEL_OPERATION_UID] !== undefined
      ? LABEL_OPERATION_UID
      : undefined;
    if (!uidLabel) return status;
    const labelValue = labels?.[uidLabel];
    if (!labelValue) return status;
    const pods = await this.client.request<K8sList<K8sPod>>('GET', `/api/v1/namespaces/${this.namespace}/pods`, {
      query: { labelSelector: `${uidLabel}=${labelValue}` },
      signal,
    });
    const podName = pods.items?.find((pod) => pod.metadata?.name)?.metadata?.name;
    if (!podName) return status;
    const logTail = await this.client.request<string>(
      'GET',
      `/api/v1/namespaces/${this.namespace}/pods/${encodeURIComponent(podName)}/log`,
      {
        query: { container: 'memeloop', tailLines: '20', limitBytes: String(MAX_RUNTIME_LOG_BYTES) },
        signal,
        maxResponseBytes: MAX_RUNTIME_LOG_BYTES,
      },
    );
    if (typeof logTail !== 'string') return status;
    const runtimeResult = parseExternalRuntimeResult(logTail);
    return runtimeResult ? { ...status, runtimeResult } : status;
  }

  private statusFromJob(externalId: string, job: K8sJob): ExternalStatusResult {
    const conditions = job.status?.conditions ?? [];
    const complete = conditions.find((c) => c.type === 'Complete' && c.status === 'True');
    if (complete) {
      return { externalId, phase: 'Succeeded', observedAt: new Date().toISOString() };
    }
    const failed = conditions.find((c) => c.type === 'Failed' && c.status === 'True');
    if (failed) {
      return {
        externalId,
        phase: 'Failed',
        message: failed.message ?? failed.reason ?? 'Job failed',
        observedAt: new Date().toISOString(),
      };
    }
    if ((job.status?.active ?? 0) > 0) {
      return { externalId, phase: 'Running', observedAt: new Date().toISOString() };
    }
    return { externalId, phase: 'Pending', observedAt: new Date().toISOString() };
  }

  private statusFromDeployment(externalId: string, deployment: K8sDeployment): ExternalStatusResult {
    const available = deployment.status?.conditions?.find((c) => c.type === 'Available');
    if ((deployment.status?.readyReplicas ?? 0) > 0 || available?.status === 'True') {
      return { externalId, phase: 'Running', observedAt: new Date().toISOString() };
    }
    return {
      externalId,
      phase: 'Pending',
      message: available?.message,
      observedAt: new Date().toISOString(),
    };
  }
}
