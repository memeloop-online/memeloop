import type { ControlStoreActor } from '../controlStore.js';
import { OrchestrationError } from '../errors.js';

import type { DriverConformanceSuite, DriverConformanceTest, DriverManifest } from './driverConformance.js';
import { assertDriverRequestEnvelope, canonicalDriverValue, type DriverRequestEnvelope } from './driverRequest.js';

/** Throw the stable invalid-request error used by driver-specific validators. */
export function managementInvalid(message: string) {
  throw new OrchestrationError({ code: 'INVALID', message, retryable: false });
}

/** State common to every stateful management-driver reference implementation. */
export interface ManagementDriverState<THandle = string> {
  idempotency: Map<string, THandle>;
  idempotencyFingerprints: Map<string, string>;
  fences: Map<string, number>;
}

export interface ManagementDriverContext<THandle = string> {
  /** Validate and fence one request before any driver-specific work starts. */
  validate<TPayload>(
    request: DriverRequestEnvelope<TPayload>,
    expectedMethod: string,
    options?: {
      requireRun?: boolean;
      actorKinds?: readonly ControlStoreActor['kind'][];
      forbiddenMessage?: (actorKind: ControlStoreActor['kind']) => string;
    },
  ): number;
  operationKey(request: DriverRequestEnvelope, operation: string): string;
  replay(
    request: DriverRequestEnvelope,
    operation: string,
  ): THandle | undefined;
  remember(
    request: DriverRequestEnvelope,
    operation: string,
    handle: THandle,
  ): void;
}

/** Transport-neutral identity carried alongside every management response. */
export interface ManagementRequestCorrelation {
  requestId: string;
  method: string;
  resourceUid: string;
  resourceGeneration: number;
}

export interface ManagementResponseEnvelope<TResponse> {
  correlation: ManagementRequestCorrelation;
  response: TResponse;
}

/** Capture the exact request identity before handing work to a driver. */
export function managementRequestCorrelation(
  request: DriverRequestEnvelope,
): ManagementRequestCorrelation {
  return {
    requestId: request.requestId,
    method: request.method,
    resourceUid: request.resource.uid,
    resourceGeneration: request.resource.generation,
  };
}

/** Wrap a result without modifying the driver's resource-specific response type. */
export function managementResponse<TResponse>(
  request: DriverRequestEnvelope,
  response: TResponse,
): ManagementResponseEnvelope<TResponse> {
  return { correlation: managementRequestCorrelation(request), response };
}

/** Reject a response associated with another request or resource generation. */
export function assertManagementResponseCorrelation(
  request: DriverRequestEnvelope,
  correlation: ManagementRequestCorrelation,
): void {
  const expected = managementRequestCorrelation(request);
  if (
    expected.requestId !== correlation.requestId ||
    expected.method !== correlation.method ||
    expected.resourceUid !== correlation.resourceUid ||
    expected.resourceGeneration !== correlation.resourceGeneration
  ) {
    throw new OrchestrationError({
      code: 'CONFLICT',
      message: 'management response does not correlate to the exact request',
      retryable: false,
    });
  }
}

/**
 * Build the shared request/fence/idempotency boundary for a management driver.
 *
 * The context deliberately owns only protocol concerns.  Resource lookup,
 * authorization and lifecycle transitions stay in each driver so a generic
 * helper cannot accidentally grant an operation a broader scope.
 */
export function createManagementDriverContext<THandle = string>(options: {
  state: ManagementDriverState<THandle>;
  now?: () => Date;
  driverName: string;
  requireRun?: boolean;
}): ManagementDriverContext<THandle> {
  const now = options.now ?? (() => new Date());
  function validate<TPayload>(
    request: DriverRequestEnvelope<TPayload>,
    expectedMethod: string,
    validationOptions: {
      requireRun?: boolean;
      actorKinds?: readonly ControlStoreActor['kind'][];
      forbiddenMessage?: (actorKind: ControlStoreActor['kind']) => string;
    } = {},
  ): number {
    return assertFencedManagementRequest(request, {
      now,
      fences: options.state.fences,
      expectedMethod,
      fenceName: options.driverName,
      requireRun: validationOptions.requireRun ?? options.requireRun,
      actorKinds: validationOptions.actorKinds,
      forbiddenMessage: validationOptions.forbiddenMessage,
    });
  }
  return {
    validate,
    operationKey(request, operation) {
      return `${request.resource.uid}:${operation}:${request.idempotencyKey}`;
    },
    replay(request, operation) {
      return findManagementReplay(options.state, request, operation, options.driverName);
    },
    remember(request, operation, handle) {
      rememberManagementReplay(options.state, request, operation, handle);
    },
  };
}

