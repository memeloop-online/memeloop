/**
 * Generated-script deployment pipeline (plans 24.14–24.19, 24.47).
 *
 * Connects the full security chain for remote/generated scripts:
 *
 *   normalizeScript → validateScript (Acorn AST) → admitScript (trust-class
 *   policy) → ArtifactRecord manifest (content-addressed) → persist via the
 *   injected artifact store port → selectRuntimeClass →
 *   RemoteDeploymentRequest (artifactRef only — raw source is never carried).
 *
 * Also provides {@link createScriptLoadGate}, the production
 * {@link ScriptLoadGate} implementation for the in-process script loading
 * path (`loopAPI/scriptLoader`): validate (AST) → admit → assign
 * trustClass/RuntimeClass before any `import()` executes.
 *
 * Everything here is pure and portable; artifact persistence sits behind the
 * {@link ScriptArtifactStore} port so the CLI can back it with real storage.
 */

import type { ScriptLoadGate, ScriptLoadGateDecision } from '../../loopAPI/types.js';
import { waitForCondition, type WaitForConditionOptions } from '../agentClient.js';
import type { AgentOrchestrationClient, OrchestrationOwnerReference } from '../client.js';
import { OrchestrationError } from '../errors.js';
import {
  AGENT_WORKLOAD_API_VERSION,
  AGENT_WORKLOAD_KIND,
  type AgentWorkloadCompletionPolicy,
  type AgentWorkloadManifest,
  type AgentWorkloadNetworkPolicy,
  type AgentWorkloadResource,
  type AgentWorkloadStoragePolicy,
  type ArtifactRecordManifest,
  createAgentWorkloadManifest,
  createArtifactRecordManifest,
} from '../resources.js';
import { containsSecrets } from '../security/secretRedaction.js';
import { admitScript, defaultRequestedInterfacesForTrustClass, type ScriptAdmissionDecision, type ScriptTrustClass } from './scriptAdmission.js';
import { type RemoteDeploymentRequest, type SandboxSelectionResult, selectRuntimeClass } from './scriptRuntime.js';
import { normalizeScript, type ScriptValidationResult, validateScript } from './scriptValidation.js';

// ─── Artifact persistence port ─────────────────────────────────────────

/**
 * Port: persists a script ArtifactRecord manifest plus its normalized
 * content. Implementations (e.g. CLI storage) must store content addressed
 * by `manifest.spec.contentHash` and must not trust content whose hash does
 * not match the manifest.
 */
export interface ScriptArtifactStore {
  putArtifact(manifest: ArtifactRecordManifest, normalizedContent: string): Promise<void> | void;
}

// ─── Deployment pipeline ───────────────────────────────────────────────

/** Input for {@link deployGeneratedScript}. */
export interface ScriptDeploymentRequest {
  /** Raw generated `.mjs` source (normalized internally). */
  source: string;
  /** Trust class of the author (the Agent that generated the script). */
  authorTrust: ScriptTrustClass;
  /** Interfaces the script requests (loop-runtime, model-provider, ...). */
  requestedInterfaces: string[];
  /** Desired lifecycle for the remote workload. */
  lifecycle: 'run-once' | 'service' | 'schedule';
  /** Node selector for scheduling. */
  nodeSelector?: Record<string, string>;
  /** Environment variables (never credentials). */
  env?: Record<string, string>;
  /** Network attachment requirements for the deployed workload. */
  networkPolicy?: AgentWorkloadNetworkPolicy;
  /** Existing volume claims required by the deployed workload. */
  storagePolicy?: AgentWorkloadStoragePolicy;
  /** Optional checkpoint digest the script expects to resume from. */
  expectedCheckpointDigest?: string;
  /** API version of the expected checkpoint (plan 24.19). */
  checkpointApiVersion?: string;
  /** Schema version of the expected checkpoint (plan 24.19). */
  checkpointSchemaVersion?: string;
  /** Namespace for the ArtifactRecord and deployment. */
  namespace?: string;
}

