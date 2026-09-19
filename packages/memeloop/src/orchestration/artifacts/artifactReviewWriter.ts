import type { ControlStore, ControlStoreActor } from '../controlStore.js';
import type { ArtifactRecordResource, ArtifactRecordStatus, ArtifactReviewEvidence } from '../resources.js';
import { ARTIFACT_RECORD_KIND, isArtifactRecord } from '../resources.js';
import { isCanonicalOrchestrationResource, requireCanonicalOrchestrationResourceOrNull, toControlStoreAuthorizationResource } from '../resourceValidation.js';
import type { ArtifactReviewWriter } from './artifactTrust.js';
import { createVerifierOnlyAuthorizer } from './verifierOnlyTransitions.js';

/**
 * ControlStore-backed ArtifactReviewWriter (plan 24.47).
 *
 * Every review append or quarantine goes through ControlStore.updateStatus,
 * protected by the verifier-only authorizer. The authorizer is injected so
 * callers in different hosts can wire the verifier actor prefix appropriate
 * to their trust model.
 */

export function createControlStoreArtifactReviewWriter(
  store: ControlStore,
  actor: ControlStoreActor,
  authorizer: ReturnType<typeof createVerifierOnlyAuthorizer> = createVerifierOnlyAuthorizer(),
): ArtifactReviewWriter {
  const isCanonicalArtifactRecord = (value: unknown): value is ArtifactRecordResource => isCanonicalOrchestrationResource(value) && isArtifactRecord(value);

  return {
    async appendReview(_contentHash: string, evidence: ArtifactReviewEvidence) {
      const current = requireCanonicalOrchestrationResourceOrNull(
        await store.get<ArtifactRecordResource['spec'], ArtifactRecordResource['status']>({
          kind: ARTIFACT_RECORD_KIND,
          namespace: 'default',
          name: evidence.contentHash,
          apiVersion: 'execution.memeloop.io/v1alpha1',
        }),
        isCanonicalArtifactRecord,
        'ArtifactRecord get',
      );

      if (!current) {
        throw new Error(`ArtifactRecord not found for contentHash ${evidence.contentHash}`);
      }

      const currentReviews = current.status?.reviews ?? [];
      const proposedStatus: ArtifactRecordStatus = {
        ...current.status,
        reviews: [...currentReviews, evidence],
      };

      // Authorize: verifier-only transition.
      authorizer({
        actor,
        verb: 'update-status',
        reference: {
          kind: ARTIFACT_RECORD_KIND,
          namespace: 'default',
          name: evidence.contentHash,
          apiVersion: 'execution.memeloop.io/v1alpha1',
        },
        current: toControlStoreAuthorizationResource(current),
        proposedStatus,
      });

      await store.updateStatus(
        actor,
        {
          kind: ARTIFACT_RECORD_KIND,
          namespace: current.metadata.namespace,
          name: current.metadata.name,
          apiVersion: current.apiVersion,
        },
        proposedStatus,
        { resourceVersion: current.metadata.resourceVersion },
      );
    },

    async quarantine(contentHash: string, reason: string) {
      const current = requireCanonicalOrchestrationResourceOrNull(
        await store.get<ArtifactRecordResource['spec'], ArtifactRecordResource['status']>({
          kind: ARTIFACT_RECORD_KIND,
          namespace: 'default',
          name: contentHash,
          apiVersion: 'execution.memeloop.io/v1alpha1',
        }),
        isCanonicalArtifactRecord,
        'ArtifactRecord get',
      );

      if (!current) {
        throw new Error(`ArtifactRecord not found for contentHash ${contentHash}`);
      }

      const proposedStatus: ArtifactRecordStatus = {
        ...current.status,
        quarantined: true,
        quarantineReason: reason,
      };

      // Authorize: any actor may quarantine (fail-safe).
      authorizer({
        actor,
        verb: 'update-status',
        reference: {
          kind: ARTIFACT_RECORD_KIND,
          namespace: 'default',
          name: contentHash,
          apiVersion: 'execution.memeloop.io/v1alpha1',
        },
        current: toControlStoreAuthorizationResource(current),
        proposedStatus,
      });

      await store.updateStatus(
        actor,
        {
          kind: ARTIFACT_RECORD_KIND,
          namespace: current.metadata.namespace,
          name: current.metadata.name,
          apiVersion: current.apiVersion,
        },
        proposedStatus,
        { resourceVersion: current.metadata.resourceVersion },
      );
    },
  };
}
