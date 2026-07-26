import { OrchestrationError } from '../errors.js';
import type { CredentialBrokerDriver, CredentialGrantClaims, CredentialGrantInspection } from '../security/credentialBroker.js';
import { base64UrlDecode } from '../security/modelAccessHandle.js';

import type {
  CredentialIssuePayload,
  CredentialManagementCapabilities,
  CredentialManagementDriver,
  ManagedCredentialGrant,
  ManagedCredentialMaterialization,
} from './credentialManagement.js';
import { assertDriverRequestEnvelope, type DriverRequestEnvelope } from './driverRequest.js';

interface GrantRecord {
  stableHandle: string;
  token: string;
  resourceUid: string;
  targetDriver: string;
}

export interface ManagedCredentialBrokerAdapterOptions {
  name: string;
  maxTtlMs: number;
  now?: () => Date;
  /**
   * Resolve the verified grant inside a trusted target driver. The returned
   * value must be an opaque reference, never raw credential material.
   */
  materialize(
    claims: CredentialGrantClaims,
    targetDriver: string,
  ): Promise<string>;
  revokeMaterialization?(handle: string): Promise<void>;
  threatAssumptions: string[];
}

function invalid(message: string): never {
  throw new OrchestrationError({ code: 'INVALID', message, retryable: false });
}

/**
 * Adapts the existing signed CredentialBroker to the managed protocol.
 * Stable-handle/idempotency state is process-local, so this adapter refuses to
 * advertise durable persistence even when its signer is externally backed.
 */
