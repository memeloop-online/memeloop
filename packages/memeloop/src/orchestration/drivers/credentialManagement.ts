import { OrchestrationError } from '../errors.js';

import type { DriverConformanceSuite } from './driverConformance.js';
import { assertDriverRequestEnvelope, type DriverRequestEnvelope } from './driverRequest.js';

export interface CredentialManagementCapabilities {
  name: string;
  supportsRenewal: boolean;
  supportsProofOfPossession: boolean;
  supportsMaterialization: boolean;
  supportedExposures: CredentialIssuePayload['exposure'][];
  maxTtlMs: number;
  persistence: 'process' | 'host' | 'external';
  threatAssumptions: string[];
}

export interface CredentialIssuePayload {
  workerKey: string;
  target: string;
  targetMethod: string;
  targetDriver: string;
  audience: string;
  policyDigest: string;
  ttlMs: number;
  exposure: 'none' | 'worker-visible' | 'potentially-exposed';
}

export interface ManagedCredentialGrant {
  grantHandle: string;
  resourceUid: string;
  runUid: string;
  attempt: number;
  workerKey: string;
  target: string;
  targetMethod: string;
  targetDriver: string;
  audience: string;
  policyDigest: string;
  issuedAt: string;
  expiresAt: string;
  revoked: boolean;
  exposure: CredentialIssuePayload['exposure'];
  rotationRequired: boolean;
}

export interface ManagedCredentialMaterialization {
  materializationHandle: string;
  grantHandle: string;
  resourceUid: string;
  targetDriver: string;
  expiresAt: string;
}

/** §10.7 broker surface. No method returns raw credential material. */
export interface CredentialManagementDriver {
  getCapabilities(): Promise<CredentialManagementCapabilities>;
  issue(
    request: DriverRequestEnvelope<CredentialIssuePayload>,
  ): Promise<ManagedCredentialGrant>;
  renew(
    request: DriverRequestEnvelope<{ grantHandle: string; ttlMs: number }>,
  ): Promise<ManagedCredentialGrant>;
  revoke(
    request: DriverRequestEnvelope<{ grantHandle: string }>,
  ): Promise<void>;
  inspect(
    request: DriverRequestEnvelope<{ grantHandle: string }>,
  ): Promise<ManagedCredentialGrant | undefined>;
  materialize(
    request: DriverRequestEnvelope<{
      grantHandle: string;
      targetDriver: string;
      proof: {
        challengeId: string;
        signature: string;
      };
    }>,
  ): Promise<ManagedCredentialMaterialization>;
}

export interface FakeCredentialManagementState {
  grants: Map<string, ManagedCredentialGrant>;
  materializations: Map<string, ManagedCredentialMaterialization>;
  idempotency: Map<string, string>;
  fences: Map<string, number>;
  consumedChallenges: Set<string>;
  nextHandle: number;
}

export function createFakeCredentialManagementState(): FakeCredentialManagementState {
  return {
    grants: new Map(),
    materializations: new Map(),
    idempotency: new Map(),
    fences: new Map(),
    consumedChallenges: new Set(),
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
  ) {
    invalid(`credential payload '${field}' is required`);
  }
  return (payload as Record<string, string>)[field];
}

