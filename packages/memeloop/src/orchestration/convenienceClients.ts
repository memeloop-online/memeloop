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

import type { AgentOrchestrationClient, OrchestrationManifestMetadata, OrchestrationOwnerReference } from './client.js';
import { OrchestrationError } from './errors.js';
import { bindResourceCrud } from './resourceCrudBinder.js';
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
  STORAGE_CLASS_API_VERSION,
  STORAGE_CLASS_KIND,
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

function createMetadata(
  options: {
    name?: string;
    generateName?: string;
    namespace?: string;
    ownerReferences?: OrchestrationOwnerReference[];
  },
  defaultNamespace: string | undefined,
  label: string,
): OrchestrationManifestMetadata {
  const name = options.name?.trim();
  const generateName = options.generateName?.trim();
  if (name && generateName) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: `${label} cannot set both name and generateName`,
      retryable: false,
    });
  }
  if (!name && !generateName) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: `${label} requires name or generateName`,
      retryable: false,
    });
  }
  const namespace = options.namespace ?? defaultNamespace;
  return {
    ...(name ? { name } : { generateName: generateName! }),
    ...(namespace === undefined ? {} : { namespace }),
    ...(options.ownerReferences === undefined
      ? {}
      : { ownerReferences: options.ownerReferences }),
  };
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
  const tools = bindResourceCrud<CreateToolOperationOptions, ToolOperationResource>(client, defaultNamespace, {
    apiVersion: TOOL_OPERATION_API_VERSION,
    kind: TOOL_OPERATION_KIND,
    fieldManager: 'memeloop-tool-client',
    label: 'ToolOperation',
    buildManifest: options => ({
      apiVersion: TOOL_OPERATION_API_VERSION,
      kind: TOOL_OPERATION_KIND,
      metadata: createMetadata(options, defaultNamespace, 'ToolOperation'),
      spec: {
        toolRef: options.toolRef,
        effect: options.effect,
        ...(options.arguments === undefined ? {} : { arguments: options.arguments }),
        ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      },
    } satisfies ToolOperationManifest),
    isResource: isToolOperation,
  });
  const models = bindResourceCrud<CreateModelCallOptions, ModelCallRecordResource>(client, defaultNamespace, {
    apiVersion: MODEL_CALL_RECORD_API_VERSION,
    kind: MODEL_CALL_RECORD_KIND,
    fieldManager: 'memeloop-model-client',
    label: 'ModelCallRecord',
    buildManifest: options => ({
      apiVersion: MODEL_CALL_RECORD_API_VERSION,
      kind: MODEL_CALL_RECORD_KIND,
      metadata: createMetadata(options, defaultNamespace, 'ModelCallRecord'),
      spec: {
        modelClassRef: options.modelClassRef,
        ...(options.runRef === undefined ? {} : { runRef: options.runRef }),
        ...(options.inputClassification === undefined ? {} : { inputClassification: options.inputClassification }),
      },
    } satisfies ModelCallRecordManifest),
    isResource: isModelCallRecord,
  });
  const networks = bindResourceCrud<CreateNetworkAttachmentOptions, NetworkAttachmentResource>(client, defaultNamespace, {
    apiVersion: NETWORK_ATTACHMENT_API_VERSION,
    kind: NETWORK_ATTACHMENT_KIND,
    fieldManager: 'memeloop-network-client',
    label: 'NetworkAttachment',
    buildManifest: options => ({
      apiVersion: NETWORK_ATTACHMENT_API_VERSION,
      kind: NETWORK_ATTACHMENT_KIND,
      metadata: createMetadata(options, defaultNamespace, 'NetworkAttachment'),
      spec: {
        networkClassRef: options.networkClassRef,
        ...(options.workloadRef === undefined ? {} : { workloadRef: options.workloadRef }),
        ...(options.nodeId === undefined ? {} : { nodeId: options.nodeId }),
      },
    } satisfies NetworkAttachmentManifest),
    isResource: isNetworkAttachment,
  });
  const storage = bindResourceCrud<CreateVolumeClaimOptions, AgentVolumeClaimResource>(client, defaultNamespace, {
    apiVersion: VOLUME_CLAIM_API_VERSION,
    kind: VOLUME_CLAIM_KIND,
    fieldManager: 'memeloop-storage-client',
    label: 'AgentVolumeClaim',
    buildManifest: options => ({
      apiVersion: VOLUME_CLAIM_API_VERSION,
      kind: VOLUME_CLAIM_KIND,
      metadata: createMetadata(options, defaultNamespace, 'AgentVolumeClaim'),
      spec: {
        storageClassRef: {
          apiVersion: STORAGE_CLASS_API_VERSION,
          kind: STORAGE_CLASS_KIND,
          name: options.storageClass,
        },
        accessMode: options.accessMode,
        ...(options.sizeBytes === undefined ? {} : { sizeBytes: options.sizeBytes }),
      },
    } satisfies AgentVolumeClaimManifest),
    isResource: isVolumeClaim,
  });
  const credentials = bindResourceCrud<CreateCredentialGrantOptions, CredentialGrantResource>(client, defaultNamespace, {
    apiVersion: CREDENTIAL_GRANT_API_VERSION,
    kind: CREDENTIAL_GRANT_KIND,
    fieldManager: 'memeloop-credential-client',
    label: 'CredentialGrant',
    buildManifest: options => ({
      apiVersion: CREDENTIAL_GRANT_API_VERSION,
      kind: CREDENTIAL_GRANT_KIND,
      metadata: createMetadata(options, defaultNamespace, 'CredentialGrant'),
      spec: {
        runRef: options.runRef,
        attempt: options.attempt,
        workerKey: options.workerKey,
        target: options.target,
        method: options.method,
        audience: options.audience,
        policyDigest: options.policyDigest,
        ...(options.budget ? { budget: options.budget } : {}),
        ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      },
    } satisfies CredentialGrantManifest),
    isResource: isCredentialGrant,
  });
  const artifacts = bindResourceCrud<CreateArtifactRecordOptions, ArtifactRecordResource>(client, defaultNamespace, {
    apiVersion: ARTIFACT_RECORD_API_VERSION,
    kind: ARTIFACT_RECORD_KIND,
    fieldManager: 'memeloop-artifact-client',
    label: 'ArtifactRecord',
    buildManifest: options => ({
      apiVersion: ARTIFACT_RECORD_API_VERSION,
      kind: ARTIFACT_RECORD_KIND,
      metadata: createMetadata(options, defaultNamespace, 'ArtifactRecord'),
      spec: {
        contentHash: options.contentHash,
        trust: options.trust,
        ...(options.sizeBytes === undefined ? {} : { sizeBytes: options.sizeBytes }),
        ...(options.mimeType === undefined ? {} : { mimeType: options.mimeType }),
        ...(options.producer === undefined ? {} : { producer: options.producer }),
        ...(options.parents === undefined ? {} : { parents: options.parents }),
      },
    } satisfies ArtifactRecordManifest),
    isResource: isArtifactRecord,
  });
  return {
    // ── Tools ──
    tools: {
      createOperation: options => tools.create(options),
      getOperation: (name, namespace) => tools.get(name, namespace),
      deleteOperation: (name, namespace) => tools.delete(name, namespace),
    },

    // ── Models ──
    models: {
      createCallRecord: options => models.create(options),
      getCallRecord: (name, namespace) => models.get(name, namespace),
      deleteCallRecord: (name, namespace) => models.delete(name, namespace),
    },

    // ── Networks ──
    networks: {
      createAttachment: options => networks.create(options),
      getAttachment: (name, namespace) => networks.get(name, namespace),
      deleteAttachment: (name, namespace) => networks.delete(name, namespace),
    },

    // ── Storage ──
    storage: {
      createVolumeClaim: options => storage.create(options),
      getVolumeClaim: (name, namespace) => storage.get(name, namespace),
      deleteVolumeClaim: (name, namespace) => storage.delete(name, namespace),
    },

    // ── Credentials ──
    credentials: {
      createGrant: options => credentials.create(options),
      getGrant: (name, namespace) => credentials.get(name, namespace),
      deleteGrant: (name, namespace) => credentials.delete(name, namespace),
    },

    // ── Artifacts ──
    artifacts: {
      createRecord: options => artifacts.create(options),
      getRecord: (name, namespace) => artifacts.get(name, namespace),
      deleteRecord: (name, namespace) => artifacts.delete(name, namespace),
    },
  };
}
