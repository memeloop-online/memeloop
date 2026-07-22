/**
 * Script admission policy and checkpoint compatibility (plan 24.17, 24.19).
 *
 * - Admission: trust class, author, imports, resource limits, approval
 * - Compatibility: script digest/API version vs checkpoint schema
 *
 * Quarantine scripts cannot enable arbitrary network imports or plugin loading.
 * A changed script cannot resume an incompatible checkpoint without explicit
 * converter or restart policy.
 */

import type { ScriptValidationResult } from './scriptValidation.js';

export type ScriptTrustClass = 'trusted' | 'restricted' | 'quarantine';

export interface ScriptAdmissionRequest {
  /** The validated script result. */
  script: ScriptValidationResult;
  /** Trust class of the author (e.g., the Agent that generated the script). */
  authorTrust: ScriptTrustClass;
  /** Requested interfaces the script wants to use. */
  requestedInterfaces: string[];
  /** Optional checkpoint digest the script expects to resume from. */
  expectedCheckpointDigest?: string;
  /** The checkpoint's API version (for compatibility check). */
  checkpointApiVersion?: string;
}

export interface ScriptAdmissionDecision {
  admitted: boolean;
  reason: string;
  /** Which interfaces are approved for this script. */
  approvedInterfaces: string[];
  /** Whether the checkpoint is compatible. */
  checkpointCompatible: boolean;
  /** If not admitted, whether the author can retry with changes. */
  retryable: boolean;
}

interface TrustProfile {
  maxScriptBytes: number;
  allowedInterfaces: string[];
  forbiddenImports: string[];
  requireDefaultExport: boolean;
  allowUntrustedInputs: boolean;
}

const TRUST_PROFILES: Record<ScriptTrustClass, TrustProfile> = {
  trusted: {
    maxScriptBytes: 1_048_576, // 1 MiB
    allowedInterfaces: ['resource', 'loop-runtime', 'tool-execution', 'model-provider', 'network', 'storage', 'credential-broker', 'artifact'],
    forbiddenImports: [],
    requireDefaultExport: true,
    allowUntrustedInputs: false,
  },
  restricted: {
    maxScriptBytes: 256_000, // 256 KiB
    allowedInterfaces: ['resource', 'loop-runtime', 'model-provider'],
    forbiddenImports: ['node:fs', 'node:child_process', 'node:net', 'node:http', 'node:https'],
    requireDefaultExport: true,
    allowUntrustedInputs: false,
  },
  quarantine: {
    maxScriptBytes: 64_000, // 64 KiB
    allowedInterfaces: ['loop-runtime'], // No network, no file system, no model provider
    forbiddenImports: ['node:fs', 'node:child_process', 'node:net', 'node:http', 'node:https', 'node:os', 'node:crypto'],
    requireDefaultExport: true,
    allowUntrustedInputs: false,
  },
};

const COMPATIBLE_CHECKPOINT_VERSIONS = new Set(['loops.memeloop.io/v1alpha1']);

/**
 * The full interface set a host may grant to scripts authored under the
 * given trust class — a defensive copy of the trust profile's allowlist.
 *
 * Hosts wiring a {@link ../loopAPI/types.ScriptLoadGate} or a deployment
 * pipeline should pass these as `requestedInterfaces`; {@link admitScript}
 * rejects any request outside the trust profile, so this is the widest set
 * that can ever be approved for that class. Callers may pass a narrower
 * subset to further restrict a specific runtime.
 */
export function defaultRequestedInterfacesForTrustClass(trustClass: ScriptTrustClass): string[] {
  return [...TRUST_PROFILES[trustClass].allowedInterfaces];
}

/** Maximum script size in bytes admitted for the given trust class. */
export function maxScriptBytesForTrustClass(trustClass: ScriptTrustClass): number {
  return TRUST_PROFILES[trustClass].maxScriptBytes;
}

/**
 * Decide whether a generated script may be admitted for execution.
 */
export function admitScript(request: ScriptAdmissionRequest): ScriptAdmissionDecision {
  const profile = TRUST_PROFILES[request.authorTrust];
  const approvedInterfaces: string[] = [];

  // 1. Size check.
  if (request.script.sizeBytes > profile.maxScriptBytes) {
    return {
      admitted: false,
      reason: `Script size ${request.script.sizeBytes} exceeds ${request.authorTrust} limit ${profile.maxScriptBytes}`,
      approvedInterfaces: [],
      checkpointCompatible: false,
      retryable: true,
    };
  }

  // 2. Syntax check.
  if (!request.script.valid) {
    return {
      admitted: false,
      reason: `Script validation failed: ${request.script.errors.join('; ')}`,
      approvedInterfaces: [],
      checkpointCompatible: false,
      retryable: true,
    };
  }

  // 3. Export check.
  if (profile.requireDefaultExport && !request.script.hasDefaultExport) {
    return {
      admitted: false,
      reason: 'Script must export a default async generator',
      approvedInterfaces: [],
      checkpointCompatible: false,
      retryable: true,
    };
  }

  // 4. Import policy.
  for (const imp of request.script.imports) {
    // Forbidden imports per trust profile.
    if (profile.forbiddenImports.includes(imp) || profile.forbiddenImports.includes(imp.replace(/^node:/, ''))) {
      return {
        admitted: false,
        reason: `Import '${imp}' not allowed for ${request.authorTrust} scripts`,
        approvedInterfaces: [],
        checkpointCompatible: false,
        retryable: false,
      };
    }
  }

  // 5. Interface policy.
  for (const iface of request.requestedInterfaces) {
    if (!profile.allowedInterfaces.includes(iface)) {
      return {
        admitted: false,
        reason: `Interface '${iface}' not allowed for ${request.authorTrust} scripts`,
        approvedInterfaces: [],
        checkpointCompatible: false,
        retryable: false,
      };
    }
    approvedInterfaces.push(iface);
  }

  // 6. Checkpoint compatibility.
  let checkpointCompatible = true;
  if (request.expectedCheckpointDigest && request.checkpointApiVersion) {
    if (!COMPATIBLE_CHECKPOINT_VERSIONS.has(request.checkpointApiVersion)) {
      checkpointCompatible = false;
    }
    // Changed script digest cannot resume old checkpoint without explicit converter.
    if (request.expectedCheckpointDigest !== request.script.digest) {
      checkpointCompatible = false;
    }
  }

  return {
    admitted: true,
    reason: `Admitted as ${request.authorTrust}`,
    approvedInterfaces,
    checkpointCompatible,
    retryable: false,
  };
}