/** Tunables for {@link deployGeneratedScript}. */
export interface ScriptDeploymentPipelineOptions {
  /** Artifact persistence port; when omitted the manifest is built but not persisted. */
  artifactStore?: ScriptArtifactStore;
  /** RuntimeClass names available for selection (defaults to all built-ins). */
  availableRuntimeClasses?: string[];
}

/** Result of {@link deployGeneratedScript}; `deployed` gates artifact/deployment presence. */
export interface ScriptDeploymentResult {
  /** Whether a deployment request was produced. */
  deployed: boolean;
  /** Human-readable outcome (validation/admission/enforcement reason). */
  reason: string;
  /** AST validation outcome (always present). */
  validation: ScriptValidationResult;
  /** Admission decision (present once validation passed). */
  admission?: ScriptAdmissionDecision;
  /** Content-addressed artifact manifest (present when deployed). */
  artifact?: ArtifactRecordManifest;
  /** Selected RuntimeClass (present when deployed). */
  runtimeClass?: SandboxSelectionResult;
  /** Deployment request referencing the artifact by digest (present when deployed). */
  deployment?: RemoteDeploymentRequest;
  /** Applied AgentWorkload (present when deployed through an orchestration facade). */
  workload?: AgentWorkloadResource;
}

// ─── Scheduler consumption (plan 24.14) ────────────────────────────────

/** Lifecycle declared by the script → workload completion policy. */
const LIFECYCLE_TO_COMPLETION_POLICY: Record<RemoteDeploymentRequest['lifecycle'], AgentWorkloadCompletionPolicy> = {
  'run-once': 'complete',
  service: 'daemon',
  schedule: 'detach',
};

export interface RemoteDeploymentWorkloadOptions {
  /** Workload name (defaults to the content-addressed artifact name). */
  name?: string;
  namespace?: string;
  ownerReferences?: OrchestrationOwnerReference[];
}

/**
 * Translate a {@link RemoteDeploymentRequest} into an AgentWorkload manifest
 * the binding controller (24.56) can schedule. The script declares placement
 * and lifecycle; the scheduler — never the script — selects the node.
 */
export function remoteDeploymentToWorkloadManifest(
  deployment: RemoteDeploymentRequest,
  options: RemoteDeploymentWorkloadOptions = {},
): AgentWorkloadManifest {
  const manifest = createAgentWorkloadManifest(options.name ?? deployment.artifactRef.name, {
    scriptReference: deployment.artifactRef.contentDigest,
    trust: deployment.trustClass,
    runtimeClass: deployment.runtimeClass,
    completionPolicy: LIFECYCLE_TO_COMPLETION_POLICY[deployment.lifecycle],
    ...(deployment.nodeSelector ? { placement: { nodeSelector: deployment.nodeSelector } } : {}),
    ...(deployment.env ? { env: deployment.env } : {}),
    ...(deployment.networkPolicy ? { networkPolicy: deployment.networkPolicy } : {}),
    ...(deployment.storagePolicy ? { storagePolicy: deployment.storagePolicy } : {}),
    ...(options.ownerReferences ? { ownerReferences: options.ownerReferences } : {}),
  });
  const namespace = options.namespace ?? deployment.artifactRef.namespace;
  if (namespace !== undefined) {
    manifest.metadata.namespace = namespace;
  }
  return manifest;
}

/**
 * Run the full generated-script security chain and produce a remote
 * deployment request. Never throws for script-content problems — invalid or
 * inadmissible scripts yield `deployed: false` with a structured reason.
 *
 * Checkpoint identity (plan 24.19) is enforced here: when the caller expects
 * to resume a checkpoint and admission rejects its exact identity, no
 * deployment is produced.
 */
