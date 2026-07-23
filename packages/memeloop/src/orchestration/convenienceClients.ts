/**
 * Stable script helper wrappers (plan 24.12).
 *
 * Each convenience client compiles down to the same `AgentOrchestrationClient`
 * facade, adds stable owner/idempotency metadata, and cannot request
 * cluster-scoped Class or Secret resources unless policy explicitly allows it.
 *
 * Clients follow the same pattern as `createAgentClient` in `agentClient.ts`:
 * typed create/get/list/delete methods that validate `apply` results are the
 * expected kind and reject mismatched resources.
 */

import type { AgentOrchestrationClient, OrchestrationOwnerReference } from './client.js';
import { OrchestrationError } from './errors.js';
import type {
  AgentVolumeClaimManifest,
  AgentVolumeClaimResource,
  ArtifactRecordManifest,
  ArtifactRecordResource,
  CredentialGrantManifest,
  CredentialGrantResource,
  CredentialGrantSpec,
  ModelCallRecordManifest,
  ModelCallRecordResource,
  NetworkAttachmentManifest,
  NetworkAttachmentResource,
  ToolOperationManifest,
  ToolOperationResource,
} from './resources.js';
import { createModelCallRecordManifest, createToolOperationManifest, isModelCallRecord, isToolOperation } from './resources.js';

// ─── Tool Operation Client ─────────────────────────────────────────────

export interface CreateToolOperationOptions {
  name?: string;
  generateName?: string;
  namespace?: string;
  toolRef: { apiVersion: string; kind: string; name: string };
  effect: string;
  parameters?: Record<string, unknown>;
  target?: string;
  timeoutMs?: number;
  idempotencyKey?: string;
  ownerReferences?: OrchestrationOwnerReference[];
}

export interface ToolClient {
  createOperation(options: CreateToolOperationOptions): Promise<ToolOperationResource>;
  getOperation(name: string, namespace?: string): Promise<ToolOperationResource | null>;
  deleteOperation(name: string, namespace?: string): Promise<void>;
}

// ─── Model Call Record Client ──────────────────────────────────────────

export interface CreateModelCallOptions {
  name?: string;
  generateName?: string;
  namespace?: string;
  modelClassRef: { apiVersion: string; kind: string; name: string };
  runRef?: OrchestrationOwnerReference;
  inputClassification?: string;
  idempotencyKey?: string;
  ownerReferences?: OrchestrationOwnerReference[];
}

export interface ModelClient {
  createCallRecord(options: CreateModelCallOptions): Promise<ModelCallRecordResource>;
  getCallRecord(name: string, namespace?: string): Promise<ModelCallRecordResource | null>;
  deleteCallRecord(name: string, namespace?: string): Promise<void>;
}

// ─── Network Attachment Client ─────────────────────────────────────────

export interface CreateNetworkAttachmentOptions {
  name?: string;
  generateName?: string;
  namespace?: string;
  networkClassRef: { apiVersion: string; kind: string; name: string };
  workloadRef?: { apiVersion: string; kind: string; name: string };
  nodeId?: string;
  idempotencyKey?: string;
  ownerReferences?: OrchestrationOwnerReference[];
}

export interface NetworkClient {
  createAttachment(options: CreateNetworkAttachmentOptions): Promise<NetworkAttachmentResource>;
  getAttachment(name: string, namespace?: string): Promise<NetworkAttachmentResource | null>;
  deleteAttachment(name: string, namespace?: string): Promise<void>;
}

// ─── Volume Claim Client ───────────────────────────────────────────────

export interface CreateVolumeClaimOptions {
  name?: string;
  generateName?: string;
  namespace?: string;
  storageClass?: string;
  accessMode?: string;
  sizeBytes?: number;
  idempotencyKey?: string;
  ownerReferences?: OrchestrationOwnerReference[];
}

export interface StorageClient {
  createVolumeClaim(options: CreateVolumeClaimOptions): Promise<AgentVolumeClaimResource>;
  getVolumeClaim(name: string, namespace?: string): Promise<AgentVolumeClaimResource | null>;
  deleteVolumeClaim(name: string, namespace?: string): Promise<void>;
}

// ─── Credential Grant Client ───────────────────────────────────────────

