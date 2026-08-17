import { OrchestrationError } from '../errors.js';
import type { NodeTrustClass } from '../resources.js';

import type { DriverConformanceSuite } from './driverConformance.js';
import type { DriverRequestEnvelope } from './driverRequest.js';
import { assertFencedDriverRequestEnvelope, findIdempotentDriverHandle, getOwnedDriverValue, rememberIdempotentDriverHandle } from './driverState.js';

export type IdentityDomain =
  | 'enrollment'
  | 'workload'
  | 'device'
  | 'control-plane';

export interface IdentityAttestationCapabilities {
  name: string;
  identityDomains: IdentityDomain[];
  attestationFormats: string[];
  supportsProofOfPossession: boolean;
  supportsChannelBinding: boolean;
  supportsRotation: boolean;
  maxChallengeTtlMs: number;
  maxSessionTtlMs: number;
  persistence: 'process' | 'host' | 'external';
  threatAssumptions: string[];
}

export interface IdentityEnrollment {
  enrollmentHandle: string;
  resourceUid: string;
  domain: IdentityDomain;
  subject: string;
  trustClass: NodeTrustClass;
  bootstrapKeyFingerprint: string;
  expiresAt: string;
  consumed: boolean;
  revoked: boolean;
}

export interface IdentityChallenge {
  challengeHandle: string;
  enrollmentHandle: string;
  resourceUid: string;
  nonce: string;
  channelBinding: string;
  expiresAt: string;
  consumed: boolean;
}

export interface AttestedIdentity {
  identityHandle: string;
  resourceUid: string;
  domain: IdentityDomain;
  subject: string;
  trustClass: NodeTrustClass;
  keyFingerprint: string;
  channelBinding: string;
  attestationFormat: string;
  evidenceDigest: string;
  issuedAt: string;
  rotatedAt?: string;
  revoked: boolean;
  revokeReason?: string;
}

export interface IdentitySession {
  sessionHandle: string;
  identityHandle: string;
  resourceUid: string;
  domain: IdentityDomain;
  audience: string;
  channelBinding: string;
  issuedAt: string;
  expiresAt: string;
  revoked: boolean;
}

export type IdentityInspection =
  | { kind: 'enrollment'; value: IdentityEnrollment }
  | { kind: 'challenge'; value: IdentityChallenge }
  | { kind: 'identity'; value: AttestedIdentity }
  | { kind: 'session'; value: IdentitySession };

export interface IdentityAttestationManagementDriver {
  getCapabilities(): Promise<IdentityAttestationCapabilities>;
  enroll(
    request: DriverRequestEnvelope<{
      domain: IdentityDomain;
      subject: string;
      trustClass: NodeTrustClass;
      bootstrapKeyFingerprint: string;
      ttlMs: number;
    }>,
  ): Promise<IdentityEnrollment>;
  challenge(
    request: DriverRequestEnvelope<{
      enrollmentHandle: string;
      channelBinding: string;
      ttlMs: number;
    }>,
  ): Promise<IdentityChallenge>;
  attest(
    request: DriverRequestEnvelope<{
      challengeHandle: string;
      publicKeyFingerprint: string;
      channelBinding: string;
      attestation: {
        format: string;
        evidenceDigest: string;
      };
      proof: string;
    }>,
  ): Promise<AttestedIdentity>;
  issueSession(
    request: DriverRequestEnvelope<{
      identityHandle: string;
      domain: IdentityDomain;
      audience: string;
      channelBinding: string;
      ttlMs: number;
    }>,
  ): Promise<IdentitySession>;
  rotate(
    request: DriverRequestEnvelope<{
      identityHandle: string;
      newKeyFingerprint: string;
      channelBinding: string;
      proof: string;
    }>,
  ): Promise<AttestedIdentity>;
  revoke(
    request: DriverRequestEnvelope<{
      identityHandle: string;
      reason: string;
    }>,
  ): Promise<AttestedIdentity>;
  inspect(
    request: DriverRequestEnvelope<{ handle: string }>,
  ): Promise<IdentityInspection | undefined>;
}

