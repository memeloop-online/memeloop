import { OrchestrationError } from '../errors.js';
import type { CredentialBrokerDriver, CredentialGrantClaims, CredentialGrantHandle, CredentialGrantInspection } from '../security/credentialBroker.js';
import { base64UrlDecode } from '../security/modelAccessHandle.js';

import type {
  CredentialIssuePayload,
  CredentialManagementCapabilities,
  CredentialManagementDriver,
  ManagedCredentialGrant,
  ManagedCredentialMaterialization,
} from './credentialManagement.js';
import { assertDriverRequestEnvelope, canonicalDriverValue, type DriverRequestEnvelope } from './driverRequest.js';

interface GrantRecord {
  stableHandle: string;
  token: string;
  resourceUid: string;
  targetDriver: string;
}

interface StoredIdempotency {
  fingerprint: string;
  result: string;
}

export interface ManagedCredentialAdapterStateStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
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
  authorizeRequest(
    request: DriverRequestEnvelope,
  ): boolean | Promise<boolean>;
  /**
   * Trusted host storage for restart adoption. The signed token never enters
   * ControlStore; Electron/Node hosts can back this with their credential vault.
   */
  handleStore?: {
    get(stableHandle: string): Promise<CredentialGrantHandle | undefined>;
    put(stableHandle: string, handle: CredentialGrantHandle): Promise<void>;
    delete(stableHandle: string): Promise<void>;
  };
  /** Durable non-secret fencing, idempotency, and materialization metadata. */
  stateStore?: ManagedCredentialAdapterStateStore;
  stableHandleFor?(request: DriverRequestEnvelope<CredentialIssuePayload>): string;
  threatAssumptions: string[];
}

function invalid(message: string): never {
  throw new OrchestrationError({ code: 'INVALID', message, retryable: false });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'non-Error failure';
}

