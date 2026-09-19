import type { ControlStore, ControlStoreActor } from '../controlStore.js';
import { OrchestrationError } from '../errors.js';
import {
  bindWorkerSession as bindNarrowWorkerSession,
  type BindWorkerSessionRequest,
  revokeWorkerSession,
  WORKER_ENROLLMENT_API_VERSION,
  WORKER_ENROLLMENT_KIND,
  WORKER_SESSION_API_VERSION,
  WORKER_SESSION_KIND,
  type WorkerEnrollmentResource,
  type WorkerSessionResource,
  type WorkerSessionSpec,
} from '../security/workerIdentity.js';

import { assertDriverRequestEnvelope, canonicalDriverValue, type DriverRequestEnvelope } from './driverRequest.js';
import type {
  AttestedIdentity,
  IdentityAttestationManagementDriver,
  IdentityChallenge,
  IdentityEnrollment,
  IdentityInspection,
  IdentitySession,
} from './identityAttestationManagement.js';

const WORKER_ATTESTATION_FORMAT = 'worker-ed25519-bootstrap/v1';

export interface ManagedWorkerIdentityRequestFactoryInput<T> {
  method: string;
  payload: T;
  enrollment: WorkerEnrollmentResource;
  actor: ControlStoreActor;
  idempotencyKey: string;
  payloadFields: string[];
}

export interface ManagedWorkerIdentityAdapterOptions {
  store: ControlStore;
  actor: ControlStoreActor;
  authorizeRequest(request: DriverRequestEnvelope): boolean | Promise<boolean>;
  createRequest<T>(
    input: ManagedWorkerIdentityRequestFactoryInput<T>,
  ): DriverRequestEnvelope<T>;
  maxChallengeTtlMs?: number;
  maxSessionTtlMs?: number;
  now?: () => Date;
  name: string;
  threatAssumptions: string[];
}

export interface ManagedWorkerIdentityRoute {
  driver: IdentityAttestationManagementDriver;
  bindWorkerSession(
    enrollmentName: string,
    request: BindWorkerSessionRequest,
  ): Promise<WorkerSessionResource>;
}

interface PendingBinding {
  enrollment: WorkerEnrollmentResource;
  request: BindWorkerSessionRequest;
  channelBinding: string;
  proofDigest: string;
  evidenceDigest: string;
}

function invalid(message: string): never {
  throw new OrchestrationError({ code: 'INVALID', message, retryable: false });
}