/** Durable-state reference broker used by the portable conformance harness. */
export function createFakeCredentialManagementDriver(options: {
  state?: FakeCredentialManagementState;
  now?: () => Date;
  maxTtlMs?: number;
} = {}): CredentialManagementDriver {
  const state = options.state ?? createFakeCredentialManagementState();
  const now = options.now ?? (() => new Date());
  const maxTtlMs = options.maxTtlMs ?? 60 * 60 * 1000;

  function validate<T>(
    request: DriverRequestEnvelope<T>,
    expectedMethod: string,
  ): number {
    assertDriverRequestEnvelope<T>(request, {
      now,
      requireRun: true,
      requireFencing: true,
      requireCapability: true,
      expectedMethod,
    });
    const fence = request.fencingEpoch as number;
    const current = state.fences.get(request.resource.uid) ?? 0;
    if (fence < current) {
      throw new OrchestrationError({
        code: 'STALE_EPOCH',
        message: `stale credential fencing epoch ${fence}; current epoch is ${current}`,
        retryable: false,
      });
    }
    state.fences.set(request.resource.uid, fence);
    return fence;
  }

  function operationKey(request: DriverRequestEnvelope, operation: string): string {
    return `${request.resource.uid}:${operation}:${request.idempotencyKey}`;
  }

  function opaque(prefix: string): string {
    const handle = `${prefix}:${state.nextHandle}`;
    state.nextHandle += 1;
    return handle;
  }

  function getGrant(
    handle: string,
    resourceUid: string,
    allowRevoked = false,
  ): ManagedCredentialGrant {
    const grant = state.grants.get(handle);
    if (!grant) {
      throw new OrchestrationError({
        code: 'NOT_FOUND',
        message: `credential grant '${handle}' was not found`,
        retryable: false,
      });
    }
    if (grant.resourceUid !== resourceUid) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `credential grant '${handle}' belongs to another resource`,
        retryable: false,
      });
    }
    if (!allowRevoked && grant.revoked) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `credential grant '${handle}' is revoked`,
        retryable: false,
      });
    }
    if (!allowRevoked && Date.parse(grant.expiresAt) <= now().getTime()) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `credential grant '${handle}' is expired`,
        retryable: false,
      });
    }
    return grant;
  }

  function ttl(payload: unknown): number {
    if (payload === null || typeof payload !== 'object') {
      invalid('credential ttlMs is required');
    }
    const value = (payload as Record<string, unknown>).ttlMs;
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maxTtlMs) {
      invalid(`credential ttlMs must be between 1 and ${maxTtlMs}`);
    }
    return value as number;
  }

  return {
    async getCapabilities() {
      return {
        name: 'fake-managed-credential-broker',
        supportsRenewal: true,
        supportsProofOfPossession: true,
        supportsMaterialization: true,
        supportedExposures: [
          'none',
          'worker-visible',
          'potentially-exposed',
        ],
        maxTtlMs,
        persistence: 'host',
        threatAssumptions: [
          'the broker state and materialization target are trusted and durable',
        ],
      };
    },
    async issue(request) {
      validate(request, 'credential.issue');
      const key = operationKey(request, 'issue');
      const existing = state.idempotency.get(key);
      if (existing) return getGrant(existing, request.resource.uid);
      const ttlMs = ttl(request.payload);
      const run = request.run as NonNullable<typeof request.run>;
      for (
        const field of [
          'workerKey',
          'target',
          'targetMethod',
          'targetDriver',
          'audience',
          'policyDigest',
        ] as const
      ) requiredString(request.payload, field);
      if (!/^sha256:[a-f0-9]{64}$/.test(request.payload.policyDigest)) {
        invalid('credential policyDigest must be a canonical sha256 digest');
      }
      if (request.payload.targetDriver !== request.payload.audience) {
        invalid('credential targetDriver must equal its intended audience');
      }
      if (
        !['none', 'worker-visible', 'potentially-exposed'].includes(
          request.payload.exposure,
        )
      ) invalid('credential exposure classification is invalid');
      const grant: ManagedCredentialGrant = {
        grantHandle: opaque('credential-grant'),
        resourceUid: request.resource.uid,
        runUid: run.uid,
        attempt: run.attempt,
        workerKey: request.payload.workerKey,
        target: request.payload.target,
        targetMethod: request.payload.targetMethod,
        targetDriver: request.payload.targetDriver,
        audience: request.payload.audience,
        policyDigest: request.payload.policyDigest,
        issuedAt: now().toISOString(),
        expiresAt: new Date(now().getTime() + ttlMs).toISOString(),
        revoked: false,
        exposure: request.payload.exposure,
        rotationRequired: request.payload.exposure !== 'none',
      };
      state.grants.set(grant.grantHandle, grant);
      state.idempotency.set(key, grant.grantHandle);
      return grant;
    },
    async renew(request) {
      validate(request, 'credential.renew');
      const grantHandle = requiredString(request.payload, 'grantHandle');
      const current = getGrant(grantHandle, request.resource.uid);
      const key = operationKey(request, 'renew');
      const existing = state.idempotency.get(key);
      if (existing) return getGrant(existing, request.resource.uid);
      const renewed = {
        ...current,
        expiresAt: new Date(now().getTime() + ttl(request.payload)).toISOString(),
      };
      state.grants.set(grantHandle, renewed);
      state.idempotency.set(key, grantHandle);
      return renewed;
    },
    async revoke(request) {
      validate(request, 'credential.revoke');
      const handle = requiredString(request.payload, 'grantHandle');
      const current = state.grants.get(handle);
      if (!current) return;
      getGrant(handle, request.resource.uid, true);
      state.grants.set(handle, { ...current, revoked: true });
      for (const [materializationHandle, materialization] of state.materializations) {
        if (materialization.grantHandle === handle) {
          state.materializations.delete(materializationHandle);
        }
      }
    },
    async inspect(request) {
      validate(request, 'credential.inspect');
      const handle = requiredString(request.payload, 'grantHandle');
      const grant = state.grants.get(handle);
      return grant
        ? { ...getGrant(handle, request.resource.uid, true) }
        : undefined;
    },
    async materialize(request) {
      validate(request, 'credential.materialize');
      const grant = getGrant(
        requiredString(request.payload, 'grantHandle'),
        request.resource.uid,
      );
      const targetDriver = requiredString(request.payload, 'targetDriver');
      const proof = request.payload.proof;
      if (
        proof === null ||
        typeof proof !== 'object' ||
        typeof proof.challengeId !== 'string' ||
        !proof.challengeId ||
        typeof proof.signature !== 'string' ||
        !proof.signature
      ) invalid('credential proof of possession is required');
      if (request.session?.keyFingerprint !== grant.workerKey) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'credential worker key does not match the bound session',
          retryable: false,
        });
      }
      if (targetDriver !== grant.targetDriver) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'credential target driver exceeds the grant scope',
          retryable: false,
        });
      }
      const key = operationKey(request, 'materialize');
      const existing = state.idempotency.get(key);
      if (existing) {
        const materialization = state.materializations.get(existing);
        if (materialization) return materialization;
      }
      const expectedProof = `proof:${proof.challengeId}:${grant.workerKey}`;
      if (
        proof.signature !== expectedProof ||
        state.consumedChallenges.has(proof.challengeId)
      ) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'credential proof is invalid or already consumed',
          retryable: false,
        });
      }
      state.consumedChallenges.add(proof.challengeId);
      const materialization: ManagedCredentialMaterialization = {
        materializationHandle: opaque('credential-materialization'),
        grantHandle: grant.grantHandle,
        resourceUid: request.resource.uid,
        targetDriver,
        expiresAt: grant.expiresAt,
      };
      state.materializations.set(
        materialization.materializationHandle,
        materialization,
      );
      state.idempotency.set(key, materialization.materializationHandle);
      return materialization;
    },
  };
}