export interface FakeIdentityAttestationState {
  enrollments: Map<string, IdentityEnrollment>;
  challenges: Map<string, IdentityChallenge>;
  identities: Map<string, AttestedIdentity>;
  sessions: Map<string, IdentitySession>;
  idempotency: Map<string, string>;
  idempotencyFingerprints: Map<string, string>;
  fences: Map<string, number>;
  nextHandle: number;
}

export function createFakeIdentityAttestationState(): FakeIdentityAttestationState {
  return {
    enrollments: new Map(),
    challenges: new Map(),
    identities: new Map(),
    sessions: new Map(),
    idempotency: new Map(),
    idempotencyFingerprints: new Map(),
    fences: new Map(),
    nextHandle: 1,
  };
}

function invalid(message: string): never {
  throw new OrchestrationError({ code: 'INVALID', message, retryable: false });
}

function requiredString(payload: unknown, field: string): string {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof (payload as Record<string, unknown>)[field] !== 'string' ||
    !(payload as Record<string, string>)[field]
  ) invalid(`identity payload '${field}' is required`);
  return (payload as Record<string, string>)[field];
}

/** Durable-state deterministic reference identity and attestation driver. */
export function createFakeIdentityAttestationManagementDriver(options: {
  state?: FakeIdentityAttestationState;
  now?: () => Date;
  maxChallengeTtlMs?: number;
  maxSessionTtlMs?: number;
  allowedEvidenceDigests?: string[];
} = {}): IdentityAttestationManagementDriver {
  const state = options.state ?? createFakeIdentityAttestationState();
  const now = options.now ?? (() => new Date());
  const maxChallengeTtlMs = options.maxChallengeTtlMs ?? 60_000;
  const maxSessionTtlMs = options.maxSessionTtlMs ?? 15 * 60_000;
  const domains: IdentityDomain[] = [
    'enrollment',
    'workload',
    'device',
    'control-plane',
  ];
  const attestationFormats = ['fake-measured-boot/v1'];
  const allowedEvidenceDigests = options.allowedEvidenceDigests ?? [
    `sha256:${'a'.repeat(64)}`,
  ];

  function validate<T>(
    request: DriverRequestEnvelope<T>,
    expectedMethod: string,
    actorKinds: Array<'controller' | 'verifier' | 'admin'>,
  ): void {
    assertFencedDriverRequestEnvelope(request, {
      now,
      fences: state.fences,
      expectedMethod,
      fenceName: 'identity',
      actorKinds,
    });
  }

  function ttl(payload: unknown, field: string, maximum: number): number {
    if (payload === null || typeof payload !== 'object') {
      invalid(`identity ${field} is required`);
    }
    const value = (payload as Record<string, unknown>)[field];
    if (
      !Number.isSafeInteger(value) ||
      (value as number) < 1 ||
      (value as number) > maximum
    ) invalid(`identity ${field} must be between 1 and ${maximum}`);
    return value as number;
  }

  function opaque(prefix: string): string {
    const handle = `${prefix}:${state.nextHandle}`;
    state.nextHandle += 1;
    return handle;
  }

  function previous(
    request: DriverRequestEnvelope,
    operation: string,
  ): string | undefined {
    return findIdempotentDriverHandle(state, request, operation, 'identity');
  }

  function remember(
    request: DriverRequestEnvelope,
    operation: string,
    handle: string,
  ): void {
    rememberIdempotentDriverHandle(state, request, operation, handle);
  }

  function assertActiveIdentity(identity: AttestedIdentity): void {
    if (identity.revoked) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `identity '${identity.identityHandle}' is revoked`,
        retryable: false,
      });
    }
  }

  return {
    async getCapabilities() {
      return {
        name: 'fake-identity-attestation',
        identityDomains: domains,
        attestationFormats,
        supportsProofOfPossession: true,
        supportsChannelBinding: true,
        supportsRotation: true,
        maxChallengeTtlMs,
        maxSessionTtlMs,
        persistence: 'host',
        threatAssumptions: [
          'the injected state and deterministic fake verifier are trusted',
        ],
      };
    },
    async enroll(request) {
      validate(request, 'identity.enroll', ['controller', 'admin']);
      if (!domains.includes(request.payload.domain)) {
        invalid('identity domain is unsupported');
      }
      if (
        !['trusted', 'restricted', 'quarantine'].includes(
          request.payload.trustClass,
        )
      ) invalid('identity trust class is invalid');
      const subject = requiredString(request.payload, 'subject');
      const bootstrapKeyFingerprint = requiredString(
        request.payload,
        'bootstrapKeyFingerprint',
      );
      const ttlMs = ttl(request.payload, 'ttlMs', maxSessionTtlMs);
      const existing = previous(request, 'enroll');
      if (existing) {
        return structuredClone(getOwnedDriverValue(
          state.enrollments,
          existing,
          request.resource.uid,
          'enrollment',
        ));
      }
      const enrollment: IdentityEnrollment = {
        enrollmentHandle: opaque('identity-enrollment'),
        resourceUid: request.resource.uid,
        domain: request.payload.domain,
        subject,
        trustClass: request.payload.trustClass,
        bootstrapKeyFingerprint,
        expiresAt: new Date(now().getTime() + ttlMs).toISOString(),
        consumed: false,
        revoked: false,
      };
      state.enrollments.set(enrollment.enrollmentHandle, enrollment);
      remember(request, 'enroll', enrollment.enrollmentHandle);
      return structuredClone(enrollment);
    },
    async challenge(request) {
      validate(request, 'identity.challenge', ['controller', 'admin']);
      const enrollment = getOwnedDriverValue(
        state.enrollments,
        requiredString(request.payload, 'enrollmentHandle'),
        request.resource.uid,
        'enrollment',
      );
      const channelBinding = requiredString(
        request.payload,
        'channelBinding',
      );
      const ttlMs = ttl(request.payload, 'ttlMs', maxChallengeTtlMs);
      const existing = previous(request, 'challenge');
      if (existing) {
        return structuredClone(getOwnedDriverValue(
          state.challenges,
          existing,
          request.resource.uid,
          'challenge',
        ));
      }
      if (
        enrollment.revoked ||
        enrollment.consumed ||
        Date.parse(enrollment.expiresAt) <= now().getTime()
      ) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'identity enrollment is inactive or already consumed',
          retryable: false,
        });
      }
      const challengeHandle = opaque('identity-challenge');
      const challenge: IdentityChallenge = {
        challengeHandle,
        enrollmentHandle: enrollment.enrollmentHandle,
        resourceUid: request.resource.uid,
        nonce: `nonce:${challengeHandle}:${enrollment.bootstrapKeyFingerprint}`,
        channelBinding,
        expiresAt: new Date(now().getTime() + ttlMs).toISOString(),
        consumed: false,
      };
      state.challenges.set(challengeHandle, challenge);
      remember(request, 'challenge', challengeHandle);
      return structuredClone(challenge);
    },
    async attest(request) {
      validate(request, 'identity.attest', ['controller', 'verifier']);
      const challenge = getOwnedDriverValue(
        state.challenges,
        requiredString(request.payload, 'challengeHandle'),
        request.resource.uid,
        'challenge',
      );
      const enrollment = getOwnedDriverValue(
        state.enrollments,
        challenge.enrollmentHandle,
        request.resource.uid,
        'enrollment',
      );
      const publicKeyFingerprint = requiredString(
        request.payload,
        'publicKeyFingerprint',
      );
      const channelBinding = requiredString(
        request.payload,
        'channelBinding',
      );
      if (channelBinding !== challenge.channelBinding) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'identity attestation channel binding mismatch',
          retryable: false,
        });
      }
      if (
        !attestationFormats.includes(request.payload.attestation?.format) ||
        !/^sha256:[a-f0-9]{64}$/.test(
          request.payload.attestation?.evidenceDigest,
        ) ||
        !allowedEvidenceDigests.includes(
          request.payload.attestation?.evidenceDigest,
        )
      ) invalid('identity attestation evidence is invalid or unsupported');
      const expectedProof = `proof:${challenge.nonce}:${publicKeyFingerprint}:${channelBinding}`;
      if (request.payload.proof !== expectedProof) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'identity proof of possession is invalid',
          retryable: false,
        });
      }
      const existing = previous(request, 'attest');
      if (existing) {
        return structuredClone(getOwnedDriverValue(
          state.identities,
          existing,
          request.resource.uid,
          'identity',
        ));
      }
      if (
        challenge.consumed ||
        Date.parse(challenge.expiresAt) <= now().getTime() ||
        enrollment.revoked ||
        enrollment.consumed
      ) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'identity challenge is expired, consumed, or revoked',
          retryable: false,
        });
      }
      challenge.consumed = true;
      enrollment.consumed = true;
      const identity: AttestedIdentity = {
        identityHandle: opaque('attested-identity'),
        resourceUid: request.resource.uid,
        domain: enrollment.domain,
        subject: enrollment.subject,
        trustClass: enrollment.trustClass,
        keyFingerprint: publicKeyFingerprint,
        channelBinding,
        attestationFormat: request.payload.attestation.format,
        evidenceDigest: request.payload.attestation.evidenceDigest,
        issuedAt: now().toISOString(),
        revoked: false,
      };
      state.identities.set(identity.identityHandle, identity);
      remember(request, 'attest', identity.identityHandle);
      return structuredClone(identity);
    },
    async issueSession(request) {
      validate(request, 'identity.issue-session', ['controller', 'admin']);
      const identity = getOwnedDriverValue(
        state.identities,
        requiredString(request.payload, 'identityHandle'),
        request.resource.uid,
        'identity',
      );
      assertActiveIdentity(identity);
      if (request.payload.domain !== identity.domain) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: `identity domain '${identity.domain}' cannot issue '${request.payload.domain}' session`,
          retryable: false,
        });
      }
      const audience = requiredString(request.payload, 'audience');
      const channelBinding = requiredString(
        request.payload,
        'channelBinding',
      );
      if (channelBinding !== identity.channelBinding) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'identity session channel binding mismatch',
          retryable: false,
        });
      }
      const ttlMs = ttl(request.payload, 'ttlMs', maxSessionTtlMs);
      const existing = previous(request, 'issue-session');
      if (existing) {
        return structuredClone(getOwnedDriverValue(
          state.sessions,
          existing,
          request.resource.uid,
          'session',
        ));
      }
      const session: IdentitySession = {
        sessionHandle: opaque('identity-session'),
        identityHandle: identity.identityHandle,
        resourceUid: request.resource.uid,
        domain: identity.domain,
        audience,
        channelBinding,
        issuedAt: now().toISOString(),
        expiresAt: new Date(now().getTime() + ttlMs).toISOString(),
        revoked: false,
      };
      state.sessions.set(session.sessionHandle, session);
      remember(request, 'issue-session', session.sessionHandle);
      return structuredClone(session);
    },
    async rotate(request) {
      validate(request, 'identity.rotate', ['controller', 'admin']);
      const identity = getOwnedDriverValue(
        state.identities,
        requiredString(request.payload, 'identityHandle'),
        request.resource.uid,
        'identity',
      );
      assertActiveIdentity(identity);
      const newKeyFingerprint = requiredString(
        request.payload,
        'newKeyFingerprint',
      );
      const channelBinding = requiredString(
        request.payload,
        'channelBinding',
      );
      const existing = previous(request, 'rotate');
      if (existing) {
        return structuredClone(getOwnedDriverValue(
          state.identities,
          existing,
          request.resource.uid,
          'identity',
        ));
      }
      const expectedProof = `rotate:${identity.identityHandle}:${identity.keyFingerprint}:${newKeyFingerprint}:${channelBinding}`;
      if (request.payload.proof !== expectedProof) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'identity rotation proof is invalid',
          retryable: false,
        });
      }
      identity.keyFingerprint = newKeyFingerprint;
      identity.channelBinding = channelBinding;
      identity.rotatedAt = now().toISOString();
      for (const session of state.sessions.values()) {
        if (session.identityHandle === identity.identityHandle) {
          session.revoked = true;
        }
      }
      remember(request, 'rotate', identity.identityHandle);
      return structuredClone(identity);
    },
    async revoke(request) {
      validate(request, 'identity.revoke', ['controller', 'admin']);
      const identity = getOwnedDriverValue(
        state.identities,
        requiredString(request.payload, 'identityHandle'),
        request.resource.uid,
        'identity',
      );
      const reason = requiredString(request.payload, 'reason');
      identity.revoked = true;
      identity.revokeReason = reason;
      for (const session of state.sessions.values()) {
        if (session.identityHandle === identity.identityHandle) {
          session.revoked = true;
        }
      }
      return structuredClone(identity);
    },
    async inspect(request) {
      validate(request, 'identity.inspect', [
        'controller',
        'verifier',
        'admin',
      ]);
      const handle = requiredString(request.payload, 'handle');
      const collections = [
        ['enrollment', state.enrollments],
        ['challenge', state.challenges],
        ['identity', state.identities],
        ['session', state.sessions],
      ] as const;
      for (const [kind, collection] of collections) {
        const value = collection.get(handle);
        if (!value) continue;
        if (value.resourceUid !== request.resource.uid) {
          throw new OrchestrationError({
            code: 'FORBIDDEN',
            message: `${kind} handle '${handle}' belongs to another resource`,
            retryable: false,
          });
        }
        return { kind, value: structuredClone(value) } as IdentityInspection;
      }
      return undefined;
    },
  };
}

