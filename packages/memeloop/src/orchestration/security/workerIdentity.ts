import type { OrchestrationResource, OrchestrationResourceStatus } from '../client.js';
import type { ControlStore, ControlStoreActor } from '../controlStore.js';
import { OrchestrationError } from '../errors.js';
import type { NodeTrustClass } from '../resources.js';
import type { WorkerProtocolMethod, WorkerRunBinding } from './workerProtocol.js';

export const WORKER_ENROLLMENT_API_VERSION = 'security.memeloop.io/v1alpha1';
export const WORKER_ENROLLMENT_KIND = 'WorkerEnrollment';

export const WORKER_SESSION_API_VERSION = 'security.memeloop.io/v1alpha1';
export const WORKER_SESSION_KIND = 'WorkerSession';

/**
 * WorkerEnrollment: one-time bootstrap record for a worker identity.
 * Created by a trusted controller or admin; never by the worker itself.
 */
export interface WorkerEnrollmentSpec {
  /** Node this worker is enrolled on. */
  nodeRef: {
    apiVersion: string;
    kind: string;
    name: string;
    namespace?: string;
  };
  /** Trust class assigned at enrollment time; immutable after creation. */
  trustClass: NodeTrustClass;
  /** Pinned gateway URL and public-key fingerprint known before bootstrap. */
  expectedGateway: string;
  gatewayKeyFingerprint: string;
  /** Narrow protocol/session scope fixed by the trusted enrolling actor. */
  audience: string;
  allowedProtocol: string;
  run: WorkerRunBinding;
  policyDigest: string;
  allowedMethods: WorkerProtocolMethod[];
  allowedTargets?: string[];
  /** One-time bootstrap token hash; the raw token is only shown once. */
  bootstrapTokenHash: string;
  /** Enrolling actor (controller or admin). */
  enrolledBy: string;
  /** Expiry of the enrollment record itself. */
  expiresAt: string;
}

export interface WorkerEnrollmentStatus extends OrchestrationResourceStatus {
  phase?: 'Pending' | 'Bound' | 'Expired' | 'Revoked';
  /** Fingerprint of the worker's ephemeral public key, set after binding. */
  workerKeyFingerprint?: string;
  boundAt?: string;
  revokedAt?: string;
  revokeReason?: string;
}

/**
 * WorkerSession: ephemeral identity session bound to a worker key.
 * Created after a worker proves possession of the bootstrap token.
 */
export interface WorkerSessionSpec {
  enrollmentRef: {
    apiVersion: string;
    kind: string;
    name: string;
    namespace?: string;
  };
  /** Fingerprint of the worker's ephemeral public key. */
  workerKeyFingerprint: string;
  /** Encoded ephemeral public key used for per-message signature checks. */
  workerPublicKey: string;
  audience: string;
  allowedProtocol: string;
  run: WorkerRunBinding;
  policyDigest: string;
  allowedMethods: WorkerProtocolMethod[];
  allowedTargets?: string[];
  /** Session TTL in milliseconds. */
  ttlMs: number;
}

export interface WorkerSessionStatus extends OrchestrationResourceStatus {
  phase?: 'Active' | 'Expired' | 'Revoked';
  issuedAt?: string;
  expiresAt?: string;
  lastProofAt?: string;
  revokedAt?: string;
  revokeReason?: string;
  /** Durable replay fence for the dedicated worker protocol. */
  lastSequence?: number;
  /** Bounded recent nonce window; sequence remains the primary fence. */
  recentNonces?: string[];
}

export type WorkerEnrollmentResource = Omit<OrchestrationResource<WorkerEnrollmentSpec>, 'status'> & {
  status?: WorkerEnrollmentStatus;
};

export type WorkerSessionResource = Omit<OrchestrationResource<WorkerSessionSpec>, 'status'> & {
  status?: WorkerSessionStatus;
};

export interface BindWorkerSessionRequest {
  /** Raw, single-use bootstrap token. It must never be persisted or logged. */
  bootstrapToken: string;
  /** Fingerprint of the ephemeral public key proved by the worker. */
  workerKeyFingerprint: string;
  /** Encoded ephemeral public key; public, but never worker-selected authority. */
  workerPublicKey: string;
  /** Pinned gateway identity serving this bootstrap request. */
  gatewayKeyFingerprint: string;
  /** Gateway-issued one-time challenge and the worker's signature over it. */
  proof: { challenge: string; signature: string };
  /** Requested session lifetime. It is capped by the enrollment expiry. */
  ttlMs: number;
  /**
   * Host cryptographic verifier. Core deliberately does not prescribe a
   * password-hash implementation; the verifier compares the raw token with
   * the enrollment's persisted hash in constant-time.
   */
  verifyBootstrapToken: (token: string, expectedHash: string) => Promise<boolean> | boolean;
  /** Verify key fingerprint and proof-of-possession, consuming the challenge. */
  verifyWorkerProof: (request: {
    enrollmentName: string;
    workerKeyFingerprint: string;
    workerPublicKey: string;
    challenge: string;
    signature: string;
  }) => Promise<boolean> | boolean;
}