export function createCredentialManagementConformanceSuite(options: {
  createRequest<T>(
    method: string,
    payload: T,
    idempotencyKey: string,
    fencingEpoch?: number,
    resourceUid?: string,
  ): DriverRequestEnvelope<T>;
  recreate(driver: CredentialManagementDriver): CredentialManagementDriver;
}): DriverConformanceSuite {
  const issue = (
    driver: CredentialManagementDriver,
    suffix: string,
    epoch = 1,
  ) =>
    driver.issue(options.createRequest(
      'credential.issue',
      {
        workerKey: 'ed25519:worker-1',
        target: 'model/gateway',
        targetMethod: 'generate',
        targetDriver: 'model-provider/openai',
        audience: 'model-provider/openai',
        policyDigest: `sha256:${'a'.repeat(64)}`,
        ttlMs: 30_000,
        exposure: 'none' as const,
      },
      `issue-${suffix}`,
      epoch,
    ));

  return {
    interfaceKind: 'credential',
    tests: [
      {
        name: 'declares TTL, proof, materialization, persistence, and threats',
        description: 'Credential security capabilities are explicit',
        run: async (value) => {
          const capabilities = await (value as CredentialManagementDriver)
            .getCapabilities();
          if (
            !capabilities.supportsRenewal ||
            !capabilities.supportsProofOfPossession ||
            !capabilities.supportsMaterialization ||
            !capabilities.supportedExposures.length ||
            capabilities.maxTtlMs < 1 ||
            !capabilities.threatAssumptions.length
          ) throw new Error('credential capabilities are incomplete');
        },
      },
      {
        name: 'issue and renew are idempotent and bounded',
        description: 'Retries preserve one grant and renewal has a bounded TTL',
        run: async (value) => {
          const driver = value as CredentialManagementDriver;
          const request = options.createRequest(
            'credential.issue',
            {
              workerKey: 'ed25519:worker-1',
              target: 'tool/filesystem',
              targetMethod: 'read',
              targetDriver: 'tool-execution/local',
              audience: 'tool-execution/local',
              policyDigest: `sha256:${'b'.repeat(64)}`,
              ttlMs: 10_000,
              exposure: 'worker-visible' as const,
            },
            'idempotent',
          );
          const first = await driver.issue(request);
          const duplicate = await driver.issue(request);
          if (first.grantHandle !== duplicate.grantHandle) {
            throw new Error('credential issue is not idempotent');
          }
          const renewed = await driver.renew(options.createRequest(
            'credential.renew',
            { grantHandle: first.grantHandle, ttlMs: 20_000 },
            'renew',
          ));
          if (
            renewed.grantHandle !== first.grantHandle ||
            !renewed.rotationRequired
          ) throw new Error('credential renewal or exposure tracking failed');
        },
      },
      {
        name: 'materialization requires the bound worker proof and is revoked',
        description: 'Only the bound session receives an opaque downstream handle',
        run: async (value) => {
          const driver = value as CredentialManagementDriver;
          const grant = await issue(driver, 'materialize');
          const request = options.createRequest(
            'credential.materialize',
            {
              grantHandle: grant.grantHandle,
              targetDriver: 'model-provider/openai',
              proof: {
                challengeId: 'challenge-1',
                signature: 'proof:challenge-1:ed25519:worker-1',
              },
            },
            'materialize',
          );
          request.session = {
            id: 'worker-session-1',
            keyFingerprint: 'ed25519:worker-1',
          };
          const first = await driver.materialize(request);
          const duplicate = await driver.materialize(request);
          if (first.materializationHandle !== duplicate.materializationHandle) {
            throw new Error('credential materialization is not idempotent');
          }
          let replayRejected = false;
          try {
            await driver.materialize({
              ...request,
              requestId: 'materialize-replay',
              idempotencyKey: 'materialize-replay',
            });
          } catch (error) {
            replayRejected = error instanceof OrchestrationError && error.code === 'FORBIDDEN';
          }
          if (!replayRejected) throw new Error('credential proof replay was accepted');
          await driver.revoke(options.createRequest(
            'credential.revoke',
            { grantHandle: grant.grantHandle },
            'revoke',
          ));
          const inspected = await driver.inspect(options.createRequest(
            'credential.inspect',
            { grantHandle: grant.grantHandle },
            'inspect',
          ));
          if (!inspected?.revoked) throw new Error('revocation was not retained');
          let rejected = false;
          try {
            await driver.materialize({
              ...request,
              requestId: 'materialize-after-revoke',
              idempotencyKey: 'materialize-after-revoke',
            });
          } catch (error) {
            rejected = error instanceof OrchestrationError && error.code === 'FORBIDDEN';
          }
          if (!rejected) throw new Error('revoked grant was materialized');
        },
      },
      {
        name: 'grant inspection and revocation survive broker restart',
        description: 'A recreated broker retains authoritative grant state',
        run: async (value) => {
          let driver = value as CredentialManagementDriver;
          const grant = await issue(driver, 'restart');
          driver = options.recreate(driver);
          const inspected = await driver.inspect(options.createRequest(
            'credential.inspect',
            { grantHandle: grant.grantHandle },
            'restart-inspect',
          ));
          if (inspected?.grantHandle !== grant.grantHandle) {
            throw new Error('grant was not inspectable after restart');
          }
          await driver.revoke(options.createRequest(
            'credential.revoke',
            { grantHandle: grant.grantHandle },
            'restart-revoke',
          ));
          driver = options.recreate(driver);
          if (
            !(await driver.inspect(options.createRequest(
              'credential.inspect',
              { grantHandle: grant.grantHandle },
              'restart-inspect-revoked',
            )))?.revoked
          ) throw new Error('revocation was lost after restart');
        },
      },
      {
        name: 'rejects stale fencing, foreign handles, and session drift',
        description: 'Old controllers and unrelated workers cannot use a grant',
        run: async (value) => {
          const driver = value as CredentialManagementDriver;
          const grant = await issue(driver, 'security', 9);
          let stale = false;
          try {
            await driver.inspect(options.createRequest(
              'credential.inspect',
              { grantHandle: grant.grantHandle },
              'stale',
              8,
            ));
          } catch (error) {
            stale = error instanceof OrchestrationError && error.code === 'STALE_EPOCH';
          }
          if (!stale) throw new Error('stale credential epoch was accepted');
          let foreign = false;
          try {
            await driver.inspect(options.createRequest(
              'credential.inspect',
              { grantHandle: grant.grantHandle },
              'foreign',
              9,
              'foreign-run',
            ));
          } catch (error) {
            foreign = error instanceof OrchestrationError && error.code === 'FORBIDDEN';
          }
          if (!foreign) throw new Error('foreign credential handle was accepted');
          const materialize = options.createRequest(
            'credential.materialize',
            {
              grantHandle: grant.grantHandle,
              targetDriver: 'model-provider/openai',
              proof: {
                challengeId: 'challenge-2',
                signature: 'proof:challenge-2:ed25519:worker-1',
              },
            },
            'wrong-session',
            9,
          );
          materialize.session = {
            id: 'worker-session-2',
            keyFingerprint: 'ed25519:wrong-worker',
          };
          let drift = false;
          try {
            await driver.materialize(materialize);
          } catch (error) {
            drift = error instanceof OrchestrationError && error.code === 'FORBIDDEN';
          }
          if (!drift) throw new Error('unbound worker session was accepted');
        },
      },
    ],
  };
}
