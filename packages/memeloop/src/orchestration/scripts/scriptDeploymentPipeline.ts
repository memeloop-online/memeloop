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
import { type ArtifactRecordManifest, createArtifactRecordManifest } from '../resources.js';
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
  /** Optional checkpoint digest the script expects to resume from. */
  expectedCheckpointDigest?: string;
  /** API version of the expected checkpoint (plan 24.19). */
  checkpointApiVersion?: string;
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
}

/**
 * Run the full generated-script security chain and produce a remote
 * deployment request. Never throws for script-content problems — invalid or
 * inadmissible scripts yield `deployed: false` with a structured reason.
 *
 * Checkpoint compatibility (plan 24.19) is enforced here: when the caller
 * expects to resume a checkpoint and admission found it incompatible, no
 * deployment is produced (an explicit converter or restart policy would be
 * required first).
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
  });
  if (!admission.admitted) {
    return { deployed: false, reason: admission.reason, validation, admission };
  }
  if (request.expectedCheckpointDigest !== undefined && !admission.checkpointCompatible) {
    return {
      deployed: false,
      reason: 'Checkpoint is incompatible with this script digest/API version; an explicit converter or restart policy is required',
      validation,
      admission,
    };
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
      });
      if (!admission.admitted) {
        return { allowed: false, reason: admission.reason };
      }
      if (config.expectedCheckpointDigest !== undefined && !admission.checkpointCompatible) {
        return {
          allowed: false,
          reason: 'Checkpoint is incompatible with this script digest/API version; an explicit converter or restart policy is required',
        };
      }
      const runtimeClass = selectRuntimeClass(config.authorTrust, config.availableRuntimeClasses);
      return {
        allowed: true,
        trustClass: config.authorTrust,
        runtimeClass: runtimeClass.runtimeClass,
        checkpointCompatible: admission.checkpointCompatible,
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
  /** Optional checkpoint digest the script expects to resume from. */
  expectedCheckpointDigest?: string;
  /** API version of the expected checkpoint (plan 24.19). */
  checkpointApiVersion?: string;
  /** Namespace override (defaults to the configured namespace). */
  namespace?: string;
}

/** Agent-facing handle for declarative script deployment (plan 24.14). */
export interface ScriptDeploymentClient {
  /**
   * Validate, admit, persist, and package a generated script as a
   * {@link RemoteDeploymentRequest} referencing its ArtifactRecord by
   * digest. Never throws for script-content problems — inadmissible
   * scripts yield `deployed: false` with a structured reason.
   */
  deploy(request: ScriptDeploymentClientRequest): Promise<ScriptDeploymentResult>;
}

/**
 * Create the Agent-facing deployment client injected into `.mjs` scripts
 * as `ctx.scriptClient` (plan 24.14). The script declares placement and
 * lifecycle; trust, interface ceilings, and persistence are bound by the
 * host. The scheduler — not the script — selects the target node.
 */
export function createScriptDeploymentClient(config: ScriptDeploymentClientConfig): ScriptDeploymentClient {
  const interfaceCeiling = config.requestedInterfaces ?? defaultRequestedInterfacesForTrustClass(config.authorTrust);
  return {
    deploy(request) {
      return deployGeneratedScript(
        {
          source: request.source,
          authorTrust: config.authorTrust,
          requestedInterfaces: request.requestedInterfaces ?? interfaceCeiling,
          lifecycle: request.lifecycle,
          nodeSelector: request.nodeSelector,
          env: request.env,
          expectedCheckpointDigest: request.expectedCheckpointDigest,
          checkpointApiVersion: request.checkpointApiVersion,
          namespace: request.namespace ?? config.namespace,
        },
        {
          artifactStore: config.artifactStore,
          availableRuntimeClasses: config.availableRuntimeClasses,
        },
      );
    },
  };
}