function unsupported(message: string): never {
  throw new OrchestrationError({
    code: 'UNSUPPORTED',
    message,
    retryable: false,
  });
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalDriverValue(value));
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${
    [...new Uint8Array(result)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  }`;
}

function exactFields(
  payload: unknown,
  allowed: readonly string[],
  location: string,
): void {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    invalid(`managed worker identity ${location} must be an object`);
  }
  const unknown = Object.keys(payload).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) {
    invalid(
      `managed worker identity ${location} contains unsupported fields: ${unknown.join(', ')}`,
    );
  }
}

function requireBoundedString(
  value: unknown,
  field: string,
  maximum = 1024,
): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > maximum
  ) invalid(`managed worker identity ${field} is invalid`);
  return value;
}

/**
 * Put the existing one-time WorkerEnrollment/WorkerSession Ed25519 flow behind
 * the general Identity/Attestation contract without claiming hardware
 * attestation or crash-persistent pending proof material.
 */
export function createManagedWorkerIdentityAdapter(
  options: ManagedWorkerIdentityAdapterOptions,
): ManagedWorkerIdentityRoute {
  const now = options.now ?? (() => new Date());
  const maxChallengeTtlMs = options.maxChallengeTtlMs ?? 60_000;
  const maxSessionTtlMs = options.maxSessionTtlMs ?? 60 * 60_000;
  if (
    !options.name ||
    !options.threatAssumptions.length ||
    !Number.isSafeInteger(maxChallengeTtlMs) ||
    maxChallengeTtlMs < 1 ||
    !Number.isSafeInteger(maxSessionTtlMs) ||
    maxSessionTtlMs < 1
  ) invalid('managed worker identity adapter options are invalid');

  const enrollments = new Map<string, IdentityEnrollment>();
  const challenges = new Map<string, IdentityChallenge>();
  const identities = new Map<string, AttestedIdentity>();
  const sessions = new Map<string, IdentitySession>();
  const pending = new Map<string, PendingBinding>();
  const active = new Set<string>();
  const fences = new Map<string, number>();
  const idempotency = new Map<string, string>();

  async function enrollmentFor(
    request: DriverRequestEnvelope,
  ): Promise<WorkerEnrollmentResource> {
    if (
      request.resource.apiVersion !== WORKER_ENROLLMENT_API_VERSION ||
      request.resource.kind !== WORKER_ENROLLMENT_KIND
    ) invalid('managed worker identity resource kind is invalid');
    const resource = await options.store.get({
      apiVersion: WORKER_ENROLLMENT_API_VERSION,
      kind: WORKER_ENROLLMENT_KIND,
      name: request.resource.name,
    }) as WorkerEnrollmentResource | null;
    if (
      !resource ||
      resource.metadata.uid !== request.resource.uid ||
      resource.metadata.generation !== request.resource.generation
    ) {
      throw new OrchestrationError({
        code: resource ? 'CONFLICT' : 'NOT_FOUND',
        message: 'managed worker enrollment identity changed or disappeared',
        retryable: false,
      });
    }
    return resource;
  }

  async function authorize<T>(
    request: DriverRequestEnvelope<T>,
    method: string,
    fields: string[],
  ): Promise<WorkerEnrollmentResource> {
    exactFields(request.payload, fields, `${method} payload`);
    assertDriverRequestEnvelope(request, {
      now,
      requireFencing: true,
      requireCapability: true,
      expectedMethod: method,
    });
    if (
      request.actor.id !== options.actor.id ||
      request.actor.kind !== options.actor.kind
    ) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: 'managed worker identity actor was rejected',
        retryable: false,
      });
    }
    if (!await options.authorizeRequest(request)) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: 'managed worker identity capability was rejected',
        retryable: false,
      });
    }
    const resource = await enrollmentFor(request);
    const idempotencyKey = `${request.resource.uid}:${method}:${request.idempotencyKey}`;
    const fingerprint = canonicalDriverValue({
      resource: request.resource,
      fencingEpoch: request.fencingEpoch,
      actor: request.actor,
      session: request.session,
      capabilityHandleRef: request.capabilityHandleRef,
      payloadSchemaDigest: request.payloadSchemaDigest,
      payload: request.payload,
    });
    const previous = idempotency.get(idempotencyKey);
    if (previous !== undefined && previous !== fingerprint) {
      throw new OrchestrationError({
        code: 'CONFLICT',
        message: `managed worker identity ${method} idempotency input drifted`,
        retryable: false,
      });
    }
    idempotency.set(idempotencyKey, fingerprint);
    const fence = request.fencingEpoch;
    if (!Number.isSafeInteger(fence) || (fence as number) < 1) {
      invalid('managed worker identity fencing epoch is invalid');
    }
    const current = fences.get(request.resource.uid) ?? 0;
    if ((fence as number) < current) {
      throw new OrchestrationError({
        code: 'STALE_EPOCH',
        message: 'managed worker identity fencing epoch is stale',
        retryable: false,
      });
    }
    fences.set(request.resource.uid, fence as number);
    return resource;
  }

  function owned<T extends { resourceUid: string }>(
    values: Map<string, T>,
    handle: string,
    resourceUid: string,
    kind: string,
  ): T {
    const value = values.get(handle);
    if (!value) {
      throw new OrchestrationError({
        code: 'NOT_FOUND',
        message: `managed worker ${kind} handle was not found`,
        retryable: false,
      });
    }
    if (value.resourceUid !== resourceUid) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `managed worker ${kind} belongs to another resource`,
        retryable: false,
      });
    }
    return value;
  }

  const driver: IdentityAttestationManagementDriver = {
    async getCapabilities() {
      return {
        name: options.name,
        identityDomains: ['enrollment'],
        attestationFormats: [WORKER_ATTESTATION_FORMAT],
        supportsProofOfPossession: true,
        supportsChannelBinding: true,
        supportsRotation: false,
        maxChallengeTtlMs,
        maxSessionTtlMs,
        persistence: 'process',
        threatAssumptions: options.threatAssumptions,
      };
    },
    async enroll(request) {
      const resource = await authorize(request, 'identity.enroll', [
        'domain',
        'subject',
        'trustClass',
        'bootstrapKeyFingerprint',
        'ttlMs',
      ]);
      if (
        request.payload.domain !== 'enrollment' ||
        request.payload.subject !== resource.metadata.name ||
        request.payload.trustClass !== resource.spec.trustClass ||
        request.payload.bootstrapKeyFingerprint !==
          resource.spec.bootstrapTokenHash
      ) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'managed enrollment payload differs from WorkerEnrollment',
          retryable: false,
        });
      }
      const remaining = Date.parse(resource.spec.expiresAt) - now().getTime();
      if (
        !Number.isSafeInteger(remaining) ||
        remaining < 1 ||
        !Number.isSafeInteger(request.payload.ttlMs) ||
        request.payload.ttlMs < 1 ||
        request.payload.ttlMs > maxSessionTtlMs
      ) invalid('managed enrollment is expired or its requested TTL is invalid');
      const value: IdentityEnrollment = {
        enrollmentHandle: `worker-enrollment:${resource.metadata.uid}`,
        resourceUid: resource.metadata.uid,
        domain: 'enrollment',
        subject: resource.metadata.name,
        trustClass: resource.spec.trustClass,
        bootstrapKeyFingerprint: resource.spec.bootstrapTokenHash,
        expiresAt: resource.spec.expiresAt,
        consumed: resource.status?.phase === 'Bound',
        revoked: resource.status?.phase === 'Revoked' ||
          resource.status?.phase === 'Expired',
      };
      enrollments.set(value.enrollmentHandle, value);
      return structuredClone(value);
    },
    async challenge(request) {
      const resource = await authorize(request, 'identity.challenge', [
        'enrollmentHandle',
        'channelBinding',
        'ttlMs',
      ]);
      const enrollment = owned(
        enrollments,
        requireBoundedString(
          request.payload.enrollmentHandle,
          'enrollmentHandle',
        ),
        resource.metadata.uid,
        'enrollment',
      );
      const binding = pending.get(resource.metadata.uid);
      if (
        !binding ||
        binding.channelBinding !== request.payload.channelBinding ||
        enrollment.revoked ||
        Date.parse(enrollment.expiresAt) <= now().getTime()
      ) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'managed worker challenge has no active host binding',
          retryable: false,
        });
      }
      if (
        !Number.isSafeInteger(request.payload.ttlMs) ||
        request.payload.ttlMs < 1 ||
        request.payload.ttlMs > maxChallengeTtlMs
      ) invalid('managed worker challenge TTL is invalid');
      const handle = `worker-challenge:${resource.metadata.uid}:${binding.request.workerKeyFingerprint}`;
      const challenge: IdentityChallenge = {
        challengeHandle: handle,
        enrollmentHandle: enrollment.enrollmentHandle,
        resourceUid: resource.metadata.uid,
        nonce: binding.evidenceDigest,
        channelBinding: binding.channelBinding,
        expiresAt: new Date(
          Math.min(
            now().getTime() + request.payload.ttlMs,
            Date.parse(resource.spec.expiresAt),
          ),
        ).toISOString(),
        consumed: false,
      };
      challenges.set(handle, challenge);
      return structuredClone(challenge);
    },
    async attest(request) {
      const resource = await authorize(request, 'identity.attest', [
        'challengeHandle',
        'publicKeyFingerprint',
        'channelBinding',
        'attestation',
        'proof',
      ]);
      exactFields(
        request.payload.attestation,
        ['format', 'evidenceDigest'],
        'attestation',
      );
      const challenge = owned(
        challenges,
        requireBoundedString(
          request.payload.challengeHandle,
          'challengeHandle',
        ),
        resource.metadata.uid,
        'challenge',
      );
      const binding = pending.get(resource.metadata.uid);
      if (
        !binding ||
        challenge.consumed ||
        Date.parse(challenge.expiresAt) <= now().getTime() ||
        request.payload.publicKeyFingerprint !==
          binding.request.workerKeyFingerprint ||
        request.payload.channelBinding !== binding.channelBinding ||
        request.payload.attestation?.format !== WORKER_ATTESTATION_FORMAT ||
        request.payload.attestation?.evidenceDigest !== binding.evidenceDigest ||
        request.payload.proof !== binding.proofDigest
      ) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'managed worker attestation binding is invalid',
          retryable: false,
        });
      }
      if (
        !await binding.request.verifyBootstrapToken(
          binding.request.bootstrapToken,
          resource.spec.bootstrapTokenHash,
        ) ||
        !await binding.request.verifyWorkerProof({
          enrollmentName: resource.metadata.name,
          workerKeyFingerprint: binding.request.workerKeyFingerprint,
          workerPublicKey: binding.request.workerPublicKey,
          challenge: binding.request.proof.challenge,
          signature: binding.request.proof.signature,
        })
      ) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'managed worker proof of possession was rejected',
          retryable: false,
        });
      }
      challenge.consumed = true;
      const identity: AttestedIdentity = {
        identityHandle: `worker-identity:${resource.metadata.uid}:${binding.request.workerKeyFingerprint}`,
        resourceUid: resource.metadata.uid,
        domain: 'enrollment',
        subject: resource.metadata.name,
        trustClass: resource.spec.trustClass,
        keyFingerprint: binding.request.workerKeyFingerprint,
        channelBinding: binding.channelBinding,
        attestationFormat: WORKER_ATTESTATION_FORMAT,
        evidenceDigest: binding.evidenceDigest,
        issuedAt: now().toISOString(),
        revoked: false,
      };
      identities.set(identity.identityHandle, identity);
      return structuredClone(identity);
    },
    async issueSession(request) {
      const resource = await authorize(request, 'identity.issue-session', [
        'identityHandle',
        'domain',
        'audience',
        'channelBinding',
        'ttlMs',
      ]);
      const identity = owned(
        identities,
        requireBoundedString(request.payload.identityHandle, 'identityHandle'),
        resource.metadata.uid,
        'identity',
      );
      const binding = pending.get(resource.metadata.uid);
      if (
        !binding ||
        identity.revoked ||
        request.payload.domain !== 'enrollment' ||
        request.payload.audience !== resource.spec.audience ||
        request.payload.channelBinding !== identity.channelBinding ||
        !Number.isSafeInteger(request.payload.ttlMs) ||
        request.payload.ttlMs < 1 ||
        request.payload.ttlMs > maxSessionTtlMs
      ) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'managed worker session scope is invalid',
          retryable: false,
        });
      }
      const workerSession = await bindNarrowWorkerSession(
        options.store,
        options.actor,
        resource.metadata.name,
        {
          ...binding.request,
          ttlMs: request.payload.ttlMs,
          // Attest already consumed the host's one-time verifiers. The narrow
          // store function still rechecks all durable resource/session scope.
          verifyBootstrapToken: () => true,
          verifyWorkerProof: () => true,
        },
        now,
      );
      if (
        workerSession.status?.phase !== 'Active' ||
        !workerSession.status.issuedAt ||
        !workerSession.status.expiresAt
      ) {
        throw new OrchestrationError({
          code: 'UNKNOWN_EFFECT',
          message: 'managed worker session was not durably activated',
          retryable: false,
        });
      }
      const session: IdentitySession = {
        sessionHandle: `worker-session:${workerSession.metadata.name}`,
        identityHandle: identity.identityHandle,
        resourceUid: resource.metadata.uid,
        domain: 'enrollment',
        audience: workerSession.spec.audience,
        channelBinding: identity.channelBinding,
        issuedAt: workerSession.status.issuedAt,
        expiresAt: workerSession.status.expiresAt,
        revoked: false,
      };
      sessions.set(session.sessionHandle, session);
      return structuredClone(session);
    },
    async rotate(request) {
      await authorize(request, 'identity.rotate', [
        'identityHandle',
        'newKeyFingerprint',
        'channelBinding',
        'proof',
      ]);
      unsupported(
        'WorkerSession uses ephemeral Ed25519 keys; in-place identity rotation is unsupported, create a new enrollment',
      );
    },
    async revoke(request) {
      const resource = await authorize(request, 'identity.revoke', [
        'identityHandle',
        'reason',
      ]);
      const identity = owned(
        identities,
        requireBoundedString(request.payload.identityHandle, 'identityHandle'),
        resource.metadata.uid,
        'identity',
      );
      const reason = requireBoundedString(request.payload.reason, 'reason');
      const session = [...sessions.values()].find(
        (candidate) => candidate.identityHandle === identity.identityHandle,
      );
      if (session) {
        await revokeWorkerSession(
          options.store,
          options.actor,
          session.sessionHandle.slice('worker-session:'.length),
          reason,
          now,
        );
        session.revoked = true;
      }
      identity.revoked = true;
      identity.revokeReason = reason;
      return structuredClone(identity);
    },
    async inspect(request) {
      const resource = await authorize(request, 'identity.inspect', ['handle']);
      const handle = requireBoundedString(request.payload.handle, 'handle');
      const candidates: Array<IdentityInspection | undefined> = [
        enrollments.get(handle)
          ? { kind: 'enrollment', value: enrollments.get(handle)! }
          : undefined,
        challenges.get(handle)
          ? { kind: 'challenge', value: challenges.get(handle)! }
          : undefined,
        identities.get(handle)
          ? { kind: 'identity', value: identities.get(handle)! }
          : undefined,
        sessions.get(handle)
          ? { kind: 'session', value: sessions.get(handle)! }
          : undefined,
      ];
      const found = candidates.find(
        (candidate) => candidate?.value.resourceUid === resource.metadata.uid,
      );
      return found ? structuredClone(found) : undefined;
    },
  };

  return {
    driver,
    async bindWorkerSession(enrollmentName, request) {
      const enrollment = await options.store.get({
        apiVersion: WORKER_ENROLLMENT_API_VERSION,
        kind: WORKER_ENROLLMENT_KIND,
        name: enrollmentName,
      }) as WorkerEnrollmentResource | null;
      if (!enrollment) {
        throw new OrchestrationError({
          code: 'NOT_FOUND',
          message: `WorkerEnrollment '${enrollmentName}' not found`,
          retryable: false,
        });
      }
      if (
        !request.bootstrapToken ||
        request.bootstrapToken.length > 4096 ||
        !request.workerKeyFingerprint ||
        request.workerKeyFingerprint.length > 512 ||
        !request.workerPublicKey ||
        request.workerPublicKey.length > 16 * 1024 ||
        !request.gatewayKeyFingerprint ||
        request.gatewayKeyFingerprint.length > 512 ||
        !request.proof.challenge ||
        request.proof.challenge.length > 16 * 1024 ||
        !request.proof.signature ||
        request.proof.signature.length > 16 * 1024 ||
        !Number.isSafeInteger(request.ttlMs) ||
        request.ttlMs < 1
      ) invalid('managed worker binding request is invalid or too large');
      const remainingAtStart = Date.parse(enrollment.spec.expiresAt) -
        now().getTime();
      if (!Number.isSafeInteger(remainingAtStart) || remainingAtStart < 1) {
        throw new OrchestrationError({
          code: 'TIMEOUT',
          message: `WorkerEnrollment '${enrollmentName}' has expired`,
          retryable: false,
        });
      }
      if (active.has(enrollment.metadata.uid)) {
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: `WorkerEnrollment '${enrollmentName}' is already binding`,
          retryable: true,
        });
      }
      active.add(enrollment.metadata.uid);
      try {
        const channelBinding = await digest({
          gatewayKeyFingerprint: request.gatewayKeyFingerprint,
          audience: enrollment.spec.audience,
          workerKeyFingerprint: request.workerKeyFingerprint,
        });
        const proofDigest = await digest({
          signature: request.proof.signature,
        });
        const evidenceDigest = await digest({
          challenge: request.proof.challenge,
          signature: request.proof.signature,
          workerPublicKey: request.workerPublicKey,
          channelBinding,
        });
        pending.set(enrollment.metadata.uid, {
          enrollment,
          request,
          channelBinding,
          proofDigest,
          evidenceDigest,
        });
        const call = <T>(
          method: string,
          payload: T,
          suffix: string,
          payloadFields: string[],
        ) =>
          options.createRequest({
            method,
            payload,
            enrollment,
            actor: options.actor,
            idempotencyKey: `${enrollment.metadata.uid}:${suffix}:${request.workerKeyFingerprint}`,
            payloadFields,
          });
        const expiration = Date.parse(enrollment.spec.expiresAt);
        const remaining = expiration - now().getTime();
        if (!Number.isSafeInteger(remaining) || remaining < 1) {
          throw new OrchestrationError({
            code: 'TIMEOUT',
            message: `WorkerEnrollment '${enrollmentName}' expired during binding`,
            retryable: false,
          });
        }
        const managedEnrollment = await driver.enroll(call(
          'identity.enroll',
          {
            domain: 'enrollment' as const,
            subject: enrollment.metadata.name,
            trustClass: enrollment.spec.trustClass,
            bootstrapKeyFingerprint: enrollment.spec.bootstrapTokenHash,
            // The durable absolute expiresAt remains authoritative. Using the
            // configured bound keeps retries stable across elapsed time and
            // across ControlStore/adapter clock implementations.
            ttlMs: maxSessionTtlMs,
          },
          'enroll',
          [
            'domain',
            'subject',
            'trustClass',
            'bootstrapKeyFingerprint',
            'ttlMs',
          ],
        ));
        const challenge = await driver.challenge(call(
          'identity.challenge',
          {
            enrollmentHandle: managedEnrollment.enrollmentHandle,
            channelBinding,
            ttlMs: maxChallengeTtlMs,
          },
          'challenge',
          ['enrollmentHandle', 'channelBinding', 'ttlMs'],
        ));
        const identity = await driver.attest(call(
          'identity.attest',
          {
            challengeHandle: challenge.challengeHandle,
            publicKeyFingerprint: request.workerKeyFingerprint,
            channelBinding,
            attestation: {
              format: WORKER_ATTESTATION_FORMAT,
              evidenceDigest,
            },
            proof: proofDigest,
          },
          'attest',
          [
            'challengeHandle',
            'publicKeyFingerprint',
            'channelBinding',
            'attestation',
            'proof',
          ],
        ));
        await driver.issueSession(call(
          'identity.issue-session',
          {
            identityHandle: identity.identityHandle,
            domain: 'enrollment' as const,
            audience: enrollment.spec.audience,
            channelBinding,
            ttlMs: Math.min(request.ttlMs, maxSessionTtlMs),
          },
          'issue-session',
          [
            'identityHandle',
            'domain',
            'audience',
            'channelBinding',
            'ttlMs',
          ],
        ));
        const session = await options.store.get<WorkerSessionSpec>({
          apiVersion: WORKER_SESSION_API_VERSION,
          kind: WORKER_SESSION_KIND,
          name: `session-${enrollment.metadata.uid}`,
        }) as WorkerSessionResource | null;
        if (!session) {
          throw new OrchestrationError({
            code: 'UNKNOWN_EFFECT',
            message: 'managed worker session was issued but could not be observed',
            retryable: false,
          });
        }
        return session;
      } finally {
        pending.delete(enrollment.metadata.uid);
        active.delete(enrollment.metadata.uid);
      }
    },
  };
}
