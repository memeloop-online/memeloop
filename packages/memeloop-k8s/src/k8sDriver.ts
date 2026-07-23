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
import { OrchestrationError } from 'memeloop';

import { KubernetesApiClient } from './apiClient.js';
import type { KubernetesApiClientOptions } from './apiClient.js';
import { toK8sDriverError } from './errors.js';
import {
  ANNOTATION_RUNTIME_COMMAND,
  ANNOTATION_RUNTIME_CPU,
  ANNOTATION_RUNTIME_ENV,
  ANNOTATION_RUNTIME_IMAGE,
  ANNOTATION_RUNTIME_MEMORY,
  ENV_TOOL_OPERATION,
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
  workloadObjectName,
} from './labels.js';

/** Per-call options accepted by every driver method (optional third parameter). */
export interface K8sDriverCallOptions {
  /** Cancellation signal honoured by the underlying HTTPS request. */
  signal?: AbortSignal;
}

const MAX_INLINE_SCRIPT_BYTES = 96 * 1024;

export interface K8sDriverOptions extends KubernetesApiClientOptions {
  /** Namespace the driver manages. Defaults to `default`. */
  namespace?: string;
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
  /** `ttlSecondsAfterFinished` for ToolOperation Jobs. Defaults to 3600. */
  toolJobTtlSecondsAfterFinished?: number;
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

/**
 * Kubernetes/K3s backend for the memeloop `ExternalOrchestrationDriver`
 * contract (docs/AGENT_ORCHESTRATION_PLAN.md §24.62).
 *
 * Resource mapping (namespace-scoped; the portable specs do not name
 * container images, so runtime details travel in `metadata.annotations`):
 *
 * | memeloop field                                    | Kubernetes field                                              |
 * | ------------------------------------------------- | ------------------------------------------------------------- |
 * | `spec.completionPolicy` = `complete`/unset        | `batch/v1 Job` (run-once)                                     |
 * | `spec.completionPolicy` = `daemon`/`detach`       | `apps/v1 Deployment` (service lifecycle)                      |
 * | annotation `memeloop.io/runtime-image` (required) | container `image`                                             |
 * | annotation `memeloop.io/runtime-command` (JSON)   | container `command`                                           |
 * | annotation `memeloop.io/runtime-env` (JSON)       | container `env`                                               |
 * | annotation `memeloop.io/runtime-cpu` / `-memory`  | container `resources.{requests,limits}`                       |
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
  private readonly defaultWorkloadImage?: string;
  private readonly defaultToolImage?: string;
  private readonly toolJobTtlSeconds: number;

  constructor(options: K8sDriverOptions) {
    this.client = new KubernetesApiClient(options);
    this.namespace = options.namespace ?? DEFAULT_NAMESPACE;
    this.defaultWorkloadImage = options.defaultWorkloadImage;
    this.defaultToolImage = options.defaultToolImage;
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
    try {
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
      const annotations = workload.metadata.annotations;
      const image = annotations?.[ANNOTATION_RUNTIME_IMAGE] ?? this.defaultWorkloadImage;
      if (!image) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: `placeWorkload(${workload.metadata.name}): no runtime image — set annotation ${ANNOTATION_RUNTIME_IMAGE} or driver defaultWorkloadImage`,
          retryable: false,
        });
      }
      const podTemplate = this.buildPodTemplate(annotations, labels, {
        image,
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
      if (job) return this.statusFromJob(externalId, job);
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
      if (deletedJob) return;
      const deletedDeployment = await this.tryDelete('deployments', externalId, options.signal);
      if (deletedDeployment) return;
      throw new OrchestrationError({
        code: 'NOT_FOUND',
        message: `workload ${externalId} not found as Job or Deployment in namespace ${this.namespace}`,
        retryable: false,
      });
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
      const annotations = operation.metadata.annotations;
      const image = annotations?.[ANNOTATION_RUNTIME_IMAGE] ?? this.defaultToolImage;
      if (!image) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: `executeToolOperation(${operation.metadata.name}): no runtime image — set annotation ${ANNOTATION_RUNTIME_IMAGE} or driver defaultToolImage`,
          retryable: false,
        });
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
      const podTemplate = this.buildPodTemplate(annotations, labels, {
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
      return this.statusFromJob(externalId, job);
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
    annotations: Record<string, string> | undefined,
    labels: Record<string, string>,
    extras: {
      image?: string;
      extraEnv: Array<{ name: string; value: string }>;
      restartPolicy: 'Always' | 'Never';
      placement?: AgentWorkloadResource['spec']['placement'];
    },
  ): Record<string, unknown> {
    const container: Record<string, unknown> = {
      name: 'memeloop',
      ...(extras.image ? { image: extras.image } : {}),
      ...this.parseJsonAnnotation<string[]>(annotations, ANNOTATION_RUNTIME_COMMAND, (value) => ({ command: value })),
      env: [
        ...Object.entries(this.parseJsonAnnotation<Record<string, string>>(annotations, ANNOTATION_RUNTIME_ENV, (value) => value) as Record<string, string>)
          .map(([name, value]) => ({ name, value })),
        ...extras.extraEnv,
      ],
      securityContext: {
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ['ALL'] },
      },
      ...this.buildResources(annotations),
    };
    const image = annotations?.[ANNOTATION_RUNTIME_IMAGE];
    if (image) container.image = image;

    const podSpec: Record<string, unknown> = {
      restartPolicy: extras.restartPolicy,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      securityContext: {
        runAsNonRoot: true,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [container],
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

  private buildResources(annotations: Record<string, string> | undefined): { resources?: Record<string, unknown> } {
    const cpu = annotations?.[ANNOTATION_RUNTIME_CPU];
    const memory = annotations?.[ANNOTATION_RUNTIME_MEMORY];
    const quantities: Record<string, string> = {};
    if (cpu !== undefined) {
      if (!Number.isFinite(Number.parseFloat(cpu)) || Number.parseFloat(cpu) <= 0) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: `annotation ${ANNOTATION_RUNTIME_CPU} must be a positive number of CPU cores, got ${JSON.stringify(cpu)}`,
          retryable: false,
        });
      }
      quantities.cpu = cpu;
    }
    if (memory !== undefined) {
      if (!Number.isFinite(Number.parseInt(memory, 10)) || Number.parseInt(memory, 10) <= 0) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: `annotation ${ANNOTATION_RUNTIME_MEMORY} must be a positive byte count, got ${JSON.stringify(memory)}`,
          retryable: false,
        });
      }
      quantities.memory = memory;
    }
    if (Object.keys(quantities).length === 0) return {};
    return { resources: { requests: { ...quantities }, limits: { ...quantities } } };
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