function corruptState(message: string): never {
  throw new OrchestrationError({
    code: 'INTERNAL',
    message: `credential management state is corrupt: ${message}`,
    retryable: false,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectFields(
  value: unknown,
  allowed: readonly string[],
  location: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`credential ${location} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) {
    invalid(`credential ${location} contains unsupported fields: ${unknown.join(', ')}`);
  }
  return record;
}

function boundedString(
  value: unknown,
  location: string,
  maximum = 2048,
): string {
  if (typeof value !== 'string' || !value || value.length > maximum) {
    invalid(`credential ${location} must be a bounded non-empty string`);
  }
  return value;
}

/**
 * Adapts the existing signed CredentialBroker to the managed protocol.
 * Host persistence requires both the secret handleStore and a non-secret
 * stateStore. A token vault alone can recover a token but cannot preserve
 * fencing, idempotency, or target-materialization revocation metadata.
 */
export function createManagedCredentialBrokerAdapter(
  broker: CredentialBrokerDriver,
  options: ManagedCredentialBrokerAdapterOptions,
): CredentialManagementDriver {
  if (
    !options.name ||
    !Number.isSafeInteger(options.maxTtlMs) ||
    options.maxTtlMs < 1 ||
    !options.threatAssumptions.length ||
    typeof options.authorizeRequest !== 'function'
  ) invalid('managed credential adapter capabilities are incomplete');
  const now = options.now ?? (() => new Date());
  if (options.stateStore && options.handleStore && !options.stableHandleFor) {
    invalid('host-persistent credential adapters require stableHandleFor');
  }
  const records = new Map<string, GrantRecord>();
  const processState = new Map<string, unknown>();
  let nextHandle = 1;

  const getState = async <T>(key: string): Promise<T | undefined> =>
    (options.stateStore
      ? await options.stateStore.get(key)
      : processState.get(key)) as T | undefined;
  const putState = async (key: string, value: unknown): Promise<void> => {
    if (options.stateStore) await options.stateStore.put(key, value);
    else processState.set(key, value);
  };
  const deleteState = async (key: string): Promise<void> => {
    if (options.stateStore) await options.stateStore.delete(key);
    else processState.delete(key);
  };

  function capabilities(): CredentialManagementCapabilities {
    return {
      name: options.name,
      supportsRenewal: true,
      supportsProofOfPossession: true,
      supportsMaterialization: true,
      supportedExposures: ['worker-visible'],
      maxTtlMs: options.maxTtlMs,
      persistence: options.handleStore && options.stateStore ? 'host' : 'process',
      threatAssumptions: [...options.threatAssumptions],
    };
  }

  async function validate<T>(
    request: DriverRequestEnvelope<T>,
    expectedMethod: string,
  ): Promise<void> {
    assertDriverRequestEnvelope<T>(request, {
      now,
      requireRun: true,
      requireFencing: true,
      requireCapability: true,
      expectedMethod,
    });
    if (!await options.authorizeRequest(request)) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: 'credential management capability was rejected',
        retryable: false,
      });
    }
    const fence = request.fencingEpoch as number;
    const fenceKey = `fence:${request.resource.uid}`;
    const storedFence = await getState<unknown>(fenceKey);
    if (
      storedFence !== undefined &&
      (!Number.isSafeInteger(storedFence) || (storedFence as number) < 0)
    ) {
      corruptState(`invalid fence for resource '${request.resource.uid}'`);
    }
    const current = storedFence as number | undefined ?? 0;
    if (fence < current) {
      throw new OrchestrationError({
        code: 'STALE_EPOCH',
        message: `stale credential fencing epoch ${fence}; current epoch is ${current}`,
        retryable: false,
      });
    }
    if (fence > current) await putState(fenceKey, fence);
  }

  function operationKey(request: DriverRequestEnvelope, operation: string): string {
    return `${request.resource.uid}:${operation}:${request.idempotencyKey}`;
  }

  function inputFingerprint(request: DriverRequestEnvelope): string {
    return canonicalDriverValue({
      resource: request.resource,
      run: request.run,
      actor: request.actor,
      workerKey: request.session?.keyFingerprint,
      payloadSchemaDigest: request.payloadSchemaDigest,
      payload: request.payload,
    });
  }

  async function rememberIdempotency(
    key: string,
    request: DriverRequestEnvelope,
    result: string,
  ): Promise<void> {
    await putState(
      `idempotency:${key}`,
      {
        fingerprint: inputFingerprint(request),
        result,
      } satisfies StoredIdempotency,
    );
  }

  async function previousIdempotency(
    key: string,
    request: DriverRequestEnvelope,
  ): Promise<string | undefined> {
    const stored = await getState<unknown>(`idempotency:${key}`);
    if (
      stored !== undefined &&
      (
        !isRecord(stored) ||
        typeof stored.fingerprint !== 'string' ||
        !stored.fingerprint ||
        typeof stored.result !== 'string' ||
        !stored.result
      )
    ) {
      corruptState(`invalid idempotency record '${key}'`);
    }
    const previous = stored as StoredIdempotency | undefined;
    if (previous && previous.fingerprint !== inputFingerprint(request)) {
      throw new OrchestrationError({
        code: 'CONFLICT',
        message: 'credential idempotency key was reused with different input',
        retryable: false,
      });
    }
    return previous?.result;
  }

  async function materializationHandlesFor(
    grantHandle: string,
  ): Promise<string[]> {
    const stored = await getState<unknown>(
      `grant-materializations:${grantHandle}`,
    );
    if (
      stored !== undefined &&
      (
        !Array.isArray(stored) ||
        stored.some((handle) => typeof handle !== 'string' || !handle)
      )
    ) {
      corruptState(`invalid materialization index for grant '${grantHandle}'`);
    }
    return stored as string[] | undefined ?? [];
  }

  async function getMaterialization(
    handle: string,
  ): Promise<ManagedCredentialMaterialization | undefined> {
    const stored = await getState<unknown>(`materialization:${handle}`);
    if (stored === undefined) return undefined;
    if (
      !isRecord(stored) ||
      stored.materializationHandle !== handle ||
      typeof stored.grantHandle !== 'string' ||
      !stored.grantHandle ||
      typeof stored.resourceUid !== 'string' ||
      !stored.resourceUid ||
      typeof stored.targetDriver !== 'string' ||
      !stored.targetDriver ||
      typeof stored.expiresAt !== 'string' ||
      Number.isNaN(Date.parse(stored.expiresAt))
    ) {
      corruptState(`invalid materialization record '${handle}'`);
    }
    return stored as unknown as ManagedCredentialMaterialization;
  }

  async function getRecord(
    handle: string,
    resourceUid: string,
  ): Promise<GrantRecord> {
    let record = records.get(handle);
    if (!record && options.handleStore) {
      const stored = await options.handleStore.get(handle);
      if (stored) {
        const inspection = await broker.inspect(stored.token);
        if (inspection.grantId !== resourceUid) {
          throw new OrchestrationError({
            code: 'FORBIDDEN',
            message: `managed credential handle '${handle}' belongs to another resource`,
            retryable: false,
          });
        }
        record = {
          stableHandle: handle,
          token: stored.token,
          resourceUid,
          targetDriver: inspection.scope.audience,
        };
        records.set(handle, record);
      }
    }
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
    objectFields(payload, [
      'runRef',
      'workerKey',
      'target',
      'targetMethod',
      'targetDriver',
      'audience',
      'policyDigest',
      'ttlMs',
      'exposure',
    ], 'issue payload');
    objectFields(payload.runRef, [
      'apiVersion',
      'kind',
      'name',
      'uid',
    ], 'runRef');
    if (
      !payload.runRef ||
      !boundedString(payload.runRef.apiVersion, 'runRef.apiVersion', 256) ||
      !boundedString(payload.runRef.kind, 'runRef.kind', 256) ||
      !boundedString(payload.runRef.name, 'runRef.name', 256) ||
      !boundedString(payload.runRef.uid, 'runRef.uid', 256)
    ) invalid('credential payload runRef is required');
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
      boundedString(payload[field], `payload.${field}`);
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
      await validate(request, 'credential.issue');
      assertIssuePayload(request.payload);
      const key = operationKey(request, 'issue');
      const existing = await previousIdempotency(key, request);
      if (existing) {
        const record = await getRecord(existing, request.resource.uid);
        return managed(record, await broker.inspect(record.token));
      }
      const run = request.run as NonNullable<typeof request.run>;
      if (request.payload.runRef.uid !== run.uid) {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: 'credential payload Run identity differs from the envelope',
          retryable: false,
        });
      }
      const stable = options.stableHandleFor?.(request) ?? stableHandle();
      if (!stable || stable.length > 2048) {
        invalid('credential stable handle is empty or too long');
      }
      if (options.handleStore) {
        const adopted = await options.handleStore.get(stable);
        if (adopted) {
          const inspection = await broker.inspect(adopted.token);
          const exact = inspection.grantId === request.resource.uid &&
            canonicalDriverValue(inspection.scope) === canonicalDriverValue({
                runRef: request.payload.runRef,
                attempt: run.attempt,
                workerKey: request.payload.workerKey,
                target: request.payload.target,
                method: request.payload.targetMethod,
                audience: request.payload.audience,
                policyDigest: request.payload.policyDigest,
              });
          if (!exact) {
            throw new OrchestrationError({
              code: 'CONFLICT',
              message: 'stored credential handle scope differs from Issue input',
              retryable: false,
            });
          }
          const adoptedRecord: GrantRecord = {
            stableHandle: stable,
            token: adopted.token,
            resourceUid: request.resource.uid,
            targetDriver: request.payload.targetDriver,
          };
          records.set(stable, adoptedRecord);
          await rememberIdempotency(key, request, stable);
          return managed(adoptedRecord, inspection);
        }
      }
      const issued = await broker.issue({
        runRef: request.payload.runRef,
        attempt: run.attempt,
        workerKey: request.payload.workerKey,
        target: request.payload.target,
        method: request.payload.targetMethod,
        audience: request.payload.audience,
        policyDigest: request.payload.policyDigest,
        ttlMs: request.payload.ttlMs,
        grantId: request.resource.uid,
      });
      const record: GrantRecord = {
        stableHandle: stable,
        token: issued.token,
        resourceUid: request.resource.uid,
        targetDriver: request.payload.targetDriver,
      };
      try {
        await options.handleStore?.put(record.stableHandle, issued);
      } catch (error) {
        broker.revoke(issued.claims.grantId);
        throw new OrchestrationError({
          code: 'UNKNOWN_EFFECT',
          message: 'credential was issued but its trusted handle could not be persisted; the grant was revoked',
          retryable: false,
          details: {
            persistenceError: error instanceof Error ? error.message : String(error),
          },
        });
      }
      records.set(record.stableHandle, record);
      await rememberIdempotency(key, request, record.stableHandle);
      return managed(record, await broker.inspect(record.token));
    },
    async renew(request) {
      await validate(request, 'credential.renew');
      objectFields(request.payload, ['grantHandle', 'ttlMs'], 'renew payload');
      boundedString(request.payload.grantHandle, 'renew grantHandle');
      if (
        !Number.isSafeInteger(request.payload.ttlMs) ||
        request.payload.ttlMs < 1 ||
        request.payload.ttlMs > options.maxTtlMs
      ) invalid(`credential ttlMs must be between 1 and ${options.maxTtlMs}`);
      const record = await getRecord(
        request.payload.grantHandle,
        request.resource.uid,
      );
      const key = operationKey(request, 'renew');
      const previous = await previousIdempotency(key, request);
      if (!previous) {
        const renewed = await broker.renew(record.token, {
          ttlMs: request.payload.ttlMs,
          now,
        });
        await options.handleStore?.put(record.stableHandle, renewed);
        record.token = renewed.token;
        await rememberIdempotency(key, request, record.stableHandle);
      }
      return managed(record, await broker.inspect(record.token));
    },
    async revoke(request) {
      await validate(request, 'credential.revoke');
      objectFields(request.payload, ['grantHandle'], 'revoke payload');
      boundedString(request.payload.grantHandle, 'revoke grantHandle');
      const key = operationKey(request, 'revoke');
      if (await previousIdempotency(key, request)) return;
      let record: GrantRecord;
      try {
        record = await getRecord(
          request.payload.grantHandle,
          request.resource.uid,
        );
      } catch (error) {
        if (error instanceof OrchestrationError && error.code === 'NOT_FOUND') {
          return;
        }
        throw error;
      }
      const inspection = await broker.inspect(record.token);
      broker.revoke(inspection.grantId);
      const materializationHandles = await materializationHandlesFor(
        record.stableHandle,
      );
      for (const materializationHandle of materializationHandles) {
        const materialization = await getMaterialization(materializationHandle);
        if (!materialization) {
          corruptState(
            `grant '${record.stableHandle}' references missing materialization '${materializationHandle}'`,
          );
        }
        if (materialization.grantHandle !== record.stableHandle) {
          corruptState(
            `grant '${record.stableHandle}' references a foreign materialization`,
          );
        }
        await options.revokeMaterialization?.(
          materialization.materializationHandle,
        );
        await deleteState(`materialization:${materializationHandle}`);
      }
      await deleteState(`grant-materializations:${record.stableHandle}`);
      await options.handleStore?.delete(record.stableHandle);
      if (options.handleStore) records.delete(record.stableHandle);
      await rememberIdempotency(key, request, record.stableHandle);
    },
    async inspect(request) {
      await validate(request, 'credential.inspect');
      objectFields(request.payload, ['grantHandle'], 'inspect payload');
      boundedString(request.payload.grantHandle, 'inspect grantHandle');
      let record: GrantRecord;
      try {
        record = await getRecord(
          request.payload.grantHandle,
          request.resource.uid,
        );
      } catch (error) {
        if (error instanceof OrchestrationError && error.code === 'NOT_FOUND') {
          return undefined;
        }
        throw error;
      }
      return managed(record, await broker.inspect(record.token));
    },
    async materialize(request) {
      await validate(request, 'credential.materialize');
      objectFields(
        request.payload,
        ['grantHandle', 'targetDriver', 'proof'],
        'materialize payload',
      );
      objectFields(
        request.payload.proof,
        ['challengeId', 'signature'],
        'materialize proof',
      );
      boundedString(request.payload.grantHandle, 'materialize grantHandle');
      boundedString(request.payload.targetDriver, 'materialize targetDriver');
      const record = await getRecord(
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
      const existing = await previousIdempotency(key, request);
      if (existing) {
        const materialization = await getMaterialization(existing);
        if (materialization) return materialization;
        throw new OrchestrationError({
          code: 'UNKNOWN_EFFECT',
          message: 'credential materialization replay evidence is missing; refusing to repeat the target effect',
          retryable: false,
        });
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
      const collision = await getMaterialization(opaqueHandle);
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
      const grantMaterializationsKey = `grant-materializations:${record.stableHandle}`;
      const existingHandles = await materializationHandlesFor(
        record.stableHandle,
      );
      try {
        await putState(`materialization:${opaqueHandle}`, materialization);
        if (!existingHandles.includes(opaqueHandle)) {
          await putState(grantMaterializationsKey, [...existingHandles, opaqueHandle]);
        }
        await rememberIdempotency(key, request, opaqueHandle);
      } catch (error) {
        let cleanupError: unknown;
        try {
          await options.revokeMaterialization?.(opaqueHandle);
          await deleteState(`materialization:${opaqueHandle}`);
          if (existingHandles.length > 0) {
            await putState(grantMaterializationsKey, existingHandles);
          } else {
            await deleteState(grantMaterializationsKey);
          }
        } catch (cleanupFailure) {
          cleanupError = cleanupFailure;
        }
        throw new OrchestrationError({
          code: 'UNKNOWN_EFFECT',
          message: 'credential materialization completed but its durable revocation metadata could not be persisted',
          retryable: false,
          details: {
            persistenceError: errorMessage(error),
            cleanupSucceeded: cleanupError === undefined &&
              options.revokeMaterialization !== undefined,
            ...(cleanupError !== undefined
              ? {
                cleanupError: errorMessage(cleanupError),
              }
              : {}),
          },
        });
      }
      return materialization;
    },
  };
}