export async function deployGeneratedScript(
  request: ScriptDeploymentRequest,
  options: ScriptDeploymentPipelineOptions = {},
): Promise<ScriptDeploymentResult> {
  // 1. Normalize + validate (Acorn AST, canonical digest).
  const validation = await validateScript(request.source);
  if (!validation.valid) {
    return {
      deployed: false,
      reason: `Script validation failed: ${validation.errors.join('; ')}`,
      validation,
    };
  }

  // 2. Admission (trust-class policy, plan 24.17/24.19).
  const admission = admitScript({
    script: validation,
    authorTrust: request.authorTrust,
    requestedInterfaces: request.requestedInterfaces,
    expectedCheckpointDigest: request.expectedCheckpointDigest,
    checkpointApiVersion: request.checkpointApiVersion,
    checkpointSchemaVersion: request.checkpointSchemaVersion,
  });
  if (!admission.admitted) {
    return { deployed: false, reason: admission.reason, validation, admission };
  }
  if (
    (request.expectedCheckpointDigest !== undefined ||
      request.checkpointApiVersion !== undefined ||
      request.checkpointSchemaVersion !== undefined) && !admission.checkpointAccepted
  ) {
    return {
      deployed: false,
      reason: 'Checkpoint identity does not match this script digest/API/schema',
      validation,
      admission,
    };
  }

  // 2b. env guard (plan 24.35): workload env is persisted in the ControlStore
  // spec, so secret-shaped values are rejected here rather than redacted.
  for (const [name, value] of Object.entries(request.env ?? {})) {
    if (containsSecrets(value)) {
      return {
        deployed: false,
        reason: `Environment variable '${name}' carries a secret-shaped value; workload env must never contain credentials (plan 24.35)`,
        validation,
        admission,
      };
    }
  }

  // 3. Content-addressed ArtifactRecord manifest (plan 24.15/24.47).
  const contentDigest = `sha256:${validation.digest}`;
  const artifactName = `script-${validation.digest}`;
  const artifact = createArtifactRecordManifest(artifactName, {
    contentHash: contentDigest,
    sizeBytes: validation.sizeBytes,
    mimeType: 'text/javascript',
    producer: { trust: request.authorTrust },
    trust: request.authorTrust,
  });
  if (request.namespace !== undefined) {
    artifact.metadata.namespace = request.namespace;
  }
  await options.artifactStore?.putArtifact(artifact, normalizeScript(request.source));

  // 4. RuntimeClass selection (plan 24.18).
  const runtimeClass = selectRuntimeClass(request.authorTrust, options.availableRuntimeClasses);

  // 5. Deployment request referencing the artifact by digest — never raw source.
  const deployment: RemoteDeploymentRequest = {
    artifactRef: {
      apiVersion: artifact.apiVersion,
      kind: 'ArtifactRecord',
      name: artifactName,
      namespace: artifact.metadata.namespace,
      contentDigest,
    },
    trustClass: request.authorTrust,
    lifecycle: request.lifecycle,
    runtimeClass: runtimeClass.runtimeClass,
    nodeSelector: request.nodeSelector,
    env: request.env,
    networkPolicy: request.networkPolicy,
    storagePolicy: request.storagePolicy,
  };

  return {
    deployed: true,
    reason: admission.reason,
    validation,
    admission,
    artifact,
    runtimeClass,
    deployment,
  };
}

// ─── Script load gate (production admission for in-process loading) ────

/** Configuration for {@link createScriptLoadGate}. */
export interface ScriptLoadGateConfig {
  /** Trust class to assign admitted scripts (plan 24.17). */
  authorTrust: ScriptTrustClass;
  /** Interfaces admitted scripts may request. */
  requestedInterfaces: string[];
  /** RuntimeClass names available for selection (defaults to all built-ins). */
  availableRuntimeClasses?: string[];
  /** Optional checkpoint digest admitted scripts expect to resume from. */
  expectedCheckpointDigest?: string;
  /** API version of the expected checkpoint (plan 24.19). */
  checkpointApiVersion?: string;
  /** Schema version of the expected checkpoint (plan 24.19). */
  checkpointSchemaVersion?: string;
}

/**
 * Create the production {@link ScriptLoadGate}: every non-builtin source is
 * validated (Acorn AST), admitted under the configured trust-class policy,
 * and assigned a RuntimeClass before the loader is allowed to `import()` it.
 * The gate verifies that the digest computed by the loader matches the
 * digest of the source it validated, so the admitted bytes are exactly the
 * imported bytes.
 */
