import type { ControlStoreAuthorizationRequest } from '../controlStore.js';
import type { ArtifactRecordResource, ArtifactRecordStatus, ArtifactReviewEvidence } from '../resources.js';
import { ARTIFACT_RECORD_KIND } from '../resources.js';

/**
 * Verifier-only protected transitions for ArtifactRecord (plan 24.52).
 *
 * Artifact review evidence (scan, sanitize, verify) can only be appended by
 * verifier actors. Storage drivers, controllers, and workers cannot write
 * review outcomes or unquarantine artifacts. This ensures that trust
 * promotion is always grounded in an external, attested verification step.
 */

export interface VerifierOnlyTransitionOptions {
  /** Actor ID prefix that identifies trusted verifiers. */
  verifierActorPrefix?: string;
  /** Allow quarantine by any actor (fail-safe). Default: true. */
  allowAnyActorQuarantine?: boolean;
}

const DEFAULT_VERIFIER_PREFIX = 'verifier/';

/**
 * Create a ControlStore authorizer that enforces verifier-only transitions
 * for ArtifactRecord resources.
 *
 * Rules:
 * 1. Only verifier actors may append reviews or change quarantine status.
 * 2. Review evidence must be bound to the current content hash.
 * 3. Review evidence must record the verifier's actor ID.
 * 4. Quarantine is fail-safe: any actor may quarantine, but only verifiers
 *    may unquarantine (by appending a passing verify review).
 * 5. Non-verifier actors may still read and create ArtifactRecords.
 */
export function createVerifierOnlyAuthorizer(
  options: VerifierOnlyTransitionOptions = {},
): (request: ControlStoreAuthorizationRequest) => void {
  const verifierPrefix = options.verifierActorPrefix ?? DEFAULT_VERIFIER_PREFIX;
  const allowAnyActorQuarantine = options.allowAnyActorQuarantine ?? true;

  return (request: ControlStoreAuthorizationRequest) => {
    if (request.reference.kind !== ARTIFACT_RECORD_KIND) return;

    const { actor, verb, current, proposedStatus } = request;

    if (verb === 'create') {
      // Creation is allowed for any actor; trust is set in spec at creation.
      return;
    }

    if (verb === 'update-status' && current && proposedStatus) {
      const currentStatus = current.status as ArtifactRecordStatus | undefined;
      const proposed = proposedStatus as ArtifactRecordStatus;

      const currentReviews = currentStatus?.reviews ?? [];
      const proposedReviews = proposed.reviews ?? [];

      // If no review changes and no quarantine change, allow.
      const reviewsUnchanged = currentReviews.length === proposedReviews.length &&
        currentReviews.every((review, index) => {
          const proposedReview = proposedReviews[index];
          return (
            review.kind === proposedReview.kind &&
            review.outcome === proposedReview.outcome &&
            review.reviewer === proposedReview.reviewer &&
            review.contentHash === proposedReview.contentHash &&
            review.policyDigest === proposedReview.policyDigest &&
            review.recordedAt === proposedReview.recordedAt &&
            review.destinations.length === proposedReview.destinations.length &&
            review.destinations.every((destination, destinationIndex) => destination === proposedReview.destinations[destinationIndex])
          );
        });
      const currentQuarantined = currentStatus?.quarantined ?? false;
      const proposedQuarantined = proposed.quarantined ?? false;
      const quarantineUnchanged = currentQuarantined === proposedQuarantined &&
        (currentStatus?.quarantineReason ?? '') === (proposed.quarantineReason ?? '');

      if (reviewsUnchanged && quarantineUnchanged) {
        return;
      }

      // Quarantine is fail-safe: any actor may quarantine.
      const isQuarantineOnly = !currentStatus?.quarantined &&
        proposed.quarantined === true &&
        reviewsUnchanged;

      if (isQuarantineOnly && allowAnyActorQuarantine) {
        return;
      }

      // All other transitions require a verifier actor.
      if (!actor.id.startsWith(verifierPrefix)) {
        throw new Error(
          `ArtifactRecord review and unquarantine transitions require a verifier actor (prefix: ${verifierPrefix}), got ${actor.id}`,
        );
      }

      // New reviews must be appended, not modified or removed.
      if (proposedReviews.length < currentReviews.length) {
        throw new Error('ArtifactRecord reviews cannot be removed');
      }
      for (let index = 0; index < currentReviews.length; index += 1) {
        if (currentReviews[index] !== proposedReviews[index]) {
          throw new Error('ArtifactRecord reviews cannot be modified');
        }
      }

      // Validate each new review.
      const newReviews = proposedReviews.slice(currentReviews.length);
      const artifact = current as unknown as ArtifactRecordResource;
      for (const review of newReviews) {
        validateReviewEvidence(review, artifact, actor.id);
      }

      return;
    }
  };
}

function validateReviewEvidence(
  review: ArtifactReviewEvidence,
  artifact: ArtifactRecordResource,
  actorId: string,
): void {
  if (review.contentHash !== artifact.spec.contentHash) {
    throw new Error(
      `Review contentHash ${review.contentHash} does not match artifact contentHash ${artifact.spec.contentHash}`,
    );
  }
  if (review.reviewer !== actorId) {
    throw new Error(
      `Review reviewer ${review.reviewer} must match the acting verifier ${actorId}`,
    );
  }
  if (review.recordedAt.length === 0) {
    throw new Error('Review must record recordedAt timestamp');
  }
}

/**
 * Check whether an actor ID belongs to a verifier.
 */
export function isVerifierActor(actorId: string, verifierPrefix: string = DEFAULT_VERIFIER_PREFIX): boolean {
  return actorId.startsWith(verifierPrefix);
}