export function createIdentityAttestationConformanceSuite(options: {
  createRequest<T>(
    method: string,
    payload: T,
    idempotencyKey: string,
    fencingEpoch?: number,
    resourceUid?: string,
    actorKind?: 'controller' | 'verifier' | 'admin',
  ): DriverRequestEnvelope<T>;
  recreate(
    driver: IdentityAttestationManagementDriver,
  ): IdentityAttestationManagementDriver;
}): DriverConformanceSuite {
  async function attest(
    driver: IdentityAttestationManagementDriver,
    suffix: string,
    domain: IdentityDomain = 'workload',
    epoch = 1,
    resourceUid = 'identity-uid-1',
  ): Promise<AttestedIdentity> {
    const enrollment = await driver.enroll(options.createRequest(
      'identity.enroll',
      {
        domain,
        subject: `${domain}/subject-1`,
        trustClass: 'restricted' as const,
        bootstrapKeyFingerprint: 'ed25519:bootstrap-1',
        ttlMs: 60_000,
      },
      `enroll-${suffix}`,
      epoch,
      resourceUid,
    ));
    const challenge = await driver.challenge(options.createRequest(
      'identity.challenge',
      {
        enrollmentHandle: enrollment.enrollmentHandle,
        channelBinding: 'tls-exporter:channel-1',
        ttlMs: 30_000,
      },
      `challenge-${suffix}`,
      epoch,
      resourceUid,
    ));
    const keyFingerprint = 'ed25519:identity-1';
    return await driver.attest(options.createRequest(
      'identity.attest',
      {
        challengeHandle: challenge.challengeHandle,
        publicKeyFingerprint: keyFingerprint,
        channelBinding: challenge.channelBinding,
        attestation: {
          format: 'fake-measured-boot/v1',
          evidenceDigest: `sha256:${'a'.repeat(64)}`,
        },
        proof: `proof:${challenge.nonce}:${keyFingerprint}:${challenge.channelBinding}`,
      },
      `attest-${suffix}`,
      epoch,
      resourceUid,
      'verifier',
    ));
  }

  return {
    interfaceKind: 'identity-attestation',
    tests: [
      {
        name: 'declares separated domains, attestation, binding, persistence, and threats',
        description: 'Identity security capabilities are explicit',
        run: async (value) => {
          const capabilities = await (
            value as IdentityAttestationManagementDriver
          ).getCapabilities();
          if (
            capabilities.identityDomains.length !== 4 ||
            !capabilities.attestationFormats.length ||
            !capabilities.supportsProofOfPossession ||
            !capabilities.supportsChannelBinding ||
            !capabilities.supportsRotation ||
            !capabilities.threatAssumptions.length
          ) throw new Error('identity capabilities are incomplete');
        },
      },
      {
        name: 'enroll, challenge, attest, and issue session are bound and idempotent',
        description: 'The complete identity bootstrap lifecycle converges',
        run: async (value) => {
          const driver = value as IdentityAttestationManagementDriver;
          const identity = await attest(driver, 'lifecycle');
          const request = options.createRequest(
            'identity.issue-session',
            {
              identityHandle: identity.identityHandle,
              domain: identity.domain,
              audience: 'worker-gateway',
              channelBinding: 'tls-exporter:channel-1',
              ttlMs: 60_000,
            },
            'session-lifecycle',
          );
          const first = await driver.issueSession(request);
          const duplicate = await driver.issueSession(request);
          if (first.sessionHandle !== duplicate.sessionHandle) {
            throw new Error('identity session issue is not idempotent');
          }
          let driftRejected = false;
          try {
            await driver.issueSession({
              ...request,
              payload: { ...request.payload, audience: 'other-gateway' },
            });
          } catch (error) {
            driftRejected = error instanceof OrchestrationError && error.code === 'CONFLICT';
          }
          if (!driftRejected) {
            throw new Error('identity idempotency input drift was accepted');
          }
        },
      },
      {
        name: 'identity and session inspection survive driver restart',
        description: 'Durable identity state remains authoritative after recreation',
        run: async (value) => {
          let driver = value as IdentityAttestationManagementDriver;
          const identity = await attest(driver, 'restart');
          driver = options.recreate(driver);
          const inspected = await driver.inspect(options.createRequest(
            'identity.inspect',
            { handle: identity.identityHandle },
            'inspect-restart',
            1,
            'identity-uid-1',
            'verifier',
          ));
          if (
            inspected?.kind !== 'identity' ||
            inspected.value.identityHandle !== identity.identityHandle
          ) throw new Error('identity was not inspectable after restart');
        },
      },
      {
        name: 'rotation and revocation invalidate existing sessions',
        description: 'Key changes and revocation cascade to issued sessions',
        run: async (value) => {
          const driver = value as IdentityAttestationManagementDriver;
          const identity = await attest(driver, 'rotation');
          const session = await driver.issueSession(options.createRequest(
            'identity.issue-session',
            {
              identityHandle: identity.identityHandle,
              domain: identity.domain,
              audience: 'worker-gateway',
              channelBinding: 'tls-exporter:channel-1',
              ttlMs: 60_000,
            },
            'session-rotation',
          ));
          const newKey = 'ed25519:identity-2';
          const channel = 'tls-exporter:channel-2';
          const rotated = await driver.rotate(options.createRequest(
            'identity.rotate',
            {
              identityHandle: identity.identityHandle,
              newKeyFingerprint: newKey,
              channelBinding: channel,
              proof: `rotate:${identity.identityHandle}:${identity.keyFingerprint}:${newKey}:${channel}`,
            },
            'rotate',
          ));
          if (rotated.keyFingerprint !== newKey) {
            throw new Error('identity key did not rotate');
          }
          const oldSession = await driver.inspect(options.createRequest(
            'identity.inspect',
            { handle: session.sessionHandle },
            'inspect-old-session',
          ));
          if (oldSession?.kind !== 'session' || !oldSession.value.revoked) {
            throw new Error('rotation did not revoke the old session');
          }
          await driver.revoke(options.createRequest(
            'identity.revoke',
            { identityHandle: identity.identityHandle, reason: 'test' },
            'revoke',
          ));
          const inspected = await driver.inspect(options.createRequest(
            'identity.inspect',
            { handle: identity.identityHandle },
            'inspect-revoked',
          ));
          if (inspected?.kind !== 'identity' || !inspected.value.revoked) {
            throw new Error('identity revocation was not retained');
          }
        },
      },
      {
        name: 'rejects proof replay, channel drift, domain confusion, stale fencing, and foreign handles',
        description: 'Identity scopes cannot be weakened or crossed',
        run: async (value) => {
          const driver = value as IdentityAttestationManagementDriver;
          const replayEnrollment = await driver.enroll(options.createRequest(
            'identity.enroll',
            {
              domain: 'workload' as const,
              subject: 'workload/replay',
              trustClass: 'restricted' as const,
              bootstrapKeyFingerprint: 'ed25519:bootstrap-replay',
              ttlMs: 60_000,
            },
            'enroll-replay',
            1,
            'identity-replay',
          ));
          const replayChallenge = await driver.challenge(options.createRequest(
            'identity.challenge',
            {
              enrollmentHandle: replayEnrollment.enrollmentHandle,
              channelBinding: 'tls-exporter:bound',
              ttlMs: 30_000,
            },
            'challenge-replay',
            1,
            'identity-replay',
          ));
          const replayKey = 'ed25519:replay-key';
          let channelRejected = false;
          try {
            await driver.attest(options.createRequest(
              'identity.attest',
              {
                challengeHandle: replayChallenge.challengeHandle,
                publicKeyFingerprint: replayKey,
                channelBinding: 'tls-exporter:wrong',
                attestation: {
                  format: 'fake-measured-boot/v1',
                  evidenceDigest: `sha256:${'a'.repeat(64)}`,
                },
                proof: `proof:${replayChallenge.nonce}:${replayKey}:tls-exporter:wrong`,
              },
              'attest-wrong-channel',
              1,
              'identity-replay',
              'verifier',
            ));
          } catch (error) {
            channelRejected = error instanceof OrchestrationError && error.code === 'FORBIDDEN';
          }
          if (!channelRejected) throw new Error('channel binding drift passed');
          const replayPayload = {
            challengeHandle: replayChallenge.challengeHandle,
            publicKeyFingerprint: replayKey,
            channelBinding: replayChallenge.channelBinding,
            attestation: {
              format: 'fake-measured-boot/v1',
              evidenceDigest: `sha256:${'a'.repeat(64)}`,
            },
            proof: `proof:${replayChallenge.nonce}:${replayKey}:${replayChallenge.channelBinding}`,
          };
          await driver.attest(options.createRequest(
            'identity.attest',
            replayPayload,
            'attest-consume',
            1,
            'identity-replay',
            'verifier',
          ));
          let replayRejected = false;
          try {
            await driver.attest(options.createRequest(
              'identity.attest',
              replayPayload,
              'attest-replay',
              1,
              'identity-replay',
              'verifier',
            ));
          } catch (error) {
            replayRejected = error instanceof OrchestrationError && error.code === 'FORBIDDEN';
          }
          if (!replayRejected) throw new Error('challenge replay was accepted');

          const identity = await attest(
            driver,
            'security',
            'device',
            8,
            'identity-secure',
          );
          let domainRejected = false;
          try {
            await driver.issueSession(options.createRequest(
              'identity.issue-session',
              {
                identityHandle: identity.identityHandle,
                domain: 'control-plane' as const,
                audience: 'control-plane',
                channelBinding: 'tls-exporter:channel-1',
                ttlMs: 60_000,
              },
              'domain-confusion',
              8,
              'identity-secure',
            ));
          } catch (error) {
            domainRejected = error instanceof OrchestrationError && error.code === 'FORBIDDEN';
          }
          if (!domainRejected) throw new Error('identity domain confusion passed');
          let stale = false;
          try {
            await driver.inspect(options.createRequest(
              'identity.inspect',
              { handle: identity.identityHandle },
              'stale',
              7,
              'identity-secure',
            ));
          } catch (error) {
            stale = error instanceof OrchestrationError && error.code === 'STALE_EPOCH';
          }
          if (!stale) throw new Error('stale identity epoch was accepted');
          let foreign = false;
          try {
            await driver.inspect(options.createRequest(
              'identity.inspect',
              { handle: identity.identityHandle },
              'foreign',
              8,
              'identity-foreign',
            ));
          } catch (error) {
            foreign = error instanceof OrchestrationError && error.code === 'FORBIDDEN';
          }
          if (!foreign) throw new Error('foreign identity handle was accepted');
        },
      },
    ],
  };
}
