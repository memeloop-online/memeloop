import type { ControlStore, ControlStoreActor } from '../controlStore.js';
import { isCanonicalOrchestrationResource, requireCanonicalOrchestrationResource, requireCanonicalOrchestrationResourceOrNull } from '../resourceValidation.js';
import type { BindWorkerSessionRequest, WorkerEnrollmentResource, WorkerEnrollmentSpec, WorkerSessionResource } from './workerIdentity.js';
import {
  bindWorkerSession,
  isWorkerSessionValid,
  WORKER_ENROLLMENT_API_VERSION,
  WORKER_ENROLLMENT_KIND,
  WORKER_SESSION_API_VERSION,
  WORKER_SESSION_KIND,
} from './workerIdentity.js';

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
  /**
   * Hash of a freshly generated, one-time bootstrap credential.  A promotion
   * must never copy the revoked enrollment's hash.  The raw token remains in
   * the trusted caller and is only needed when `binding` is supplied.
   */
  newBootstrapTokenHash: string;
  /**
   * Optional explicit replacement scope.  Omitted fields are copied from the
   * source enrollment, but the resulting enrollment is always materialized
   * with the complete scope rather than a partial manifest.
   */
  scope?: Partial<
    Pick<
      WorkerEnrollmentSpec,
      | 'expectedGateway'
      | 'gatewayKeyFingerprint'
      | 'audience'
      | 'allowedProtocol'
      | 'run'
      | 'policyDigest'
      | 'allowedMethods'
      | 'allowedTargets'
    >
  >;
  /**
   * If provided, bind the replacement enrollment through the real
   * proof-of-possession path after creation.  Promotion never marks an
   * enrollment Bound by writing status directly.
   */
  binding?: Omit<BindWorkerSessionRequest, 'ttlMs'> & { ttlMs?: number };
}

function isCanonicalWorkerEnrollment(value: unknown): value is WorkerEnrollmentResource {
  return isCanonicalOrchestrationResource(value) &&
    value.apiVersion === WORKER_ENROLLMENT_API_VERSION &&
    value.kind === WORKER_ENROLLMENT_KIND;
}

