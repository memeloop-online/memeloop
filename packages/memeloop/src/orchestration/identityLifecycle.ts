import type { ControlStore, ControlStoreActor } from './controlStore.js';
import type { WorkerEnrollmentResource, WorkerSessionResource } from './workerIdentity.js';
import { isWorkerSessionValid, WORKER_ENROLLMENT_API_VERSION, WORKER_ENROLLMENT_KIND, WORKER_SESSION_API_VERSION, WORKER_SESSION_KIND } from './workerIdentity.js';

export type IdentityRevocationReason = 'security-incident' | 'credential-rotation' | 'policy-violation' | 'manual';

export interface IdentityRevocationRecord {
  enrollmentName: string;
  sessionNames: string[];
  reason: IdentityRevocationReason;
  revokedBy: string;
  revokedAt: string;
  evidence?: string;
}

export interface IdentityPromotionRequest {
  /** The quarantine enrollment to promote from. */
  sourceEnrollmentName: string;
  /** New trust class for the promoted identity. */
  targetTrustClass: 'trusted' | 'restricted';
  /** Evidence from trusted verification (e.g. reimage attestation). */
  verificationEvidence: string;
  /** Verifier actor ID that performed the verification. */
  verifiedBy: string;
  /** Approval actor ID that authorized the promotion. */
  approvedBy: string;
}

/**
 * Permanently revoke a quarantine identity and all its sessions.
 * Once revoked, the identity cannot be re-enabled; promotion requires
 * creating a new enrollment through trusted verification.
 */
export async function revokeQuarantineIdentity(
  store: ControlStore,
  actor: ControlStoreActor,
  enrollmentName: string,
  reason: IdentityRevocationReason,
  evidence?: string,
  now: () => Date = () => new Date(),
): Promise<IdentityRevocationRecord> {
  if (actor.kind !== 'controller' && actor.kind !== 'admin') {
    throw new Error('Identity revocation requires controller or admin actor');
  }

  // Get the enrollment.
  const enrollment = await store.get({
    apiVersion: WORKER_ENROLLMENT_API_VERSION,
    kind: WORKER_ENROLLMENT_KIND,
    name: enrollmentName,
  }) as WorkerEnrollmentResource | null;

  if (!enrollment) {
    throw new Error(`WorkerEnrollment ${enrollmentName} not found`);
  }

  // Only quarantine identities can be permanently revoked through this path.
  if (enrollment.spec.trustClass !== 'quarantine') {
    throw new Error(
      `Only quarantine identities can be permanently revoked; ${enrollmentName} has trust class ${enrollment.spec.trustClass}`,
    );
  }

  // Find all active sessions for this enrollment.
  const sessions = await store.list({
    kind: WORKER_SESSION_KIND,
  });
  const currentTime = now();
  const activeSessions = (sessions.items as unknown as WorkerSessionResource[]).filter(
    (session) =>
      session.spec.enrollmentRef.name === enrollmentName &&
      isWorkerSessionValid(session, currentTime),
  );

  // Revoke all active sessions.
  const revokedAt = now().toISOString();
  for (const session of activeSessions) {
    await store.updateStatus(
      actor,
      { apiVersion: WORKER_SESSION_API_VERSION, kind: WORKER_SESSION_KIND, name: session.metadata.name },
      {
        phase: 'Revoked',
        revokedAt,
        revokeReason: `enrollment revoked: ${reason}`,
      },
      { resourceVersion: session.metadata.resourceVersion },
    );
  }

  // Mark the enrollment itself as revoked.
  await store.updateStatus(
    actor,
    { apiVersion: WORKER_ENROLLMENT_API_VERSION, kind: WORKER_ENROLLMENT_KIND, name: enrollmentName },
    {
      phase: 'Revoked',
      revokedAt,
      revokeReason: reason,
    },
    { resourceVersion: enrollment.metadata.resourceVersion },
  );

  return {
    enrollmentName,
    sessionNames: activeSessions.map((session) => session.metadata.name),
    reason,
    revokedBy: actor.id,
    revokedAt,
    evidence,
  };
}

/**
 * Promote a quarantine identity to a new ordinary identity after trusted
 * verification. The old quarantine enrollment is permanently revoked, and a
 * new enrollment is created with the target trust class.
 */
export async function promoteIdentity(
  store: ControlStore,
  actor: ControlStoreActor,
  request: IdentityPromotionRequest,
  now: () => Date = () => new Date(),
): Promise<WorkerEnrollmentResource> {
  if (actor.kind !== 'controller' && actor.kind !== 'admin') {
    throw new Error('Identity promotion requires controller or admin actor');
  }

  // Get the source enrollment.
  const source = await store.get({
    apiVersion: WORKER_ENROLLMENT_API_VERSION,
    kind: WORKER_ENROLLMENT_KIND,
    name: request.sourceEnrollmentName,
  }) as WorkerEnrollmentResource | null;

  if (!source) {
    throw new Error(`WorkerEnrollment ${request.sourceEnrollmentName} not found`);
  }

  if (source.spec.trustClass !== 'quarantine') {
    throw new Error(
      `Only quarantine identities can be promoted; ${request.sourceEnrollmentName} has trust class ${source.spec.trustClass}`,
    );
  }

  // Permanently revoke the old quarantine identity.
  await revokeQuarantineIdentity(
    store,
    actor,
    request.sourceEnrollmentName,
    'security-incident',
    `promoted to new identity with evidence: ${request.verificationEvidence}`,
    now,
  );

  // Create a new enrollment with the target trust class.
  const newEnrollmentName = `${request.sourceEnrollmentName}-promoted-${Date.now()}`;
  const manifest = {
    apiVersion: WORKER_ENROLLMENT_API_VERSION,
    kind: WORKER_ENROLLMENT_KIND,
    metadata: { name: newEnrollmentName },
    spec: {
      nodeRef: source.spec.nodeRef,
      trustClass: request.targetTrustClass,
      bootstrapTokenHash: source.spec.bootstrapTokenHash,
      enrolledBy: request.approvedBy,
      expiresAt: new Date(now().getTime() + 24 * 60 * 60 * 1000).toISOString(),
    },
  };

  const resource = await store.create(actor, manifest);
  return resource as WorkerEnrollmentResource;
}

/**
 * Check whether an identity is permanently revoked.
 */
export async function isIdentityRevoked(
  store: ControlStore,
  enrollmentName: string,
): Promise<boolean> {
  const enrollment = await store.get({
    apiVersion: WORKER_ENROLLMENT_API_VERSION,
    kind: WORKER_ENROLLMENT_KIND,
    name: enrollmentName,
  }) as WorkerEnrollmentResource | null;

  const status = enrollment?.status as import('./workerIdentity.js').WorkerEnrollmentStatus | undefined;
  return status?.phase === 'Revoked';
}