/** Common envelope validation with a stable driver-specific stale-fence error. */
export function assertFencedManagementRequest<TPayload>(
  request: DriverRequestEnvelope<TPayload>,
  options: {
    now?: () => Date;
    fences: Map<string, number>;
    expectedMethod: string;
    fenceName: string;
    requireRun?: boolean;
    actorKinds?: readonly ControlStoreActor['kind'][];
    forbiddenMessage?: (actorKind: ControlStoreActor['kind']) => string;
  },
): number {
  assertDriverRequestEnvelope(request, {
    now: options.now,
    requireRun: options.requireRun,
    requireFencing: true,
    requireCapability: true,
    expectedMethod: options.expectedMethod,
  });

  if (options.actorKinds && !options.actorKinds.includes(request.actor.kind)) {
    throw new OrchestrationError({
      code: 'FORBIDDEN',
      message: options.forbiddenMessage?.(request.actor.kind) ??
        `actor kind '${request.actor.kind}' cannot call ${options.expectedMethod}`,
      retryable: false,
    });
  }

  const epoch = request.fencingEpoch;
  if (epoch === undefined) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: 'management request fencing epoch is required',
      retryable: false,
    });
  }
  const current = options.fences.get(request.resource.uid) ?? 0;
  if (epoch < current) {
    throw new OrchestrationError({
      code: 'STALE_EPOCH',
      message: `stale ${options.fenceName} fencing epoch ${epoch}; current epoch is ${current}`,
      retryable: false,
    });
  }
  options.fences.set(request.resource.uid, epoch);
  return epoch;
}

/** Return a previously committed operation, rejecting every input drift. */
export function findManagementReplay<THandle>(
  state: ManagementDriverState<THandle>,
  request: DriverRequestEnvelope,
  operation: string,
  driverName: string,
): THandle | undefined {
  const key = managementOperationKey(request, operation);
  const handle = state.idempotency.get(key);
  if (handle === undefined) return undefined;
  const fingerprint = canonicalManagementRequest(request);
  const previous = state.idempotencyFingerprints.get(key);
  if (previous === undefined || previous !== fingerprint) {
    throw new OrchestrationError({
      code: 'CONFLICT',
      message: `${driverName} ${operation} idempotency key was reused with different input`,
      retryable: false,
    });
  }
  return handle;
}

/** Persist the complete authority-bearing request fingerprint with the result. */
export function rememberManagementReplay<THandle>(
  state: ManagementDriverState<THandle>,
  request: DriverRequestEnvelope,
  operation: string,
  handle: THandle,
): void {
  const key = managementOperationKey(request, operation);
  state.idempotency.set(key, handle);
  state.idempotencyFingerprints.set(key, canonicalManagementRequest(request));
}

/** Validate durable replay state after deserialization; orphan entries fail closed. */
export function assertManagementReplayState<THandle>(
  state: ManagementDriverState<THandle>,
  driverName: string,
): void {
  for (const key of state.idempotency.keys()) {
    if (!state.idempotencyFingerprints.has(key)) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: `${driverName} replay state is missing a request fingerprint`,
        retryable: false,
      });
    }
  }
  for (const key of state.idempotencyFingerprints.keys()) {
    if (!state.idempotency.has(key)) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: `${driverName} replay state contains an orphan request fingerprint`,
        retryable: false,
      });
    }
  }
}

/** Stable resource/operation/idempotency key shared by every management driver. */
export function managementOperationKey(
  request: DriverRequestEnvelope,
  operation: string,
): string {
  return `${request.resource.uid}:${operation}:${request.idempotencyKey}`;
}

/**
 * Request identity used for retries. Transport-only fields are intentionally
 * excluded, while method/resource/authority/session/capability and payload are
 * all bound so a replay can never cross an authorization or generation edge.
 */
export function canonicalManagementRequest(request: DriverRequestEnvelope): string {
  return canonicalDriverValue({
    apiVersion: request.apiVersion,
    method: request.method,
    resource: request.resource,
    run: request.run,
    fencingEpoch: request.fencingEpoch,
    actor: request.actor,
    session: request.session,
    capabilityHandleRef: request.capabilityHandleRef,
    payloadSchemaDigest: request.payloadSchemaDigest,
    payload: request.payload,
  });
}