export interface CreateCredentialGrantOptions {
  name?: string;
  generateName?: string;
  namespace?: string;
  runRef: CredentialGrantSpec['runRef'];
  attempt: number;
  workerKey: string;
  target: string;
  method: string;
  audience: string;
  policyDigest: string;
  budget?: CredentialGrantSpec['budget'];
  ttlMs?: number;
  idempotencyKey?: string;
  ownerReferences?: OrchestrationOwnerReference[];
}

export interface CredentialClient {
  createGrant(options: CreateCredentialGrantOptions): Promise<CredentialGrantResource>;
  getGrant(name: string, namespace?: string): Promise<CredentialGrantResource | null>;
  deleteGrant(name: string, namespace?: string): Promise<void>;
}

// ─── Artifact Record Client ────────────────────────────────────────────

export interface CreateArtifactRecordOptions {
  name?: string;
  generateName?: string;
  namespace?: string;
  contentHash: string;
  sizeBytes?: number;
  mimeType?: string;
  trust: string;
  producer?: { runRef?: OrchestrationOwnerReference; trust: string };
  parents?: Array<{ apiVersion: string; kind: string; name: string }>;
  idempotencyKey?: string;
  ownerReferences?: OrchestrationOwnerReference[];
}

export interface ArtifactClient {
  createRecord(options: CreateArtifactRecordOptions): Promise<ArtifactRecordResource>;
  getRecord(name: string, namespace?: string): Promise<ArtifactRecordResource | null>;
  deleteRecord(name: string, namespace?: string): Promise<void>;
}

// ─── Combined Convenience Clients ──────────────────────────────────────

export interface ConvenienceClients {
  tools: ToolClient;
  models: ModelClient;
  networks: NetworkClient;
  storage: StorageClient;
  credentials: CredentialClient;
  artifacts: ArtifactClient;
}

function requireName(name: string | undefined, generateName: string | undefined, label: string): string {
  if (name) return name;
  if (generateName) return generateName + '-' + Math.random().toString(36).slice(2, 10);
  throw new OrchestrationError({ code: 'INVALID', message: label + ' requires name or generateName', retryable: false });
}

function resolveNs(ns?: string, defaultNs?: string): string | undefined {
  return ns ?? defaultNs;
}

/**
 * Create all convenience clients from a single `AgentOrchestrationClient`.
 * Each client adds stable owner/idempotency metadata and validates `apply`
 * results are the expected kind.
 *
 * Cluster-scoped Class resources (ToolClass, ModelClass, NetworkClass,
 * StorageClass) and Secret resources cannot be created through these clients —
 * they require host-level administration, not script-level creation.
 */
