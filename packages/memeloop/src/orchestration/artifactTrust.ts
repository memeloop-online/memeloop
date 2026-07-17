import { OrchestrationError } from './errors.js';
import type { ArtifactRecordResource, ArtifactTrust } from './resources.js';

/**
 * Artifact trust propagation and destination gating (plan 24.47).
 *
 * Derived content inherits the LOWEST trust of its inputs. Untrusted or
 * unverified artifacts cannot enter trusted prompts, volumes, backups, or
 * knowledge ingestion without explicit policy allowing the trust level AND a
 * verifier pass recorded by a host-asserted verifier.
 */

const TRUST_RANK: Record<ArtifactTrust, number> = {
  untrusted: 0,
  quarantine: 1,
  restricted: 2,
  trusted: 3,
};

export function artifactTrustRank(trust: ArtifactTrust): number {
  return TRUST_RANK[trust];
}

/** The trust of a derived artifact: the lowest of its parents and producer. */
export function deriveArtifactTrust(parents: ArtifactRecordResource[], producerTrust: ArtifactTrust): ArtifactTrust {
  let lowest = TRUST_RANK[producerTrust];
  for (const parent of parents) {
    lowest = Math.min(lowest, TRUST_RANK[parent.spec.trust]);
  }
  return (Object.keys(TRUST_RANK) as ArtifactTrust[]).find((trust) => TRUST_RANK[trust] === lowest) ?? 'untrusted';
}

export type ArtifactDestination = 'prompt' | 'volume' | 'backup' | 'knowledge';

export interface ArtifactDestinationPolicy {
  /** Minimum trust accepted at this destination without a verifier pass. */
  minimumTrust: ArtifactTrust;
  /** When true, a verifier pass can admit lower-trust content. */
  allowVerifiedOverride?: boolean;
}

export const DEFAULT_DESTINATION_POLICIES: Record<ArtifactDestination, ArtifactDestinationPolicy> = {
  prompt: { minimumTrust: 'restricted', allowVerifiedOverride: true },
  volume: { minimumTrust: 'restricted', allowVerifiedOverride: true },
  backup: { minimumTrust: 'restricted', allowVerifiedOverride: false },
  knowledge: { minimumTrust: 'trusted', allowVerifiedOverride: true },
};

export interface ArtifactAdmissionDecision {
  admitted: boolean;
  reason: string;
}

/**
 * Decide whether an artifact may enter a destination. Quarantined artifacts
 * are never admitted. Below the policy's minimum trust, admission requires
 * `allowVerifiedOverride` AND status.verified === 'passed' recorded by a
 * verifier (`verifiedBy` present).
 */
export function canArtifactEnter(
  artifact: ArtifactRecordResource,
  destination: ArtifactDestination,
  policy: ArtifactDestinationPolicy = DEFAULT_DESTINATION_POLICIES[destination],
): ArtifactAdmissionDecision {
  if (artifact.status?.quarantined) {
    return { admitted: false, reason: `artifact is quarantined (${artifact.status.quarantineReason ?? 'no reason recorded'})` };
  }
  if (artifactTrustRank(artifact.spec.trust) >= artifactTrustRank(policy.minimumTrust)) {
    return { admitted: true, reason: `trust '${artifact.spec.trust}' meets ${destination} minimum '${policy.minimumTrust}'` };
  }
  if (policy.allowVerifiedOverride && artifact.status?.verified === 'passed' && artifact.status.verifiedBy) {
    return { admitted: true, reason: `admitted to ${destination} by verifier '${artifact.status.verifiedBy}' override` };
  }
  return {
    admitted: false,
    reason: `trust '${artifact.spec.trust}' below ${destination} minimum '${policy.minimumTrust}'` +
      (policy.allowVerifiedOverride ? ' and no verifier pass recorded' : ' and verified override disabled'),
  };
}

/** Throwing variant for driver/controller enforcement points. */
export function assertArtifactAdmission(
  artifact: ArtifactRecordResource,
  destination: ArtifactDestination,
  policy?: ArtifactDestinationPolicy,
): void {
  const decision = canArtifactEnter(artifact, destination, policy);
  if (!decision.admitted) {
    throw new OrchestrationError({
      code: 'FORBIDDEN',
      message: `artifact '${artifact.metadata.name}' cannot enter ${destination}: ${decision.reason}`,
      retryable: false,
    });
  }
}

/**
 * Artifact driver contract: content-addressed storage with bounded streams,
 * scanning, sanitation, verification, promotion, quarantine, and deletion.
 * Implementations defend against hostile content per plan 24.48; the driver
 * never mounts or promotes untrusted content on its own authority.
 */
export interface ArtifactDriver {
  /** Store bounded content; returns the content hash. Rejects oversize input. */
  put(content: Uint8Array, options: { mimeType?: string; maxBytes?: number }): Promise<string>;
  /** Resolve content by hash; null when missing. */
  get(contentHash: string): Promise<Uint8Array | null>;
  /** Record a scan/sanitize outcome (trusted reviewer identity required). */
  recordReview(contentHash: string, review: { scanned?: 'passed' | 'failed'; sanitized?: 'passed' | 'failed'; reviewer: string }): Promise<void>;
  /** Record a verifier pass (verifier identity required, host-asserted). */
  recordVerification(contentHash: string, verifier: string): Promise<void>;
  /** Quarantine content with a reason; quarantined content is never admitted anywhere. */
  quarantine(contentHash: string, reason: string): Promise<void>;
  delete(contentHash: string): Promise<void>;
}
