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
  ArtifactRecordSpec,
  ArtifactTrust,
  CredentialGrantManifest,
  CredentialGrantResource,
  CredentialGrantSpec,
  ModelCallRecordManifest,
  ModelCallRecordResource,
  NetworkAttachmentManifest,
  NetworkAttachmentResource,
  ToolOperationEffect,
  ToolOperationManifest,
  ToolOperationResource,
  VolumeAccessMode,
} from './resources.js';
import {
  ARTIFACT_RECORD_API_VERSION,
  ARTIFACT_RECORD_KIND,
  createModelCallRecordManifest,
  createToolOperationManifest,
  CREDENTIAL_GRANT_API_VERSION,
  CREDENTIAL_GRANT_KIND,
  isArtifactRecord,
  isCredentialGrant,
  isModelCallRecord,
  isNetworkAttachment,
  isToolOperation,
  isVolumeClaim,
  MODEL_CALL_RECORD_API_VERSION,
  MODEL_CALL_RECORD_KIND,
  NETWORK_ATTACHMENT_API_VERSION,
  NETWORK_ATTACHMENT_KIND,
  TOOL_OPERATION_API_VERSION,
  TOOL_OPERATION_KIND,
  VOLUME_CLAIM_API_VERSION,
  VOLUME_CLAIM_KIND,
} from './resources.js';

// ─── Tool Operation Client ─────────────────────────────────────────────