/** Stable opaque handle allocator used by the fake durable drivers. */
export function allocateManagementHandle(
  counter: { nextHandle: number },
  prefix: string,
): string {
  const handle = `${prefix}:${counter.nextHandle}`;
  counter.nextHandle += 1;
  return handle;
}

/** Fail-closed payload object check shared by all management drivers. */
export function assertManagementRecord(
  value: unknown,
  driverName: string,
  location: string,
): Record<string, unknown> {
  if (!isManagementRecord(value)) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: `${driverName} ${location} must be an object`,
      retryable: false,
    });
  }
  return value;
}

function isManagementRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reject extensions at payload boundaries instead of silently dropping them. */
export function assertManagementOnlyFields(
  value: unknown,
  allowed: readonly string[],
  driverName: string,
  location: string,
): Record<string, unknown> {
  const record = assertManagementRecord(value, driverName, location);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: `${driverName} ${location} contains unsupported fields: ${unknown.join(', ')}`,
      retryable: false,
    });
  }
  return record;
}

/** Require one bounded non-empty string from a validated payload object. */
export function requireManagementString(
  value: unknown,
  field: string,
  driverName: string,
  maximum = 2048,
): string {
  const record = assertManagementRecord(value, driverName, 'payload');
  const candidate = record[field];
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > maximum) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: `${driverName} payload '${field}' must be a non-empty string of at most ${maximum} characters`,
      retryable: false,
    });
  }
  return candidate;
}

/** Require one bounded positive integer from a validated payload object. */
export function requireManagementPositiveInteger(
  value: unknown,
  field: string,
  driverName: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const record = assertManagementRecord(value, driverName, 'payload');
  const candidate = record[field];
  if (
    typeof candidate !== 'number' ||
    !Number.isSafeInteger(candidate) ||
    candidate < 1 ||
    candidate > maximum
  ) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: `${driverName} payload '${field}' must be a positive safe integer at most ${maximum}`,
      retryable: false,
    });
  }
  return candidate;
}

/** Shared bounded TTL validation and ISO lease timestamps. */
export function managementLease(
  now: () => Date,
  ttlMs: unknown,
  maximum: number,
  driverName: string,
  field = 'ttlMs',
): { issuedAt: string; expiresAt: string; ttlMs: number } {
  if (
    typeof ttlMs !== 'number' ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > maximum
  ) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: `${driverName} ${field} must be between 1 and ${maximum}`,
      retryable: false,
    });
  }
  const issuedAt = now();
  return {
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + ttlMs).toISOString(),
    ttlMs,
  };
}

/** Check a lease at the point of use; expired and revoked handles are denied. */
export function assertManagementLeaseActive(
  lease: { expiresAt: string; revoked?: boolean },
  now: () => Date,
  driverName: string,
  handle: string,
): void {
  if (lease.revoked) {
    throw new OrchestrationError({
      code: 'FORBIDDEN',
      message: `${driverName} lease '${handle}' is revoked`,
      retryable: false,
    });
  }
  if (Date.parse(lease.expiresAt) <= now().getTime()) {
    throw new OrchestrationError({
      code: 'FORBIDDEN',
      message: `${driverName} lease '${handle}' is expired`,
      retryable: false,
    });
  }
}

/** Enforce resource ownership before a handle is replayed or inspected. */
export function getOwnedManagementValue<T extends { resourceUid: string }>(
  collection: Map<string, T>,
  handle: string,
  resourceUid: string,
  kind: string,
): T {
  const value = collection.get(handle);
  if (!value) {
    throw new OrchestrationError({
      code: 'NOT_FOUND',
      message: `${kind} handle '${handle}' was not found`,
      retryable: false,
    });
  }
  if (value.resourceUid !== resourceUid) {
    throw new OrchestrationError({
      code: 'FORBIDDEN',
      message: `${kind} handle '${handle}' belongs to another resource`,
      retryable: false,
    });
  }
  return value;
}

/** Build a typed conformance test without repeating structural object literals. */
export function managementConformanceTest(
  name: string,
  description: string,
  run: DriverConformanceTest['run'],
): DriverConformanceTest {
  return { name, description, run };
}

/** Build a management-driver conformance suite with one canonical shape. */
export function managementConformanceSuite(
  interfaceKind: DriverManifest['kind'],
  tests: readonly DriverConformanceTest[],
): DriverConformanceSuite {
  return { interfaceKind, tests: [...tests] };
}
