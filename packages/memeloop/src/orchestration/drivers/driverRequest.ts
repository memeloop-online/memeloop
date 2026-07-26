import type { ControlStoreActor } from '../controlStore.js';
import { OrchestrationError } from '../errors.js';

export const DRIVER_REQUEST_API_VERSION = 'drivers.memeloop.io/v1alpha1';

export interface DriverRequestEnvelope<TPayload = unknown> {
  apiVersion: typeof DRIVER_REQUEST_API_VERSION;
  method: string;
  resource: {
    apiVersion: string;
    kind: string;
    name: string;
    uid: string;
    generation: number;
  };
  run?: {
    uid: string;
    attempt: number;
  };
  fencingEpoch?: number;
  requestId: string;
  idempotencyKey: string;
  deadline: string;
  actor: ControlStoreActor;
  session?: {
    id: string;
    keyFingerprint?: string;
  };
  capabilityHandleRef?: string;
  trace: {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
  };
  payloadSchemaDigest: string;
  payload: TPayload;
}

const TOP_LEVEL_FIELDS = new Set([
  'apiVersion',
  'method',
  'resource',
  'run',
  'fencingEpoch',
  'requestId',
  'idempotencyKey',
  'deadline',
  'actor',
  'session',
  'capabilityHandleRef',
  'trace',
  'payloadSchemaDigest',
  'payload',
]);
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

function invalid(message: string): never {
  throw new OrchestrationError({ code: 'INVALID', message, retryable: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Stable JSON-compatible representation used when a host binds a digest or idempotency key. */
export function canonicalDriverValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalDriverValue).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonicalDriverValue(item)}`)
        .join(',')
    }}`;
  }
  return JSON.stringify(value) ?? typeof value;
}

function assertOnlyFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    invalid(`driver request ${location} contains unsupported fields: ${unknown.join(', ')}`);
  }
}

function requireBoundedString(
  record: Record<string, unknown>,
  key: string,
  maximum = 256,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    return invalid(`driver request '${key}' must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

/**
 * Validate the common §10 driver request envelope before a driver interprets
 * its payload. Unknown top-level fields and newer versions fail closed so an
 * old driver cannot silently weaken policy.
 */
export function assertDriverRequestEnvelope<TPayload = unknown>(
  value: unknown,
  options: {
    now?: () => Date;
    maxFutureDeadlineMs?: number;
    requireRun?: boolean;
    requireFencing?: boolean;
    requireCapability?: boolean;
    expectedMethod?: string;
  } = {},
): asserts value is DriverRequestEnvelope<TPayload> {
  if (!isRecord(value)) invalid('driver request must be an object');
  const unknown = Object.keys(value).filter((key) => !TOP_LEVEL_FIELDS.has(key));
  if (unknown.length > 0) invalid(`driver request contains unsupported fields: ${unknown.join(', ')}`);
  if (value.apiVersion !== DRIVER_REQUEST_API_VERSION) {
    invalid(`unsupported driver request apiVersion '${String(value.apiVersion)}'`);
  }

  const method = requireBoundedString(value, 'method');
  if (options.expectedMethod !== undefined && method !== options.expectedMethod) {
    invalid(`driver request method '${method}' does not match '${options.expectedMethod}'`);
  }
  requireBoundedString(value, 'requestId');
  requireBoundedString(value, 'idempotencyKey');
  const deadlineText = requireBoundedString(value, 'deadline');
  const deadline = Date.parse(deadlineText);
  const currentTime = (options.now ?? (() => new Date()))().getTime();
  if (!Number.isFinite(deadline)) invalid('driver request deadline must be an ISO timestamp');
  if (deadline <= currentTime) {
    throw new OrchestrationError({
      code: 'TIMEOUT',
      message: 'driver request deadline has expired',
      retryable: false,
    });
  }
  if (
    options.maxFutureDeadlineMs !== undefined &&
    deadline - currentTime > options.maxFutureDeadlineMs
  ) {
    invalid('driver request deadline exceeds the allowed window');
  }

  if (!isRecord(value.resource)) invalid('driver request resource identity is required');
  assertOnlyFields(
    value.resource,
    ['apiVersion', 'kind', 'name', 'uid', 'generation'],
    'resource',
  );
  for (const field of ['apiVersion', 'kind', 'name', 'uid'] as const) {
    requireBoundedString(value.resource, field);
  }
  if (
    !Number.isSafeInteger(value.resource.generation) ||
    (value.resource.generation as number) < 1
  ) {
    invalid('driver request resource generation must be a positive safe integer');
  }

  if (options.requireRun && !isRecord(value.run)) invalid('driver request Run identity is required');
  if (value.run !== undefined) {
    if (!isRecord(value.run)) invalid('driver request run must be an object');
    assertOnlyFields(value.run, ['uid', 'attempt'], 'run');
    requireBoundedString(value.run, 'uid');
    if (!Number.isSafeInteger(value.run.attempt) || (value.run.attempt as number) < 1) {
      invalid('driver request run attempt must be a positive safe integer');
    }
  }

  if (options.requireFencing && value.fencingEpoch === undefined) {
    invalid('driver request fencing epoch is required');
  }
  if (
    value.fencingEpoch !== undefined &&
    (typeof value.fencingEpoch !== 'number' ||
      !Number.isSafeInteger(value.fencingEpoch) ||
      value.fencingEpoch < 1)
  ) {
    invalid('driver request fencing epoch must be a positive safe integer');
  }

  if (!isRecord(value.actor)) invalid('driver request actor identity is required');
  assertOnlyFields(value.actor, ['id', 'kind', 'properties'], 'actor');
  requireBoundedString(value.actor, 'id');
  const actorKind = requireBoundedString(value.actor, 'kind');
  if (!['controller', 'verifier', 'admin'].includes(actorKind)) {
    invalid(`driver request actor kind '${actorKind}' is unsupported`);
  }
  if (
    value.actor.properties !== undefined &&
    (!Array.isArray(value.actor.properties) ||
      value.actor.properties.some(
        (property) => typeof property !== 'string' || !property || property.length > 256,
      ))
  ) {
    invalid('driver request actor properties must be bounded non-empty strings');
  }
  if (value.session !== undefined) {
    if (!isRecord(value.session)) invalid('driver request session must be an object');
    assertOnlyFields(value.session, ['id', 'keyFingerprint'], 'session');
    requireBoundedString(value.session, 'id');
    if (value.session.keyFingerprint !== undefined) {
      requireBoundedString(value.session, 'keyFingerprint', 512);
    }
  }
  if (options.requireCapability && value.capabilityHandleRef === undefined) {
    invalid('driver request capability handle is required');
  }
  if (value.capabilityHandleRef !== undefined) {
    requireBoundedString(value, 'capabilityHandleRef', 2048);
  }

  if (!isRecord(value.trace)) invalid('driver request trace context is required');
  assertOnlyFields(value.trace, ['traceId', 'spanId', 'parentSpanId'], 'trace');
  requireBoundedString(value.trace, 'traceId', 128);
  requireBoundedString(value.trace, 'spanId', 128);
  if (value.trace.parentSpanId !== undefined) {
    requireBoundedString(value.trace, 'parentSpanId', 128);
  }
  const digest = requireBoundedString(value, 'payloadSchemaDigest', 80);
  if (!SHA256_DIGEST.test(digest)) {
    invalid('driver request payloadSchemaDigest must be a canonical sha256 digest');
  }
  if (!Object.hasOwn(value, 'payload')) invalid('driver request payload is required');
}