export interface CreateToolOperationOptions {
  name?: string;
  generateName?: string;
  namespace?: string;
  toolRef: { apiVersion: string; kind: string; name: string };
  effect: ToolOperationEffect;
  arguments?: Record<string, unknown>;
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
  workloadRef?: OrchestrationOwnerReference;
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
  storageClass: string;
  accessMode: VolumeAccessMode;
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
  trust: ArtifactTrust;
  producer?: ArtifactRecordSpec['producer'];
  parents?: ArtifactRecordSpec['parents'];
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
          effect: options.effect,
          arguments: options.arguments,
          idempotencyKey: options.idempotencyKey,
          timeoutMs: options.timeoutMs,
        });
        manifest.metadata = {
          ...manifest.metadata,
          namespace: resolveNs(options.namespace, defaultNamespace),
          ownerReferences: options.ownerReferences,
        };
        const result = await client.apply(manifest, {
          idempotencyKey: options.idempotencyKey,
          fieldManager: 'memeloop-tool-client',
        });
        if (!isToolOperation(result)) {
          throw new OrchestrationError({ code: 'UNKNOWN_EFFECT', message: 'apply returned a non-ToolOperation resource', retryable: false });
        }
        return result;
      },
      async getOperation(name: string, ns?: string): Promise<ToolOperationResource | null> {
        const result = await client.get({ apiVersion: TOOL_OPERATION_API_VERSION, kind: TOOL_OPERATION_KIND, name, namespace: resolveNs(ns, defaultNamespace) });
        return result && isToolOperation(result) ? result : null;
      },
      async deleteOperation(name: string, ns?: string): Promise<void> {
        await client.delete({ apiVersion: TOOL_OPERATION_API_VERSION, kind: TOOL_OPERATION_KIND, name, namespace: resolveNs(ns, defaultNamespace) });
      },
    },

    // ── Models ──
    models: {
      async createCallRecord(options: CreateModelCallOptions): Promise<ModelCallRecordResource> {
        const name = requireName(options.name, options.generateName, 'ModelCallRecord');
        const manifest: ModelCallRecordManifest = createModelCallRecordManifest(name, {
          modelClassRef: options.modelClassRef,
          runRef: options.runRef,
          inputClassification: options.inputClassification,
        });
        manifest.metadata = {
          ...manifest.metadata,
          namespace: resolveNs(options.namespace, defaultNamespace),
          ownerReferences: options.ownerReferences,
        };
        const result = await client.apply(manifest, {
          idempotencyKey: options.idempotencyKey,
          fieldManager: 'memeloop-model-client',
        });
        if (!isModelCallRecord(result)) {
          throw new OrchestrationError({ code: 'UNKNOWN_EFFECT', message: 'apply returned a non-ModelCallRecord resource', retryable: false });
        }
        return result;
      },
      async getCallRecord(name: string, ns?: string): Promise<ModelCallRecordResource | null> {
        const result = await client.get({ apiVersion: MODEL_CALL_RECORD_API_VERSION, kind: MODEL_CALL_RECORD_KIND, name, namespace: resolveNs(ns, defaultNamespace) });
        return result && isModelCallRecord(result) ? result : null;
      },
      async deleteCallRecord(name: string, ns?: string): Promise<void> {
        await client.delete({ apiVersion: MODEL_CALL_RECORD_API_VERSION, kind: MODEL_CALL_RECORD_KIND, name, namespace: resolveNs(ns, defaultNamespace) });
      },
    },

    // ── Networks ──
    networks: {
      async createAttachment(options: CreateNetworkAttachmentOptions): Promise<NetworkAttachmentResource> {
        const name = requireName(options.name, options.generateName, 'NetworkAttachment');
        const manifest: NetworkAttachmentManifest = {
          apiVersion: NETWORK_ATTACHMENT_API_VERSION,
          kind: NETWORK_ATTACHMENT_KIND,
          metadata: {
            name,
            namespace: resolveNs(options.namespace, defaultNamespace),
            ownerReferences: options.ownerReferences,
          },
          spec: {
            networkClassRef: options.networkClassRef,
            workloadRef: options.workloadRef,
            nodeId: options.nodeId,
          },
        };
        const result = await client.apply(manifest, {
          idempotencyKey: options.idempotencyKey,
          fieldManager: 'memeloop-network-client',
        });
        if (!isNetworkAttachment(result)) {
          throw new OrchestrationError({ code: 'UNKNOWN_EFFECT', message: 'apply returned a non-NetworkAttachment resource', retryable: false });
        }
        return result;
      },
      async getAttachment(name: string, ns?: string): Promise<NetworkAttachmentResource | null> {
        const result = await client.get({ apiVersion: NETWORK_ATTACHMENT_API_VERSION, kind: NETWORK_ATTACHMENT_KIND, name, namespace: resolveNs(ns, defaultNamespace) });
        return result && isNetworkAttachment(result) ? result : null;
      },
      async deleteAttachment(name: string, ns?: string): Promise<void> {
        await client.delete({ apiVersion: NETWORK_ATTACHMENT_API_VERSION, kind: NETWORK_ATTACHMENT_KIND, name, namespace: resolveNs(ns, defaultNamespace) });
      },
    },

    // ── Storage ──
    storage: {
      async createVolumeClaim(options: CreateVolumeClaimOptions): Promise<AgentVolumeClaimResource> {
        const name = requireName(options.name, options.generateName, 'AgentVolumeClaim');
        const manifest: AgentVolumeClaimManifest = {
          apiVersion: VOLUME_CLAIM_API_VERSION,
          kind: VOLUME_CLAIM_KIND,
          metadata: {
            name,
            namespace: resolveNs(options.namespace, defaultNamespace),
            ownerReferences: options.ownerReferences,
          },
          spec: {
            storageClassRef: {
              apiVersion: 'storage.memeloop.io/v1alpha1',
              kind: 'StorageClass',
              name: options.storageClass,
            },
            accessMode: options.accessMode,
            ...(options.sizeBytes !== undefined ? { sizeBytes: options.sizeBytes } : {}),
          },
        };
        const result = await client.apply(manifest, {
          idempotencyKey: options.idempotencyKey,
          fieldManager: 'memeloop-storage-client',
        });
        if (!isVolumeClaim(result)) {
          throw new OrchestrationError({ code: 'UNKNOWN_EFFECT', message: 'apply returned a non-AgentVolumeClaim resource', retryable: false });
        }
        return result;
      },
      async getVolumeClaim(name: string, ns?: string): Promise<AgentVolumeClaimResource | null> {
        const result = await client.get({ apiVersion: VOLUME_CLAIM_API_VERSION, kind: VOLUME_CLAIM_KIND, name, namespace: resolveNs(ns, defaultNamespace) });
        return result && isVolumeClaim(result) ? result : null;
      },
      async deleteVolumeClaim(name: string, ns?: string): Promise<void> {
        await client.delete({ apiVersion: VOLUME_CLAIM_API_VERSION, kind: VOLUME_CLAIM_KIND, name, namespace: resolveNs(ns, defaultNamespace) });
      },
    },

    // ── Credentials ──
    credentials: {
      async createGrant(options: CreateCredentialGrantOptions): Promise<CredentialGrantResource> {
        const name = requireName(options.name, options.generateName, 'CredentialGrant');
        const manifest: CredentialGrantManifest = {
          apiVersion: CREDENTIAL_GRANT_API_VERSION,
          kind: CREDENTIAL_GRANT_KIND,
          metadata: {
            name,
            namespace: resolveNs(options.namespace, defaultNamespace),
            ownerReferences: options.ownerReferences,
          },
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
        });
        if (!isCredentialGrant(result)) {
          throw new OrchestrationError({ code: 'UNKNOWN_EFFECT', message: 'apply returned a non-CredentialGrant resource', retryable: false });
        }
        return result;
      },
      async getGrant(name: string, ns?: string): Promise<CredentialGrantResource | null> {
        const result = await client.get({ apiVersion: CREDENTIAL_GRANT_API_VERSION, kind: CREDENTIAL_GRANT_KIND, name, namespace: resolveNs(ns, defaultNamespace) });
        return result && isCredentialGrant(result) ? result : null;
      },
      async deleteGrant(name: string, ns?: string): Promise<void> {
        await client.delete({ apiVersion: CREDENTIAL_GRANT_API_VERSION, kind: CREDENTIAL_GRANT_KIND, name, namespace: resolveNs(ns, defaultNamespace) });
      },
    },

    // ── Artifacts ──
    artifacts: {
      async createRecord(options: CreateArtifactRecordOptions): Promise<ArtifactRecordResource> {
        const name = requireName(options.name, options.generateName, 'ArtifactRecord');
        const manifest: ArtifactRecordManifest = {
          apiVersion: ARTIFACT_RECORD_API_VERSION,
          kind: ARTIFACT_RECORD_KIND,
          metadata: {
            name,
            namespace: resolveNs(options.namespace, defaultNamespace),
            ownerReferences: options.ownerReferences,
          },
          spec: {
            contentHash: options.contentHash,
            sizeBytes: options.sizeBytes,
            mimeType: options.mimeType,
            trust: options.trust,
            producer: options.producer,
            parents: options.parents,
          },
        };
        const result = await client.apply(manifest, {
          idempotencyKey: options.idempotencyKey,
          fieldManager: 'memeloop-artifact-client',
        });
        if (!isArtifactRecord(result)) {
          throw new OrchestrationError({ code: 'UNKNOWN_EFFECT', message: 'apply returned a non-ArtifactRecord resource', retryable: false });
        }
        return result;
      },
      async getRecord(name: string, ns?: string): Promise<ArtifactRecordResource | null> {
        const result = await client.get({ apiVersion: ARTIFACT_RECORD_API_VERSION, kind: ARTIFACT_RECORD_KIND, name, namespace: resolveNs(ns, defaultNamespace) });
        return result && isArtifactRecord(result) ? result : null;
      },
      async deleteRecord(name: string, ns?: string): Promise<void> {
        await client.delete({ apiVersion: ARTIFACT_RECORD_API_VERSION, kind: ARTIFACT_RECORD_KIND, name, namespace: resolveNs(ns, defaultNamespace) });
      },
    },
  };
}
