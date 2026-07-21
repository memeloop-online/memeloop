import type { OrchestrationResource, OrchestrationResourceStatus } from '../client.js';
import type { ControlStore, ControlStoreActor } from '../controlStore.js';
import type { NodeTrustClass } from '../resources.js';

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
}

export type WorkerEnrollmentResource = OrchestrationResource<WorkerEnrollmentSpec>;

export type WorkerSessionResource = OrchestrationResource<WorkerSessionSpec>;

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

export function isWorkerEnrollment(resource: OrchestrationResource<any, any>): resource is WorkerEnrollmentResource {
  return resource.kind === WORKER_ENROLLMENT_KIND;
}

export function isWorkerSession(resource: OrchestrationResource<any, any>): resource is WorkerSessionResource {
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
  workerKeyFingerprint: string,
  ttlMs: number,
  now: () => Date = () => new Date(),
): Promise<WorkerSessionResource> {
  // In a full implementation, this would verify the bootstrap token and
  // create a session. For now, we create the session directly.
  const sessionName = `session-${enrollmentName}-${Date.now()}`;
  const manifest = createWorkerSessionManifest(sessionName, {
    enrollmentRef: {
      apiVersion: WORKER_ENROLLMENT_API_VERSION,
      kind: WORKER_ENROLLMENT_KIND,
      name: enrollmentName,
    },
    workerKeyFingerprint,
    ttlMs,
  });
  const resource = await store.create(actor, manifest);
  const session = resource as WorkerSessionResource;

  // Update session status to Active.
  const expiresAt = new Date(now().getTime() + ttlMs).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments -- required for correct status type inference
  await store.updateStatus<WorkerSessionSpec, WorkerSessionStatus>(
    actor,
    { apiVersion: WORKER_SESSION_API_VERSION, kind: WORKER_SESSION_KIND, name: sessionName },
    {
      phase: 'Active',
      issuedAt: now().toISOString(),
      expiresAt,
    },
    { resourceVersion: session.metadata.resourceVersion },
  );

  return {
    ...session,
    status: {
      phase: 'Active',
      issuedAt: now().toISOString(),
      expiresAt,
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
  const status = session.status as WorkerSessionStatus | undefined;
  if (status?.phase !== 'Active') return false;
  const expiresAt = status.expiresAt;
  if (!expiresAt) return false;
  return new Date(expiresAt) > now;
}