export function createScriptLoadGate(config: ScriptLoadGateConfig): ScriptLoadGate {
  return {
    async admitScriptLoad(request): Promise<ScriptLoadGateDecision> {
      const validation = await validateScript(request.normalizedSource);
      if (!validation.valid) {
        return { allowed: false, reason: `Script validation failed: ${validation.errors.join('; ')}` };
      }
      if (validation.digest !== request.digest) {
        return { allowed: false, reason: 'Digest mismatch between loader and validated source' };
      }
      const admission = admitScript({
        script: validation,
        authorTrust: config.authorTrust,
        requestedInterfaces: config.requestedInterfaces,
        expectedCheckpointDigest: config.expectedCheckpointDigest,
        checkpointApiVersion: config.checkpointApiVersion,
        checkpointSchemaVersion: config.checkpointSchemaVersion,
      });
      if (!admission.admitted) {
        return { allowed: false, reason: admission.reason };
      }
      if (
        (config.expectedCheckpointDigest !== undefined ||
          config.checkpointApiVersion !== undefined ||
          config.checkpointSchemaVersion !== undefined) && !admission.checkpointAccepted
      ) {
        return {
          allowed: false,
          reason: 'Checkpoint identity does not match this script digest/API/schema',
        };
      }
      const runtimeClass = selectRuntimeClass(config.authorTrust, config.availableRuntimeClasses);
      return {
        allowed: true,
        trustClass: config.authorTrust,
        runtimeClass: runtimeClass.runtimeClass,
        checkpointAccepted: admission.checkpointAccepted,
      };
    },
  };
}

// ─── Agent-facing deployment client (plan 24.14) ───────────────────────

/**
 * Host-bound configuration for {@link createScriptDeploymentClient}.
 * Trust and interface ceilings come from the host, never from the calling
 * script — a script cannot elevate its own trust class or widen the
 * interface set beyond what the host configured.
 */
export interface ScriptDeploymentClientConfig {
  /** Trust class the host assigns to deployments from this context. */
  authorTrust: ScriptTrustClass;
  /**
   * Interface ceiling for deployments (defaults to the widest set
   * admissible for `authorTrust`). Scripts may request a narrower subset;
   * anything wider is rejected by admission.
   */
  requestedInterfaces?: string[];
  /** RuntimeClass names available for selection (defaults to all built-ins). */
  availableRuntimeClasses?: string[];
  /** Artifact persistence port; when omitted manifests are built but not persisted. */
  artifactStore?: ScriptArtifactStore;
  /** Default namespace for produced ArtifactRecords and deployments. */
  namespace?: string;
  /**
   * Orchestration facade. When present, `deploy` also applies an
   * AgentWorkload so the scheduler binds a node (plan 24.14); when absent,
   * `deploy` only produces the deployment request and the readiness/deletion
   * methods reject with UNSUPPORTED.
   */
  orchestration?: AgentOrchestrationClient;
  /** Field manager for applied workloads (default `memeloop/script-deployment`). */
  fieldManager?: string;
}

/** Request a script makes through the deployment client. */
export interface ScriptDeploymentClientRequest {
  /** Raw generated `.mjs` source (normalized internally). */
  source: string;
  /** Desired lifecycle for the remote workload. */
  lifecycle: 'run-once' | 'service' | 'schedule';
  /** Optional narrower interface subset (must stay within the host ceiling). */
  requestedInterfaces?: string[];
  /** Node selector for scheduling. */
  nodeSelector?: Record<string, string>;
  /** Environment variables (never credentials). */
  env?: Record<string, string>;
  /** Network attachment requirements for the deployed workload. */
  networkPolicy?: AgentWorkloadNetworkPolicy;
  /** Existing volume claims required by the deployed workload. */
  storagePolicy?: AgentWorkloadStoragePolicy;
  /** Optional checkpoint digest the script expects to resume from. */
  expectedCheckpointDigest?: string;
  /** API version of the expected checkpoint (plan 24.19). */
  checkpointApiVersion?: string;
  /** Schema version of the expected checkpoint (plan 24.19). */
  checkpointSchemaVersion?: string;
  /** Namespace override (defaults to the configured namespace). */
  namespace?: string;
}