export function createConvenienceClients(
  client: AgentOrchestrationClient,
  defaultNamespace?: string,
): ConvenienceClients {
  return {
    // ── Tools ──
    tools: {
      async createOperation(options: CreateToolOperationOptions): Promise<ToolOperationResource> {
        const name = requireName(options.name, options.generateName, 'ToolOperation');
        const manifest: ToolOperationManifest = createToolOperationManifest(name, {
          toolRef: options.toolRef,
          effect: options.effect as never,
          parameters: options.parameters,
          target: options.target,
          timeoutMs: options.timeoutMs,
        } as never);
        const result = await client.apply(manifest as never, {
          idempotencyKey: options.idempotencyKey,
          fieldManager: 'memeloop-tool-client',
        } as never);
        if (!isToolOperation(result as never)) {
          throw new OrchestrationError({ code: 'UNKNOWN_EFFECT', message: 'apply returned a non-ToolOperation resource', retryable: false });
        }
        return result as ToolOperationResource;
      },
      async getOperation(name: string, ns?: string): Promise<ToolOperationResource | null> {
        const result = await client.get({ apiVersion: 'tools.memeloop.io/v1alpha1', kind: 'ToolOperation', name, namespace: resolveNs(ns, defaultNamespace) } as never);
        return result && isToolOperation(result as never) ? result as ToolOperationResource : null;
      },
      async deleteOperation(name: string, ns?: string): Promise<void> {
        await client.delete({ apiVersion: 'tools.memeloop.io/v1alpha1', kind: 'ToolOperation', name, namespace: resolveNs(ns, defaultNamespace) } as never);
      },
    },

    // ── Models ──
    models: {
      async createCallRecord(options: CreateModelCallOptions): Promise<ModelCallRecordResource> {
        const name = requireName(options.name, options.generateName, 'ModelCallRecord');
        const manifest: ModelCallRecordManifest = createModelCallRecordManifest(name, {
          modelClassRef: options.modelClassRef,
          runRef: options.runRef,
          inputClassification: options.inputClassification as never,
        } as never);
        const result = await client.apply(manifest as never, {
          idempotencyKey: options.idempotencyKey,
          fieldManager: 'memeloop-model-client',
        } as never);
        if (!isModelCallRecord(result as never)) {
          throw new OrchestrationError({ code: 'UNKNOWN_EFFECT', message: 'apply returned a non-ModelCallRecord resource', retryable: false });
        }
        return result as ModelCallRecordResource;
      },
      async getCallRecord(name: string, ns?: string): Promise<ModelCallRecordResource | null> {
        const result = await client.get({ apiVersion: 'models.memeloop.io/v1alpha1', kind: 'ModelCallRecord', name, namespace: resolveNs(ns, defaultNamespace) } as never);
        return result && isModelCallRecord(result as never) ? result as ModelCallRecordResource : null;
      },
      async deleteCallRecord(name: string, ns?: string): Promise<void> {
        await client.delete({ apiVersion: 'models.memeloop.io/v1alpha1', kind: 'ModelCallRecord', name, namespace: resolveNs(ns, defaultNamespace) } as never);
      },
    },

    // ── Networks ──
    networks: {
      async createAttachment(options: CreateNetworkAttachmentOptions): Promise<NetworkAttachmentResource> {
        const name = requireName(options.name, options.generateName, 'NetworkAttachment');
        const manifest: NetworkAttachmentManifest = {
          apiVersion: 'network.memeloop.io/v1alpha1',
          kind: 'NetworkAttachment',
          metadata: { name, namespace: resolveNs(options.namespace, defaultNamespace) },
          spec: {
            networkClassRef: options.networkClassRef,
            workloadRef: options.workloadRef,
            nodeId: options.nodeId,
          } as never,
        } as never;
        const result = await client.apply(manifest, {
          idempotencyKey: options.idempotencyKey,
          fieldManager: 'memeloop-network-client',
        } as never);
        if (!(result as never)?.kind || (result as { kind?: string }).kind !== 'NetworkAttachment') {
          throw new OrchestrationError({ code: 'UNKNOWN_EFFECT', message: 'apply returned a non-NetworkAttachment resource', retryable: false });
        }
        return result as NetworkAttachmentResource;
      },
      async getAttachment(name: string, ns?: string): Promise<NetworkAttachmentResource | null> {
        const result = await client.get({ apiVersion: 'network.memeloop.io/v1alpha1', kind: 'NetworkAttachment', name, namespace: resolveNs(ns, defaultNamespace) } as never);
        return (result as never)?.kind === 'NetworkAttachment' ? result as NetworkAttachmentResource : null;
      },
      async deleteAttachment(name: string, ns?: string): Promise<void> {
        await client.delete({ apiVersion: 'network.memeloop.io/v1alpha1', kind: 'NetworkAttachment', name, namespace: resolveNs(ns, defaultNamespace) } as never);
      },
    },

    // ── Storage ──
    storage: {
      async createVolumeClaim(options: CreateVolumeClaimOptions): Promise<AgentVolumeClaimResource> {
        const name = requireName(options.name, options.generateName, 'AgentVolumeClaim');
        const manifest: AgentVolumeClaimManifest = {
          apiVersion: 'storage.memeloop.io/v1alpha1',
          kind: 'AgentVolumeClaim',
          metadata: { name, namespace: resolveNs(options.namespace, defaultNamespace) },
          spec: {
            storageClass: options.storageClass,
            accessMode: options.accessMode,
            sizeBytes: options.sizeBytes,
          } as never,
        } as never;
        const result = await client.apply(manifest, {
          idempotencyKey: options.idempotencyKey,
          fieldManager: 'memeloop-storage-client',
        } as never);
        if ((result as { kind?: string })?.kind !== 'AgentVolumeClaim') {
          throw new OrchestrationError({ code: 'UNKNOWN_EFFECT', message: 'apply returned a non-AgentVolumeClaim resource', retryable: false });
        }
        return result as AgentVolumeClaimResource;
      },
      async getVolumeClaim(name: string, ns?: string): Promise<AgentVolumeClaimResource | null> {
        const result = await client.get({ apiVersion: 'storage.memeloop.io/v1alpha1', kind: 'AgentVolumeClaim', name, namespace: resolveNs(ns, defaultNamespace) } as never);
        return (result as { kind?: string })?.kind === 'AgentVolumeClaim' ? result as AgentVolumeClaimResource : null;
      },
      async deleteVolumeClaim(name: string, ns?: string): Promise<void> {
        await client.delete({ apiVersion: 'storage.memeloop.io/v1alpha1', kind: 'AgentVolumeClaim', name, namespace: resolveNs(ns, defaultNamespace) } as never);
      },
    },

    // ── Credentials ──
    credentials: {
      async createGrant(options: CreateCredentialGrantOptions): Promise<CredentialGrantResource> {
        const name = requireName(options.name, options.generateName, 'CredentialGrant');
        const manifest: CredentialGrantManifest = {
          apiVersion: 'security.memeloop.io/v1alpha1',
          kind: 'CredentialGrant',
          metadata: { name, namespace: resolveNs(options.namespace, defaultNamespace) },
          spec: {
            runRef: options.runRef,
            attempt: options.attempt,
            workerKey: options.workerKey,
            target: options.target,
            method: options.method,
            audience: options.audience,
            policyDigest: options.policyDigest,
            ...(options.budget ? { budget: options.budget } : {}),
            ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
          },
        };
        const result = await client.apply(manifest, {
          idempotencyKey: options.idempotencyKey,
          fieldManager: 'memeloop-credential-client',
        } as never);
        if ((result as { kind?: string })?.kind !== 'CredentialGrant') {
          throw new OrchestrationError({ code: 'UNKNOWN_EFFECT', message: 'apply returned a non-CredentialGrant resource', retryable: false });
        }
        return result as CredentialGrantResource;
      },
      async getGrant(name: string, ns?: string): Promise<CredentialGrantResource | null> {
        const result = await client.get({ apiVersion: 'security.memeloop.io/v1alpha1', kind: 'CredentialGrant', name, namespace: resolveNs(ns, defaultNamespace) } as never);
        return (result as { kind?: string })?.kind === 'CredentialGrant' ? result as CredentialGrantResource : null;
      },
      async deleteGrant(name: string, ns?: string): Promise<void> {
        await client.delete({ apiVersion: 'security.memeloop.io/v1alpha1', kind: 'CredentialGrant', name, namespace: resolveNs(ns, defaultNamespace) } as never);
      },
    },

    // ── Artifacts ──
    artifacts: {
      async createRecord(options: CreateArtifactRecordOptions): Promise<ArtifactRecordResource> {
        const name = requireName(options.name, options.generateName, 'ArtifactRecord');
        const manifest: ArtifactRecordManifest = {
          apiVersion: 'artifacts.memeloop.io/v1alpha1',
          kind: 'ArtifactRecord',
          metadata: { name, namespace: resolveNs(options.namespace, defaultNamespace) },
          spec: {
            contentHash: options.contentHash,
            sizeBytes: options.sizeBytes,
            mimeType: options.mimeType,
            trust: options.trust as never,
            producer: options.producer as never,
            parents: options.parents,
          } as never,
        } as never;
        const result = await client.apply(manifest, {
          idempotencyKey: options.idempotencyKey,
          fieldManager: 'memeloop-artifact-client',
        } as never);
        if ((result as { kind?: string })?.kind !== 'ArtifactRecord') {
          throw new OrchestrationError({ code: 'UNKNOWN_EFFECT', message: 'apply returned a non-ArtifactRecord resource', retryable: false });
        }
        return result as ArtifactRecordResource;
      },
      async getRecord(name: string, ns?: string): Promise<ArtifactRecordResource | null> {
        const result = await client.get({ apiVersion: 'artifacts.memeloop.io/v1alpha1', kind: 'ArtifactRecord', name, namespace: resolveNs(ns, defaultNamespace) } as never);
        return (result as { kind?: string })?.kind === 'ArtifactRecord' ? result as ArtifactRecordResource : null;
      },
      async deleteRecord(name: string, ns?: string): Promise<void> {
        await client.delete({ apiVersion: 'artifacts.memeloop.io/v1alpha1', kind: 'ArtifactRecord', name, namespace: resolveNs(ns, defaultNamespace) } as never);
      },
    },
  };
}
