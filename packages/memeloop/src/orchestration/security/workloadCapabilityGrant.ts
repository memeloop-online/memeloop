import type { OrchestrationResource, OrchestrationResourceStatus } from '../client.js';
import type { ControlStore, ControlStoreActor } from '../controlStore.js';
import { OrchestrationError } from '../errors.js';
import type { WorkerGatewaySession, WorkerProtocolMethod, WorkerRunBinding } from './workerProtocol.js';

export const WORKLOAD_CAPABILITY_GRANT_API_VERSION = 'security.memeloop.io/v1alpha1';
export const WORKLOAD_CAPABILITY_GRANT_KIND = 'WorkloadCapabilityGrant';

export interface WorkloadCapabilityBudget {
  maxRequests: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxTokens?: number;
  maxCost?: number;
}

export interface WorkloadCapabilityGrantSpec {
  /** Stable identity included in the signed claims; must equal metadata.name. */
  grantId: string;
  sessionRef: {
    apiVersion: string;
    kind: 'WorkerSession';
    name: string;
  };
  run: WorkerRunBinding;
  workerKeyFingerprint: string;
  /** Pinned gateway/channel identity, never a worker-provided label. */
  channelBinding: string;
  audience: string;
  protocol: string;
  protocolMethod: WorkerProtocolMethod;
  capability: string;
  target: string;
  policyDigest: string;
  budget: WorkloadCapabilityBudget;
  issuedAt: string;
  expiresAt: string;
  issuedBy: string;
  /** Gateway signature over canonicalWorkloadCapabilityGrantBytes(spec). */
  signature: string;
}

export interface WorkloadCapabilityGrantStatus extends OrchestrationResourceStatus {
  phase?: 'Authorized' | 'Consumed' | 'Revoked' | 'Expired' | 'Failed';
  consumedAt?: string;
  revokedAt?: string;
  reason?: string;
}

export type WorkloadCapabilityGrantResource =
  & Omit<
    OrchestrationResource<WorkloadCapabilityGrantSpec>,
    'status'
  >
  & {
    status?: WorkloadCapabilityGrantStatus;
  };

export interface IssueWorkloadCapabilityGrantRequest {
  grantId: string;
  session: WorkerGatewaySession;
  channelBinding: string;
  protocolMethod: WorkerProtocolMethod;
  capability: string;
  target: string;
  budget: WorkloadCapabilityBudget;
  ttlMs: number;
}

export interface WorkloadCapabilityGrantRequirements {
  grantId: string;
  sessionName: string;
  run: WorkerRunBinding;
  workerKeyFingerprint: string;
  channelBinding: string;
  audience: string;
  protocol: string;
  protocolMethod: WorkerProtocolMethod;
  capability: string;
  target: string;
  policyDigest: string;
}

