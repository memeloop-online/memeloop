import { OrchestrationError } from './errors.js';
import type { ArtifactDestination, ArtifactRecordResource, ArtifactReviewEvidence, ArtifactReviewKind, ArtifactTrust } from './resources.js';

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

export interface ArtifactDestinationPolicy {
  /** Minimum producer/lineage trust accepted by default. */
  minimumTrust: ArtifactTrust;
  /** Exact policy revision review evidence must be bound to. */
  policyDigest: string;
  requiredReviews: ArtifactReviewKind[];
  /** Explicitly allow lower lineage trust after every required review passes. */
  allowLowerTrust?: boolean;
}

export const DEFAULT_DESTINATION_POLICIES: Record<ArtifactDestination, ArtifactDestinationPolicy> = {
  prompt: { minimumTrust: 'restricted', policyDigest: 'builtin:artifact/prompt/v1', requiredReviews: ['sanitize'] },
  volume: { minimumTrust: 'trusted', policyDigest: 'builtin:artifact/volume/v1', requiredReviews: ['scan', 'verify'] },
  backup: { minimumTrust: 'trusted', policyDigest: 'builtin:artifact/backup/v1', requiredReviews: ['scan', 'verify'] },
  knowledge: {
    minimumTrust: 'trusted',
    policyDigest: 'builtin:artifact/knowledge/v1',
    requiredReviews: ['scan', 'sanitize', 'verify'],
  },
};

export interface ArtifactAdmissionDecision {
  admitted: boolean;
  reason: string;
}

/**
 * Decide whether an artifact may enter a destination. Evidence is valid only
 * for the exact content hash, policy revision, and destination it names.
 */
export function canArtifactEnter(
  artifact: ArtifactRecordResource,
  destination: ArtifactDestination,
  policy: ArtifactDestinationPolicy = DEFAULT_DESTINATION_POLICIES[destination],
): ArtifactAdmissionDecision {
  if (artifact.status?.quarantined) {
    return { admitted: false, reason: `artifact is quarantined (${artifact.status.quarantineReason ?? 'no reason recorded'})` };
  }
  const reviews = artifact.status?.reviews ?? [];
  const failed = reviews.find((review) => review.contentHash === artifact.spec.contentHash && review.outcome === 'failed');
  if (failed) {
    return { admitted: false, reason: `${failed.kind} review failed for current content` };
  }
  const meetsTrust = artifactTrustRank(artifact.spec.trust) >= artifactTrustRank(policy.minimumTrust);
  if (!meetsTrust && !policy.allowLowerTrust) {
    return { admitted: false, reason: `trust '${artifact.spec.trust}' below ${destination} minimum '${policy.minimumTrust}'` };
  }
  if (!meetsTrust && !policy.requiredReviews.includes('verify')) {
    return { admitted: false, reason: 'lower-trust policy must require a narrow verifier review' };
  }
  for (const kind of policy.requiredReviews) {
    const passed = reviews.some((review) =>
      review.kind === kind &&
      review.outcome === 'passed' &&
      review.contentHash === artifact.spec.contentHash &&
      review.policyDigest === policy.policyDigest &&
      review.destinations.includes(destination) &&
      review.reviewer.length > 0
    );
    if (!passed) return { admitted: false, reason: `missing ${kind} review for ${destination} policy '${policy.policyDigest}'` };
  }
  return { admitted: true, reason: `trust and required reviews satisfy ${destination} policy '${policy.policyDigest}'` };
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
 * Content storage does not own review or promotion authority. Implementations
 * stream through a hard byte limit and return a digest they computed.
 */
export interface ArtifactContentStore {
  put(content: AsyncIterable<Uint8Array>, options: { mimeType?: string; maxBytes: number }): Promise<{ contentHash: string; sizeBytes: number }>;
  get(contentHash: string): Promise<AsyncIterable<Uint8Array> | null>;
  delete(contentHash: string): Promise<void>;
}

export interface ArtifactInspectionRequest {
  contentHash: string;
  policyDigest: string;
  destinations: ArtifactDestination[];
  maxBytes: number;
}

export interface ArtifactInspectionResult {
  contentHash: string;
  policyDigest: string;
  reviews: ArtifactReviewEvidence[];
}

/** Host adapter that parses content in a separate sandbox, never a controller. */
export interface ArtifactInspectionExecutor {
  inspect(request: ArtifactInspectionRequest): Promise<ArtifactInspectionResult>;
}

/** Narrow trusted writer; workers and inspection sandboxes never receive it. */
export interface ArtifactReviewWriter {
  appendReview(contentHash: string, evidence: ArtifactReviewEvidence): Promise<void>;
  quarantine(contentHash: string, reason: string): Promise<void>;
}

/** Execute inspection externally, validate its binding, and quarantine failures. */
export async function inspectAndRecordArtifact(
  artifact: ArtifactRecordResource,
  request: Omit<ArtifactInspectionRequest, 'contentHash'>,
  executor: ArtifactInspectionExecutor,
  writer: ArtifactReviewWriter,
): Promise<ArtifactInspectionResult> {
  const result = await executor.inspect({ ...request, contentHash: artifact.spec.contentHash });
  if (result.contentHash !== artifact.spec.contentHash || result.policyDigest !== request.policyDigest) {
    await writer.quarantine(artifact.spec.contentHash, 'artifact inspection result binding mismatch');
    throw new OrchestrationError({ code: 'FORBIDDEN', message: 'artifact inspection result binding mismatch', retryable: false });
  }
  for (const review of result.reviews) {
    const destinationsValid = review.destinations.every((destination) => request.destinations.includes(destination));
    if (
      review.contentHash !== artifact.spec.contentHash ||
      review.policyDigest !== request.policyDigest ||
      !review.reviewer ||
      !destinationsValid
    ) {
      await writer.quarantine(artifact.spec.contentHash, 'artifact review evidence binding mismatch');
      throw new OrchestrationError({ code: 'FORBIDDEN', message: 'artifact review evidence binding mismatch', retryable: false });
    }
    await writer.appendReview(artifact.spec.contentHash, review);
  }
  const failed = result.reviews.find((review) => review.outcome === 'failed');
  if (failed) await writer.quarantine(artifact.spec.contentHash, `${failed.kind} review failed`);
  return result;
}