function isCanonicalWorkerSession(value: unknown): value is WorkerSessionResource {
  return isCanonicalOrchestrationResource(value) &&
    value.apiVersion === WORKER_SESSION_API_VERSION &&
    value.kind === WORKER_SESSION_KIND;
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
  const enrollment = requireCanonicalOrchestrationResourceOrNull(
    await store.get<WorkerEnrollmentSpec, WorkerEnrollmentResource['status']>({
      apiVersion: WORKER_ENROLLMENT_API_VERSION,
      kind: WORKER_ENROLLMENT_KIND,
      name: enrollmentName,
    }),
    isCanonicalWorkerEnrollment,
    'WorkerEnrollment get',
  );

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
  const sessions = await store.list<WorkerSessionResource['spec'], WorkerSessionResource['status']>({
    apiVersion: WORKER_SESSION_API_VERSION,
    kind: WORKER_SESSION_KIND,
  });
  const currentTime = now();
  const activeSessions = sessions.items.map((session) => requireCanonicalOrchestrationResource(session, isCanonicalWorkerSession, 'WorkerSession list')).filter(
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
  const source = requireCanonicalOrchestrationResourceOrNull(
    await store.get<WorkerEnrollmentSpec, WorkerEnrollmentResource['status']>({
      apiVersion: WORKER_ENROLLMENT_API_VERSION,
      kind: WORKER_ENROLLMENT_KIND,
      name: request.sourceEnrollmentName,
    }),
    isCanonicalWorkerEnrollment,
    'WorkerEnrollment get',
  );

  if (!source) {
    throw new Error(`WorkerEnrollment ${request.sourceEnrollmentName} not found`);
  }

  if (source.spec.trustClass !== 'quarantine') {
    throw new Error(
      `Only quarantine identities can be promoted; ${request.sourceEnrollmentName} has trust class ${source.spec.trustClass}`,
    );
  }
  if (
    typeof request.verificationEvidence !== 'string' ||
    !request.verificationEvidence.trim() ||
    typeof request.verifiedBy !== 'string' ||
    !request.verifiedBy.trim() ||
    typeof request.approvedBy !== 'string' ||
    !request.approvedBy.trim()
  ) {
    throw new Error('Identity promotion requires verification evidence and approving actors');
  }
  if (
    typeof request.newBootstrapTokenHash !== 'string' ||
    !request.newBootstrapTokenHash.trim()
  ) {
    throw new Error('Identity promotion requires a new one-time bootstrap credential');
  }
  if (source.status?.phase === 'Revoked' || source.status?.phase === 'Expired') {
    throw new Error(`WorkerEnrollment '${request.sourceEnrollmentName}' is already permanently inactive`);
  }

  if (request.newBootstrapTokenHash === source.spec.bootstrapTokenHash) {
    throw new Error('Identity promotion cannot reuse the revoked bootstrap credential');
  }

  // Reject a second active enrollment for the same node.  This makes the
  // source/replacement identity transition mutually exclusive even when a
  // caller retries promotion with a different replacement name.
  const enrollments = await store.list<WorkerEnrollmentSpec, WorkerEnrollmentResource['status']>({
    apiVersion: WORKER_ENROLLMENT_API_VERSION,
    kind: WORKER_ENROLLMENT_KIND,
  });
  const conflicting = enrollments.items.map((enrollment) => requireCanonicalOrchestrationResource(enrollment, isCanonicalWorkerEnrollment, 'WorkerEnrollment list')).find(
    (candidate) =>
      candidate.metadata.name !== source.metadata.name &&
      candidate.spec.nodeRef.apiVersion === source.spec.nodeRef.apiVersion &&
      candidate.spec.nodeRef.kind === source.spec.nodeRef.kind &&
      candidate.spec.nodeRef.name === source.spec.nodeRef.name &&
      candidate.status?.phase !== 'Revoked' &&
      candidate.status?.phase !== 'Expired',
  );
  if (conflicting) {
    throw new Error(
      `WorkerEnrollment '${source.metadata.name}' cannot be promoted while '${conflicting.metadata.name}' is active`,
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
  const scope = {
    expectedGateway: request.scope?.expectedGateway ?? source.spec.expectedGateway,
    gatewayKeyFingerprint: request.scope?.gatewayKeyFingerprint ?? source.spec.gatewayKeyFingerprint,
    audience: request.scope?.audience ?? source.spec.audience,
    allowedProtocol: request.scope?.allowedProtocol ?? source.spec.allowedProtocol,
    run: request.scope?.run ?? source.spec.run,
    policyDigest: request.scope?.policyDigest ?? source.spec.policyDigest,
    allowedMethods: request.scope?.allowedMethods ?? source.spec.allowedMethods,
    ...(request.scope?.allowedTargets !== undefined
      ? { allowedTargets: request.scope.allowedTargets }
      : source.spec.allowedTargets !== undefined
      ? { allowedTargets: source.spec.allowedTargets }
      : {}),
  } satisfies Pick<
    WorkerEnrollmentSpec,
    | 'expectedGateway'
    | 'gatewayKeyFingerprint'
    | 'audience'
    | 'allowedProtocol'
    | 'run'
    | 'policyDigest'
    | 'allowedMethods'
    | 'allowedTargets'
  >;
  if (
    !scope.expectedGateway.trim() ||
    !scope.gatewayKeyFingerprint.trim() ||
    !scope.audience.trim() ||
    !scope.allowedProtocol.trim() ||
    !scope.policyDigest.trim() ||
    !scope.run.uid.trim() ||
    !Number.isSafeInteger(scope.run.attempt) ||
    scope.run.attempt < 1 ||
    !Number.isSafeInteger(scope.run.epoch) ||
    scope.run.epoch < 1 ||
    scope.allowedMethods.length === 0 ||
    scope.allowedMethods.some((method) => !method.trim()) ||
    scope.allowedTargets?.some((target) => !target.trim())
  ) {
    throw new Error('Identity promotion replacement scope is incomplete or invalid');
  }
  const manifest = {
    apiVersion: WORKER_ENROLLMENT_API_VERSION,
    kind: WORKER_ENROLLMENT_KIND,
    metadata: { name: newEnrollmentName },
    spec: {
      nodeRef: source.spec.nodeRef,
      trustClass: request.targetTrustClass,
      ...scope,
      bootstrapTokenHash: request.newBootstrapTokenHash,
      enrolledBy: request.approvedBy,
      expiresAt: new Date(now().getTime() + 24 * 60 * 60 * 1000).toISOString(),
      promotion: {
        sourceEnrollmentName: source.metadata.name,
        verificationEvidence: request.verificationEvidence,
        verifiedBy: request.verifiedBy,
        approvedBy: request.approvedBy,
      },
    },
  };

  const resource = requireCanonicalOrchestrationResource(
    await store.create<WorkerEnrollmentSpec, WorkerEnrollmentResource['status']>(actor, manifest),
    isCanonicalWorkerEnrollment,
    'WorkerEnrollment create',
  );
  if (!request.binding) return resource;

  // A promotion can optionally complete the proof-of-possession exchange, but
  // it must use the real binder.  In particular, do not set Bound status on
  // the newly created resource before a worker has proved possession.
  const binding: BindWorkerSessionRequest = {
    ...request.binding,
    ttlMs: request.binding.ttlMs ?? 15 * 60 * 1000,
  };
  await bindWorkerSession(store, actor, newEnrollmentName, binding, now);
  const bound = requireCanonicalOrchestrationResourceOrNull(
    await store.get<WorkerEnrollmentSpec, WorkerEnrollmentResource['status']>({
      apiVersion: WORKER_ENROLLMENT_API_VERSION,
      kind: WORKER_ENROLLMENT_KIND,
      name: newEnrollmentName,
    }),
    isCanonicalWorkerEnrollment,
    'WorkerEnrollment get',
  );
  return bound ?? resource;
}

/**
 * Check whether an identity is permanently revoked.
 */
export async function isIdentityRevoked(
  store: ControlStore,
  enrollmentName: string,
): Promise<boolean> {
  const enrollment = requireCanonicalOrchestrationResourceOrNull(
    await store.get<WorkerEnrollmentSpec, WorkerEnrollmentResource['status']>({
      apiVersion: WORKER_ENROLLMENT_API_VERSION,
      kind: WORKER_ENROLLMENT_KIND,
      name: enrollmentName,
    }),
    isCanonicalWorkerEnrollment,
    'WorkerEnrollment get',
  );

  return enrollment?.status?.phase === 'Revoked';
}