/** Agent-facing handle for declarative script deployment (plan 24.14). */
export interface ScriptDeploymentClient {
  /**
   * Validate, admit, persist, and package a generated script as a
   * {@link RemoteDeploymentRequest} referencing its ArtifactRecord by
   * digest. When an orchestration facade is configured, also applies the
   * AgentWorkload so the scheduler binds a node. Never throws for
   * script-content problems — inadmissible scripts yield `deployed: false`
   * with a structured reason.
   */
  deploy(request: ScriptDeploymentClientRequest): Promise<ScriptDeploymentResult>;
  /**
   * Wait until the scheduler has bound the deployment's workload
   * (`Scheduled=True` condition written by the binding controller).
   */
  waitForScheduled(
    name: string,
    options?: WaitForConditionOptions & { namespace?: string },
  ): Promise<{ observedResourceVersion: string; matched: true }>;
  /** Delete the deployment's workload. */
  deleteDeployment(name: string, namespace?: string): Promise<void>;
}

/**
 * Create the Agent-facing deployment client injected into `.mjs` scripts
 * as `ctx.scriptClient` (plan 24.14). The script declares placement and
 * lifecycle; trust, interface ceilings, and persistence are bound by the
 * host. The scheduler — not the script — selects the target node.
 */
export function createScriptDeploymentClient(config: ScriptDeploymentClientConfig): ScriptDeploymentClient {
  const interfaceCeiling = config.requestedInterfaces ?? defaultRequestedInterfacesForTrustClass(config.authorTrust);

  function requireOrchestration(): AgentOrchestrationClient {
    if (!config.orchestration) {
      throw new OrchestrationError({
        code: 'UNSUPPORTED',
        message: 'script deployment scheduling requires a host-configured orchestration facade',
        retryable: false,
      });
    }
    return config.orchestration;
  }

  return {
    async deploy(request) {
      const result = await deployGeneratedScript(
        {
          source: request.source,
          authorTrust: config.authorTrust,
          requestedInterfaces: request.requestedInterfaces ?? interfaceCeiling,
          lifecycle: request.lifecycle,
          nodeSelector: request.nodeSelector,
          env: request.env,
          networkPolicy: request.networkPolicy,
          storagePolicy: request.storagePolicy,
          expectedCheckpointDigest: request.expectedCheckpointDigest,
          checkpointApiVersion: request.checkpointApiVersion,
          checkpointSchemaVersion: request.checkpointSchemaVersion,
          namespace: request.namespace ?? config.namespace,
        },
        {
          artifactStore: config.artifactStore,
          availableRuntimeClasses: config.availableRuntimeClasses,
        },
      );

      if (result.deployed && result.deployment && config.orchestration) {
        const manifest = remoteDeploymentToWorkloadManifest(result.deployment, {
          namespace: request.namespace ?? config.namespace,
        });
        const workload = await config.orchestration.apply<typeof manifest.spec>(manifest, {
          idempotencyKey: result.deployment.artifactRef.contentDigest,
          fieldManager: config.fieldManager ?? 'memeloop/script-deployment',
        });
        return { ...result, workload: workload as AgentWorkloadResource };
      }
      return result;
    },

    async waitForScheduled(name, options = {}) {
      const orchestration = requireOrchestration();
      const { namespace, ...waitOptions } = options;
      return waitForCondition(
        () =>
          orchestration.get({
            apiVersion: AGENT_WORKLOAD_API_VERSION,
            kind: AGENT_WORKLOAD_KIND,
            name,
            namespace: namespace ?? config.namespace,
          }),
        { type: 'Scheduled', status: 'True' },
        waitOptions,
      );
    },

    async deleteDeployment(name, namespace) {
      const orchestration = requireOrchestration();
      await orchestration.delete({
        apiVersion: AGENT_WORKLOAD_API_VERSION,
        kind: AGENT_WORKLOAD_KIND,
        name,
        namespace: namespace ?? config.namespace,
      });
    },
  };
}