export function createWorkerEnrollmentManifest(
  name: string,
  spec: WorkerEnrollmentSpec,
): { apiVersion: string; kind: string; metadata: { name: string }; spec: WorkerEnrollmentSpec } {
  return {
    apiVersion: WORKER_ENROLLMENT_API_VERSION,
    kind: WORKER_ENROLLMENT_KIND,
    metadata: { name },
    spec,
  };
}

export function createWorkerSessionManifest(
  name: string,
  spec: WorkerSessionSpec,
): { apiVersion: string; kind: string; metadata: { name: string }; spec: WorkerSessionSpec } {
  return {
    apiVersion: WORKER_SESSION_API_VERSION,
    kind: WORKER_SESSION_KIND,
    metadata: { name },
    spec,
  };
}

export function isWorkerEnrollment(resource: OrchestrationResource<unknown, unknown>): resource is WorkerEnrollmentResource {
  return resource.kind === WORKER_ENROLLMENT_KIND;
}

export function isWorkerSession(resource: OrchestrationResource<unknown, unknown>): resource is WorkerSessionResource {
  return resource.kind === WORKER_SESSION_KIND;
}

/**
 * Enroll a new worker: create a WorkerEnrollment with a one-time bootstrap token.
 * Only callable by trusted controller or admin actors.
 */
export async function enrollWorker(
  store: ControlStore,
  actor: ControlStoreActor,
  name: string,
  spec: WorkerEnrollmentSpec,
): Promise<WorkerEnrollmentResource> {
  if (actor.kind !== 'controller' && actor.kind !== 'admin') {
    throw new Error('Worker enrollment requires controller or admin actor');
  }
  const manifest = createWorkerEnrollmentManifest(name, spec);
  const resource = await store.create(actor, manifest);
  return resource as WorkerEnrollmentResource;
}

/**
 * Bind a worker to its enrollment: the worker proves possession of the
 * bootstrap token and receives a WorkerSession with an ephemeral identity.
 */
