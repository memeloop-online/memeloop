import type { OrchestrationResourceStatus } from '../client.js';
import type { ControlStoreAuthorizationRequest } from '../controlStore.js';
import type { ArtifactDestination, ArtifactRecordResource, ArtifactRecordStatus, ArtifactReviewEvidence } from '../resources.js';
import { ARTIFACT_RECORD_KIND, isArtifactRecord } from '../resources.js';
import { isCanonicalOrchestrationResource, requireCanonicalOrchestrationResource } from '../resourceValidation.js';

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

  const isCanonicalArtifactRecord = (value: unknown): value is ArtifactRecordResource => isCanonicalOrchestrationResource(value) && isArtifactRecord(value);

  function isArtifactReviewEvidence(value: unknown): value is ArtifactReviewEvidence {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return (
      (record.kind === 'scan' || record.kind === 'sanitize' || record.kind === 'verify') &&
      (record.outcome === 'passed' || record.outcome === 'failed') &&
      typeof record.reviewer === 'string' && record.reviewer.length > 0 &&
      typeof record.contentHash === 'string' && record.contentHash.length > 0 &&
      typeof record.policyDigest === 'string' && record.policyDigest.length > 0 &&
      Array.isArray(record.destinations) &&
      record.destinations.every((destination): destination is ArtifactDestination =>
        destination === 'prompt' || destination === 'volume' || destination === 'backup' || destination === 'knowledge'
      ) &&
      // Keep the field structurally typed here so the transition validator can
      // report the stable, actionable missing-timestamp error below.
      typeof record.recordedAt === 'string' &&
      (record.properties === undefined ||
        (Array.isArray(record.properties) && record.properties.every((property) => typeof property === 'string')))
    );
  }

  function isArtifactRecordStatus(value: OrchestrationResourceStatus): value is ArtifactRecordStatus {
    const candidate: unknown = value;
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const record = candidate as Record<string, unknown>;
    return (
      (record.reviews === undefined ||
        (Array.isArray(record.reviews) && record.reviews.every(isArtifactReviewEvidence))) &&
      (record.quarantined === undefined || typeof record.quarantined === 'boolean') &&
      (record.quarantineReason === undefined || typeof record.quarantineReason === 'string') &&
      (record.derivedBy === undefined ||
        (Array.isArray(record.derivedBy) && record.derivedBy.every((name) => typeof name === 'string')))
    );
  }

  function artifactStatus(
    value: OrchestrationResourceStatus | undefined,
  ): ArtifactRecordStatus | undefined {
    if (value === undefined) return undefined;
    if (!isArtifactRecordStatus(value)) {
      throw new Error('ArtifactRecord status must be an object');
    }
    return value;
  }

  return (request: ControlStoreAuthorizationRequest) => {
    if (request.reference.kind !== ARTIFACT_RECORD_KIND) return;

    const { actor, verb, current, proposedStatus } = request;

    if (verb === 'create') {
      // Creation is allowed for any actor; trust is set in spec at creation.
      return;
    }

    if (verb === 'update-status' && current && proposedStatus) {
      const currentRecord = requireCanonicalOrchestrationResource(
        current,
        isCanonicalArtifactRecord,
        'ArtifactRecord authorization',
      );
      const currentStatus = artifactStatus(currentRecord.status);
      const proposed = artifactStatus(proposedStatus);
      if (!proposed) {
        throw new Error('ArtifactRecord proposed status is required for a status update');
      }

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
      for (const review of newReviews) {
        validateReviewEvidence(review, currentRecord, actor.id);
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
