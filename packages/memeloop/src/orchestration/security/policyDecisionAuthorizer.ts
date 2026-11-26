import type { ControlStoreAuthorizationRequest } from '../controlStore.js';
import { OrchestrationError } from '../errors.js';
import { POLICY_DECISION_KIND, type PolicyDecisionResource, type PolicyDecisionSpec, type PolicyDecisionStatus } from '../resources.js';

function forbidden(message: string): never {
  throw new OrchestrationError({
    code: 'FORBIDDEN',
    message,
    retryable: false,
  });
}

/**
 * Protect durable PolicyDecision evidence in the same ControlStore
 * transaction as its write. Decisions are create-only; only an authenticated
 * admin may resolve the status of a pending approval.
 */
export function createPolicyDecisionAuthorizer(): (
  request: ControlStoreAuthorizationRequest,
) => void {
  return (request) => {
    if (request.reference.kind !== POLICY_DECISION_KIND) return;

    if (request.verb === 'create') {
      const spec = request.proposedResource?.spec as
        | PolicyDecisionSpec
        | undefined;
      if (
        !spec ||
        spec.requestedBy !== request.actor.id ||
        (
          spec.decisionKind === 'transition'
            ? request.actor.kind !== 'verifier'
            : request.actor.kind !== 'controller' &&
              request.actor.kind !== 'admin'
        ) ||
        (
          spec.decisionKind === 'approval' &&
          spec.initialOutcome !== 'pending'
        ) ||
        (
          spec.decisionKind !== 'approval' &&
          spec.initialOutcome === 'pending'
        )
      ) {
        forbidden('PolicyDecision creation actor or initial outcome is invalid');
      }
      return;
    }

    if (request.verb === 'update-status') {
      const current = request.current as PolicyDecisionResource | undefined;
      const proposed = request.proposedStatus as
        | PolicyDecisionStatus
        | undefined;
      if (
        !current ||
        current.spec.decisionKind !== 'approval' ||
        current.spec.initialOutcome !== 'pending' ||
        request.actor.kind !== 'admin' ||
        !proposed ||
        (proposed.outcome !== 'allow' && proposed.outcome !== 'deny') ||
        proposed.decidedBy !== request.actor.id ||
        !proposed.decidedAt ||
        !proposed.resolutionInputDigest ||
        !Array.isArray(proposed.reasons) ||
        proposed.reasons.length !== 1
      ) {
        forbidden(
          'only an authenticated admin may resolve a pending PolicyDecision approval',
        );
      }
      const currentStatus = current.status;
      if (
        currentStatus &&
        (
          currentStatus.outcome !== proposed.outcome ||
          currentStatus.decidedBy !== proposed.decidedBy ||
          currentStatus.decidedAt !== proposed.decidedAt ||
          currentStatus.resolutionInputDigest !==
            proposed.resolutionInputDigest ||
          currentStatus.reasons[0] !== proposed.reasons[0]
        )
      ) {
        forbidden('PolicyDecision approval resolution is immutable');
      }
      return;
    }

    forbidden('PolicyDecision resources cannot be applied, deleted, or leased');
  };
}