const encoder = new TextEncoder();

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
        .join(',')
    }}`;
  }
  throw new Error('capability grant values must be JSON-compatible');
}

export function canonicalWorkloadCapabilityGrantBytes(
  spec: WorkloadCapabilityGrantSpec | Omit<WorkloadCapabilityGrantSpec, 'signature'>,
): Uint8Array {
  const { signature: _signature, ...claims } = spec as WorkloadCapabilityGrantSpec;
  return encoder.encode(canonicalize(claims));
}

export function createWorkloadCapabilityGrantManifest(
  name: string,
  spec: WorkloadCapabilityGrantSpec,
): {
  apiVersion: typeof WORKLOAD_CAPABILITY_GRANT_API_VERSION;
  kind: typeof WORKLOAD_CAPABILITY_GRANT_KIND;
  metadata: { name: string };
  spec: WorkloadCapabilityGrantSpec;
} {
  return {
    apiVersion: WORKLOAD_CAPABILITY_GRANT_API_VERSION,
    kind: WORKLOAD_CAPABILITY_GRANT_KIND,
    metadata: { name },
    spec,
  };
}

export function isWorkloadCapabilityGrant(
  resource: { apiVersion?: string; kind?: string },
): resource is WorkloadCapabilityGrantResource {
  return resource.apiVersion === WORKLOAD_CAPABILITY_GRANT_API_VERSION &&
    resource.kind === WORKLOAD_CAPABILITY_GRANT_KIND;
}

function assertBudget(budget: WorkloadCapabilityBudget): void {
  if (!Number.isSafeInteger(budget.maxRequests) || budget.maxRequests < 1) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: 'capability grant maxRequests must be a positive integer',
      retryable: false,
    });
  }
  for (const [name, value] of Object.entries(budget)) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: `capability grant budget '${name}' must be finite and non-negative`,
        retryable: false,
      });
    }
  }
}

/** Issue and durably record one host-authorized capability grant. */
export async function issueWorkloadCapabilityGrant(
  store: ControlStore,
  actor: ControlStoreActor,
  request: IssueWorkloadCapabilityGrantRequest,
  sign: (message: Uint8Array) => Promise<string> | string,
  now: () => Date = () => new Date(),
): Promise<WorkloadCapabilityGrantResource> {
  if (actor.kind !== 'controller' && actor.kind !== 'admin') {
    throw new OrchestrationError({
      code: 'FORBIDDEN',
      message: 'workload capability grants require a trusted controller or admin',
      retryable: false,
    });
  }
  const issuedAt = now();
  const sessionExpiry = new Date(request.session.expiresAt);
  if (
    request.session.revoked ||
    !Number.isFinite(sessionExpiry.getTime()) ||
    sessionExpiry <= issuedAt ||
    !request.grantId ||
    !request.channelBinding ||
    !request.capability ||
    !request.target ||
    !Number.isFinite(request.ttlMs) ||
    request.ttlMs <= 0
  ) {
    throw new OrchestrationError({
      code: 'FORBIDDEN',
      message: 'capability grant request or worker session is not usable',
      retryable: false,
    });
  }
  if (
    !request.session.allowedMethods.includes(request.protocolMethod) ||
    (request.session.allowedTargets &&
      !request.session.allowedTargets.includes(request.target))
  ) {
    throw new OrchestrationError({
      code: 'FORBIDDEN',
      message: 'capability grant exceeds the worker session scope',
      retryable: false,
    });
  }
  assertBudget(request.budget);
  const expiresAt = new Date(
    Math.min(sessionExpiry.getTime(), issuedAt.getTime() + request.ttlMs),
  ).toISOString();
  const unsigned: Omit<WorkloadCapabilityGrantSpec, 'signature'> = {
    grantId: request.grantId,
    sessionRef: {
      apiVersion: 'security.memeloop.io/v1alpha1',
      kind: 'WorkerSession',
      name: request.session.name,
    },
    run: request.session.run,
    workerKeyFingerprint: request.session.workerKeyFingerprint,
    channelBinding: request.channelBinding,
    audience: request.session.audience,
    protocol: request.session.protocol,
    protocolMethod: request.protocolMethod,
    capability: request.capability,
    target: request.target,
    policyDigest: request.session.policyDigest,
    budget: request.budget,
    issuedAt: issuedAt.toISOString(),
    expiresAt,
    issuedBy: actor.id,
  };
  const signature = await sign(canonicalWorkloadCapabilityGrantBytes(unsigned));
  if (!signature) {
    throw new OrchestrationError({
      code: 'INTERNAL',
      message: 'capability grant signer returned no signature',
      retryable: false,
    });
  }
  const created = await store.create(
    actor,
    createWorkloadCapabilityGrantManifest(request.grantId, {
      ...unsigned,
      signature,
    }),
  ) as WorkloadCapabilityGrantResource;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments -- required for the grant-specific status shape
  const active = await store.updateStatus<WorkloadCapabilityGrantSpec, WorkloadCapabilityGrantStatus>(
    actor,
    {
      apiVersion: WORKLOAD_CAPABILITY_GRANT_API_VERSION,
      kind: WORKLOAD_CAPABILITY_GRANT_KIND,
      name: request.grantId,
    },
    { phase: 'Authorized' },
    { resourceVersion: created.metadata.resourceVersion },
  );
  return active as WorkloadCapabilityGrantResource;
}

/** Verify signature, expiry, lifecycle, and every authority-bearing claim. */
export async function verifyWorkloadCapabilityGrant(
  grant: WorkloadCapabilityGrantResource,
  requirements: WorkloadCapabilityGrantRequirements,
  verify: (message: Uint8Array, signature: string) => Promise<boolean> | boolean,
  now: () => Date = () => new Date(),
): Promise<void> {
  const spec = grant.spec;
  const issuedAt = new Date(spec.issuedAt).getTime();
  const expiresAt = new Date(spec.expiresAt).getTime();
  const currentTime = now().getTime();
  const exact = grant.metadata.name === requirements.grantId &&
    spec.grantId === requirements.grantId &&
    spec.sessionRef.name === requirements.sessionName &&
    spec.run.uid === requirements.run.uid &&
    spec.run.attempt === requirements.run.attempt &&
    spec.run.epoch === requirements.run.epoch &&
    spec.workerKeyFingerprint === requirements.workerKeyFingerprint &&
    spec.channelBinding === requirements.channelBinding &&
    spec.audience === requirements.audience &&
    spec.protocol === requirements.protocol &&
    spec.protocolMethod === requirements.protocolMethod &&
    spec.capability === requirements.capability &&
    spec.target === requirements.target &&
    spec.policyDigest === requirements.policyDigest;
  if (
    !exact ||
    grant.status?.phase !== 'Authorized' ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > currentTime ||
    expiresAt <= currentTime ||
    expiresAt <= issuedAt ||
    !await verify(canonicalWorkloadCapabilityGrantBytes(spec), spec.signature)
  ) {
    throw new OrchestrationError({
      code: 'FORBIDDEN',
      message: 'workload capability grant verification failed',
      retryable: false,
    });
  }
  assertBudget(spec.budget);
}

/** Atomically consume a single-use grant before invoking the capability. */
export async function consumeWorkloadCapabilityGrant(
  store: ControlStore,
  actor: ControlStoreActor,
  grant: WorkloadCapabilityGrantResource,
  now: () => Date = () => new Date(),
): Promise<WorkloadCapabilityGrantResource> {
  if (grant.status?.phase !== 'Authorized' || grant.spec.budget.maxRequests !== 1) {
    throw new OrchestrationError({
      code: 'CONFLICT',
      message: 'workload capability grant is not a fresh single-use authorization',
      retryable: false,
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments -- required for the grant-specific status shape
  return await store.updateStatus<WorkloadCapabilityGrantSpec, WorkloadCapabilityGrantStatus>(
    actor,
    {
      apiVersion: WORKLOAD_CAPABILITY_GRANT_API_VERSION,
      kind: WORKLOAD_CAPABILITY_GRANT_KIND,
      name: grant.metadata.name,
    },
    { ...grant.status, phase: 'Consumed', consumedAt: now().toISOString() },
    { resourceVersion: grant.metadata.resourceVersion },
  ) as WorkloadCapabilityGrantResource;
}