export async function bindWorkerSession(
  store: ControlStore,
  actor: ControlStoreActor,
  enrollmentName: string,
  request: BindWorkerSessionRequest,
  now: () => Date = () => new Date(),
): Promise<WorkerSessionResource> {
  if (actor.kind !== 'controller' && actor.kind !== 'admin') {
    throw new OrchestrationError({
      code: 'FORBIDDEN',
      message: 'Worker session binding requires controller or admin actor',
      retryable: false,
    });
  }
  if (
    !request.bootstrapToken ||
    !request.workerKeyFingerprint ||
    !request.workerPublicKey ||
    !request.gatewayKeyFingerprint ||
    !request.proof.challenge ||
    !request.proof.signature ||
    !Number.isFinite(request.ttlMs) ||
    request.ttlMs <= 0
  ) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: 'Worker session binding requires a bootstrap token, worker key fingerprint, and positive TTL',
      retryable: false,
    });
  }

  const enrollmentResource = await store.get<WorkerEnrollmentSpec>({
    apiVersion: WORKER_ENROLLMENT_API_VERSION,
    kind: WORKER_ENROLLMENT_KIND,
    name: enrollmentName,
  });
  const enrollment = enrollmentResource as WorkerEnrollmentResource | null;
  if (!enrollment) {
    throw new OrchestrationError({
      code: 'NOT_FOUND',
      message: `WorkerEnrollment '${enrollmentName}' not found`,
      retryable: false,
    });
  }
  const currentTime = now();
  const enrollmentExpiry = new Date(enrollment.spec.expiresAt);
  if (!Number.isFinite(enrollmentExpiry.getTime()) || enrollmentExpiry <= currentTime) {
    throw new OrchestrationError({
      code: 'TIMEOUT',
      message: `WorkerEnrollment '${enrollmentName}' has expired`,
      retryable: false,
    });
  }
  if (enrollment.status?.phase === 'Revoked' || enrollment.status?.phase === 'Expired') {
    throw new OrchestrationError({
      code: 'FORBIDDEN',
      message: `WorkerEnrollment '${enrollmentName}' is not active`,
      retryable: false,
    });
  }
  if (enrollment.spec.gatewayKeyFingerprint !== request.gatewayKeyFingerprint) {
    throw new OrchestrationError({
      code: 'FORBIDDEN',
      message: 'Worker enrollment gateway key does not match the serving gateway',
      retryable: false,
    });
  }
  if (
    enrollment.status?.phase === 'Bound' &&
    enrollment.status.workerKeyFingerprint !== request.workerKeyFingerprint
  ) {
    throw new OrchestrationError({
      code: 'FORBIDDEN',
      message: `WorkerEnrollment '${enrollmentName}' has already been consumed`,
      retryable: false,
    });
  }
  if (!await request.verifyBootstrapToken(request.bootstrapToken, enrollment.spec.bootstrapTokenHash)) {
    throw new OrchestrationError({
      code: 'FORBIDDEN',
      message: 'Worker bootstrap token is invalid',
      retryable: false,
    });
  }
  if (
    !await request.verifyWorkerProof({
      enrollmentName,
      workerKeyFingerprint: request.workerKeyFingerprint,
      workerPublicKey: request.workerPublicKey,
      challenge: request.proof.challenge,
      signature: request.proof.signature,
    })
  ) {
    throw new OrchestrationError({
      code: 'FORBIDDEN',
      message: 'Worker bootstrap proof-of-possession is invalid',
      retryable: false,
    });
  }

  if (enrollment.status?.phase !== 'Bound') {
    const boundStatus: WorkerEnrollmentStatus = {
      phase: 'Bound',
      workerKeyFingerprint: request.workerKeyFingerprint,
      boundAt: currentTime.toISOString(),
    };
    await store.updateStatus(
      actor,
      {
        apiVersion: WORKER_ENROLLMENT_API_VERSION,
        kind: WORKER_ENROLLMENT_KIND,
        name: enrollmentName,
      },
      boundStatus,
      { resourceVersion: enrollment.metadata.resourceVersion },
    );
  }

  // Stable identity makes a controller crash after the enrollment fence
  // recoverable without creating a second session.
  const sessionName = `session-${enrollment.metadata.uid}`;
  const existingSessionResource = await store.get<WorkerSessionSpec>({
    apiVersion: WORKER_SESSION_API_VERSION,
    kind: WORKER_SESSION_KIND,
    name: sessionName,
  });
  const existingSession = existingSessionResource as WorkerSessionResource | null;
  if (existingSession) {
    if (existingSession.spec.workerKeyFingerprint !== request.workerKeyFingerprint) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `WorkerEnrollment '${enrollmentName}' session identity does not match`,
        retryable: false,
      });
    }
    return existingSession;
  }

  const ttlMs = Math.min(request.ttlMs, enrollmentExpiry.getTime() - currentTime.getTime());
  const manifest = createWorkerSessionManifest(sessionName, {
    enrollmentRef: {
      apiVersion: WORKER_ENROLLMENT_API_VERSION,
      kind: WORKER_ENROLLMENT_KIND,
      name: enrollmentName,
    },
    workerKeyFingerprint: request.workerKeyFingerprint,
    workerPublicKey: request.workerPublicKey,
    audience: enrollment.spec.audience,
    allowedProtocol: enrollment.spec.allowedProtocol,
    run: enrollment.spec.run,
    policyDigest: enrollment.spec.policyDigest,
    allowedMethods: enrollment.spec.allowedMethods,
    ...(enrollment.spec.allowedTargets ? { allowedTargets: enrollment.spec.allowedTargets } : {}),
    ttlMs,
  });
  const resource = await store.create(actor, manifest);
  const session = resource as WorkerSessionResource;

  // Update session status to Active.
  const issuedAt = currentTime.toISOString();
  const expiresAt = new Date(currentTime.getTime() + ttlMs).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments -- required for correct status type inference
  await store.updateStatus<WorkerSessionSpec, WorkerSessionStatus>(
    actor,
    { apiVersion: WORKER_SESSION_API_VERSION, kind: WORKER_SESSION_KIND, name: sessionName },
    {
      phase: 'Active',
      issuedAt,
      expiresAt,
      lastProofAt: issuedAt,
    },
    { resourceVersion: session.metadata.resourceVersion },
  );

  return {
    ...session,
    status: {
      phase: 'Active',
      issuedAt,
      expiresAt,
      lastProofAt: issuedAt,
    } as WorkerSessionStatus,
  };
}

/**
 * Revoke a worker session, preventing further use of the ephemeral identity.
 */
export async function revokeWorkerSession(
  store: ControlStore,
  actor: ControlStoreActor,
  sessionName: string,
  reason: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  const session = await store.get<WorkerSessionSpec>({
    apiVersion: WORKER_SESSION_API_VERSION,
    kind: WORKER_SESSION_KIND,
    name: sessionName,
  });
  if (!session) {
    throw new Error(`WorkerSession ${sessionName} not found`);
  }
  await store.updateStatus(
    actor,
    { apiVersion: WORKER_SESSION_API_VERSION, kind: WORKER_SESSION_KIND, name: sessionName },
    {
      phase: 'Revoked',
      revokedAt: now().toISOString(),
      revokeReason: reason,
    },
    { resourceVersion: session.metadata.resourceVersion },
  );
}

/**
 * Check whether a worker session is currently valid (active and not expired).
 */
export function isWorkerSessionValid(session: WorkerSessionResource, now: Date = new Date()): boolean {
  const status = session.status;
  if (status?.phase !== 'Active') return false;
  const expiresAt = status.expiresAt;
  if (!expiresAt) return false;
  return new Date(expiresAt) > now;
}
