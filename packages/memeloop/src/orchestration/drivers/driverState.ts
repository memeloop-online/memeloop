import type { ControlStoreActor } from '../controlStore.js';
import { OrchestrationError } from '../errors.js';

import { assertDriverRequestEnvelope, canonicalDriverValue, type DriverRequestEnvelope } from './driverRequest.js';

/**
 * Validate the common envelope and advance an in-memory per-resource fence.
 * Durable/CAS-backed adapters must keep authorization and fence updates in
 * their own atomic storage path rather than using this helper.
 */
export function assertFencedDriverRequestEnvelope<TPayload>(
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
  assertDriverRequestEnvelope<TPayload>(request, {
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

  const epoch = request.fencingEpoch as number;
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

export interface DriverIdempotencyMaps {
  idempotency: Map<string, string>;
  idempotencyFingerprints: Map<string, string>;
}

export function driverOperationKey(
  request: DriverRequestEnvelope,
  operation: string,
): string {
  return `${request.resource.uid}:${operation}:${request.idempotencyKey}`;
}

/**
 * Return the result handle for an exact replay and reject payload drift.
 * The fingerprint map is deliberately separate from result storage so a
 * missing/corrupt fingerprint fails closed instead of silently replaying.
 */
export function findIdempotentDriverHandle(
  state: DriverIdempotencyMaps,
  request: DriverRequestEnvelope,
  operation: string,
  driverName: string,
): string | undefined {
  const key = driverOperationKey(request, operation);
  const handle = state.idempotency.get(key);
  if (handle === undefined) return undefined;
  if (state.idempotencyFingerprints.get(key) !== canonicalDriverValue(request.payload)) {
    throw new OrchestrationError({
      code: 'CONFLICT',
      message: `${driverName} ${operation} idempotency key was reused with different input`,
      retryable: false,
    });
  }
  return handle;
}

export function rememberIdempotentDriverHandle(
  state: DriverIdempotencyMaps,
  request: DriverRequestEnvelope,
  operation: string,
  handle: string,
): void {
  const key = driverOperationKey(request, operation);
  state.idempotency.set(key, handle);
  state.idempotencyFingerprints.set(key, canonicalDriverValue(request.payload));
}

export function getOwnedDriverValue<T extends { resourceUid: string }>(
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
