/**
 * Script sandbox/runtime selection (plan 24.18) and remote deployment (plan 24.14).
 *
 * - RuntimeClass: declares module isolation, resource limits, cancellation,
 *   and supported trust classes for generated scripts.
 * - Sandbox selection: maps script trust class to appropriate RuntimeClass.
 * - Remote deployment: script declares placement desires; scheduler picks node.
 *
 * Scripts cannot silently run in an unrestricted controller process.
 */

import type { ScriptTrustClass } from './scriptAdmission.js';

// ─── RuntimeClass ──────────────────────────────────────────────────────

export interface RuntimeClassSpec {
  /** Module isolation level. */
  isolation: 'none' | 'process' | 'container';
  /** CPU limit in millicores (1000 = 1 core). */
  cpuLimitMillis?: number;
  /** Memory limit in bytes. */
  memoryLimitBytes?: number;
  /** Wall-clock time limit in milliseconds. */
  timeLimitMs?: number;
  /** Whether the runtime supports cancellation signals. */
  supportsCancellation: boolean;
  /** Supported trust classes for this runtime. */
  supportedTrustClasses: ScriptTrustClass[];
  /** Whether network access is allowed (outbound-only for quarantine). */
  networkAccess: 'none' | 'outbound-only' | 'full';
}

export interface RuntimeClassResource {
  apiVersion: 'execution.memeloop.io/v1alpha1';
  kind: 'RuntimeClass';
  metadata: {
    name: string;
    namespace?: string;
  };
  spec: RuntimeClassSpec;
}

// ─── Built-in Runtime Classes ──────────────────────────────────────────

export const BUILTIN_RUNTIME_CLASSES: Record<string, RuntimeClassSpec> = {
  'trusted-process': {
    isolation: 'process',
    cpuLimitMillis: 2000,
    memoryLimitBytes: 512 * 1024 * 1024, // 512 MiB
    timeLimitMs: 300_000, // 5 min
    supportsCancellation: true,
    supportedTrustClasses: ['trusted'],
    networkAccess: 'full',
  },
  'restricted-process': {
    isolation: 'process',
    cpuLimitMillis: 1000,
    memoryLimitBytes: 128 * 1024 * 1024, // 128 MiB
    timeLimitMs: 120_000, // 2 min
    supportsCancellation: true,
    supportedTrustClasses: ['trusted', 'restricted'],
    networkAccess: 'outbound-only',
  },
  'quarantine-process': {
    isolation: 'process',
    cpuLimitMillis: 500,
    memoryLimitBytes: 32 * 1024 * 1024, // 32 MiB
    timeLimitMs: 30_000, // 30 sec
    supportsCancellation: true,
    supportedTrustClasses: ['quarantine'],
    networkAccess: 'none',
  },
};

// ─── Sandbox Selection ─────────────────────────────────────────────────

export interface SandboxSelectionResult {
  runtimeClass: string;
  isolation: RuntimeClassSpec['isolation'];
  cpuLimitMillis: number;
  memoryLimitBytes: number;
  timeLimitMs: number;
  networkAccess: RuntimeClassSpec['networkAccess'];
}

/**
 * Select the most restrictive RuntimeClass capable of hosting the given
 * trust class. Throws when no available RuntimeClass supports the trust
 * class — there is no silent fallback (24.18).
 */
export function selectRuntimeClass(trustClass: ScriptTrustClass, available: string[] = Object.keys(BUILTIN_RUNTIME_CLASSES)): SandboxSelectionResult {
  // Prefer exact match by trust class.
  const exact = available.find((name) => {
    const spec = BUILTIN_RUNTIME_CLASSES[name];
    return spec?.supportedTrustClasses.includes(trustClass);
  });

  if (!exact) {
    throw new Error('No RuntimeClass available for trust class: ' + trustClass);
  }
  const name = exact;
  const spec = BUILTIN_RUNTIME_CLASSES[name];

  return {
    runtimeClass: name,
    isolation: spec.isolation,
    cpuLimitMillis: spec.cpuLimitMillis ?? 500,
    memoryLimitBytes: spec.memoryLimitBytes ?? 32 * 1024 * 1024,
    timeLimitMs: spec.timeLimitMs ?? 30_000,
    networkAccess: spec.networkAccess,
  };
}

// ─── Remote Deployment Descriptor ──────────────────────────────────────

/**
 * Reference to a content-addressed ArtifactRecord holding the script source
 * (plan 24.15/24.47). Remote deployments never carry raw script source
 * strings; the target node resolves the artifact by identity and verifies
 * it against `contentDigest` before loading.
 */
export interface ScriptArtifactReference {
  /** API version of the artifact resource (`artifacts.memeloop.io/v1alpha1`). */
  apiVersion: string;
  /** Resource kind; always `ArtifactRecord`. */
  kind: 'ArtifactRecord';
  /** Artifact resource name. */
  name: string;
  /** Artifact namespace, if any. */
  namespace?: string;
  /**
   * Content digest (`sha256:<hex>`) of the NORMALIZED script source. The
   * remote node must verify the fetched artifact content against this
   * digest before admission.
   */
  contentDigest: string;
}

export interface RemoteDeploymentRequest {
  /**
   * Content-addressed reference to the script artifact. Raw script source
   * is never transported inside a deployment request.
   */
  artifactRef: ScriptArtifactReference;
  /** Trust class assigned by admission. */
  trustClass: ScriptTrustClass;
  /** Desired lifecycle. */
  lifecycle: 'run-once' | 'service' | 'schedule';
  /** Runtime class to use. */
  runtimeClass: string;
  /** Node selector for scheduling. */
  nodeSelector?: Record<string, string>;
  /** Environment variables (never credentials). */
  env?: Record<string, string>;
}

export interface RemoteDeploymentResult {
  /** Workload name created on the target node. */
  workloadName: string;
  /** Node the workload was placed on. */
  nodeName: string;
  /** When the deployment was requested. */
  requestedAt: string;
}