export function createManagedCredentialBrokerAdapter(
  broker: CredentialBrokerDriver,
  options: ManagedCredentialBrokerAdapterOptions,
): CredentialManagementDriver {
  if (
    !options.name ||
    !Number.isSafeInteger(options.maxTtlMs) ||
    options.maxTtlMs < 1 ||
    !options.threatAssumptions.length
  ) invalid('managed credential adapter capabilities are incomplete');
  const now = options.now ?? (() => new Date());
  const records = new Map<string, GrantRecord>();
  const idempotency = new Map<string, string>();
  const fences = new Map<string, number>();
  const materializations = new Map<string, ManagedCredentialMaterialization>();
  let nextHandle = 1;

  function capabilities(): CredentialManagementCapabilities {
    return {
      name: options.name,
      supportsRenewal: true,
      supportsProofOfPossession: true,
      supportsMaterialization: true,
      supportedExposures: ['worker-visible'],
      maxTtlMs: options.maxTtlMs,
      persistence: 'process',
      threatAssumptions: [...options.threatAssumptions],
    };
  }

  function validate<T>(
    request: DriverRequestEnvelope<T>,
    expectedMethod: string,
  ): void {
    assertDriverRequestEnvelope<T>(request, {
      now,
      requireRun: true,
      requireFencing: true,
      requireCapability: true,
      expectedMethod,
    });
    if (request.resource.uid !== request.run?.uid) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: 'credential envelope resource and Run identity differ',
        retryable: false,
      });
    }
    const fence = request.fencingEpoch as number;
    const current = fences.get(request.resource.uid) ?? 0;
    if (fence < current) {
      throw new OrchestrationError({
        code: 'STALE_EPOCH',
        message: `stale credential fencing epoch ${fence}; current epoch is ${current}`,
        retryable: false,
      });
    }
    fences.set(request.resource.uid, fence);
  }

  function operationKey(request: DriverRequestEnvelope, operation: string): string {
    return `${request.resource.uid}:${operation}:${request.idempotencyKey}`;
  }

  function getRecord(handle: string, resourceUid: string): GrantRecord {
    const record = records.get(handle);
    if (!record) {
      throw new OrchestrationError({
        code: 'NOT_FOUND',
        message: `managed credential handle '${handle}' was not found`,
        retryable: false,
      });
    }
    if (record.resourceUid !== resourceUid) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `managed credential handle '${handle}' belongs to another resource`,
        retryable: false,
      });
    }
    return record;
  }

  function stableHandle(): string {
    const handle = `managed-credential:${nextHandle}`;
    nextHandle += 1;
    return handle;
  }

  function assertIssuePayload(payload: CredentialIssuePayload): void {
    for (
      const field of [
        'workerKey',
        'target',
        'targetMethod',
        'targetDriver',
        'audience',
        'policyDigest',
      ] as const
    ) {
      if (!payload[field]) invalid(`credential payload '${field}' is required`);
    }
    if (payload.targetDriver !== payload.audience) {
      invalid('credential targetDriver must equal its intended audience');
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(payload.policyDigest)) {
      invalid('credential policyDigest must be a canonical sha256 digest');
    }
    if (
      !Number.isSafeInteger(payload.ttlMs) ||
      payload.ttlMs < 1 ||
      payload.ttlMs > options.maxTtlMs
    ) invalid(`credential ttlMs must be between 1 and ${options.maxTtlMs}`);
    if (payload.exposure !== 'worker-visible') {
      throw new OrchestrationError({
        code: 'UNSUPPORTED',
        message: 'existing CredentialBroker grants are worker-visible',
        retryable: false,
      });
    }
  }

  function managed(
    record: GrantRecord,
    inspection: CredentialGrantInspection,
  ): ManagedCredentialGrant {
    return {
      grantHandle: record.stableHandle,
      resourceUid: record.resourceUid,
      runUid: inspection.scope.runRef.uid,
      attempt: inspection.scope.attempt,
      workerKey: inspection.scope.workerKey,
      target: inspection.scope.target,
      targetMethod: inspection.scope.method,
      targetDriver: record.targetDriver,
      audience: inspection.scope.audience,
      policyDigest: inspection.scope.policyDigest,
      issuedAt: inspection.issuedAt,
      expiresAt: inspection.expiresAt,
      revoked: inspection.revoked,
      exposure: inspection.exposure,
      rotationRequired: inspection.rotationRequired,
    };
  }

  return {
    async getCapabilities() {
      return capabilities();
    },
    async issue(request) {
      validate(request, 'credential.issue');
      assertIssuePayload(request.payload);
      const key = operationKey(request, 'issue');
      const existing = idempotency.get(key);
      if (existing) {
        const record = getRecord(existing, request.resource.uid);
        return managed(record, await broker.inspect(record.token));
      }
      const run = request.run as NonNullable<typeof request.run>;
      const issued = await broker.issue({
        runRef: {
          apiVersion: request.resource.apiVersion,
          kind: request.resource.kind,
          name: request.resource.name,
          uid: run.uid,
        },
        attempt: run.attempt,
        workerKey: request.payload.workerKey,
        target: request.payload.target,
        method: request.payload.targetMethod,
        audience: request.payload.audience,
        policyDigest: request.payload.policyDigest,
        ttlMs: request.payload.ttlMs,
        grantId: `${request.resource.uid}:${request.idempotencyKey}`,
      });
      const record: GrantRecord = {
        stableHandle: stableHandle(),
        token: issued.token,
        resourceUid: request.resource.uid,
        targetDriver: request.payload.targetDriver,
      };
      records.set(record.stableHandle, record);
      idempotency.set(key, record.stableHandle);
      return managed(record, await broker.inspect(record.token));
    },
    async renew(request) {
      validate(request, 'credential.renew');
      if (
        !Number.isSafeInteger(request.payload.ttlMs) ||
        request.payload.ttlMs < 1 ||
        request.payload.ttlMs > options.maxTtlMs
      ) invalid(`credential ttlMs must be between 1 and ${options.maxTtlMs}`);
      const record = getRecord(
        request.payload.grantHandle,
        request.resource.uid,
      );
      const key = operationKey(request, 'renew');
      if (!idempotency.has(key)) {
        const renewed = await broker.renew(record.token, {
          ttlMs: request.payload.ttlMs,
          now,
        });
        record.token = renewed.token;
        idempotency.set(key, record.stableHandle);
      }
      return managed(record, await broker.inspect(record.token));
    },
    async revoke(request) {
      validate(request, 'credential.revoke');
      const record = records.get(request.payload.grantHandle);
      if (!record) return;
      getRecord(record.stableHandle, request.resource.uid);
      const inspection = await broker.inspect(record.token);
      broker.revoke(inspection.grantId);
      for (const [key, materialization] of materializations) {
        if (materialization.grantHandle !== record.stableHandle) continue;
        await options.revokeMaterialization?.(
          materialization.materializationHandle,
        );
        materializations.delete(key);
      }
    },
    async inspect(request) {
      validate(request, 'credential.inspect');
      const record = records.get(request.payload.grantHandle);
      if (!record) return undefined;
      getRecord(record.stableHandle, request.resource.uid);
      return managed(record, await broker.inspect(record.token));
    },
    async materialize(request) {
      validate(request, 'credential.materialize');
      const record = getRecord(
        request.payload.grantHandle,
        request.resource.uid,
      );
      if (request.payload.targetDriver !== record.targetDriver) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'credential target driver exceeds the grant scope',
          retryable: false,
        });
      }
      if (!request.session?.keyFingerprint) {
        invalid('credential materialization requires a session worker key');
      }
      if (
        !request.payload.proof ||
        typeof request.payload.proof.challengeId !== 'string' ||
        !request.payload.proof.challengeId ||
        typeof request.payload.proof.signature !== 'string' ||
        !request.payload.proof.signature
      ) invalid('credential proof of possession is required');
      const key = operationKey(request, 'materialize');
      const existing = idempotency.get(key);
      if (existing) {
        const materialization = materializations.get(existing);
        if (materialization) return materialization;
      }
      let signature: Uint8Array;
      try {
        signature = base64UrlDecode(request.payload.proof.signature);
      } catch {
        invalid('credential proof signature must be base64url encoded');
      }
      const inspection = await broker.inspect(record.token);
      const claims = await broker.verify(record.token, {
        ...inspection.scope,
        workerKey: request.session.keyFingerprint,
        proof: {
          challengeId: request.payload.proof.challengeId,
          signature,
        },
      });
      const opaqueHandle = await options.materialize(
        claims,
        request.payload.targetDriver,
      );
      if (!opaqueHandle) invalid('credential materializer returned an empty handle');
      const collision = materializations.get(opaqueHandle);
      if (
        collision &&
        (
          collision.grantHandle !== record.stableHandle ||
          collision.targetDriver !== request.payload.targetDriver
        )
      ) {
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: 'credential materializer reused an opaque handle across scopes',
          retryable: false,
        });
      }
      const materialization: ManagedCredentialMaterialization = {
        materializationHandle: opaqueHandle,
        grantHandle: record.stableHandle,
        resourceUid: request.resource.uid,
        targetDriver: request.payload.targetDriver,
        expiresAt: claims.expiresAt,
      };
      materializations.set(opaqueHandle, materialization);
      idempotency.set(key, opaqueHandle);
      return materialization;
    },
  };
}
