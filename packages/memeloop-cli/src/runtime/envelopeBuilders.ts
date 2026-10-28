import { createHash, randomBytes } from 'node:crypto';

import { type ControlStoreActor, DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope, OrchestrationError } from 'memeloop';

/**
 * The part of an orchestration resource that is safe to copy into a driver
 * request. Keeping this projection here prevents each runtime adapter from
 * accidentally forwarding mutable spec/status fields as identity.
 */
export interface RuntimeResourceIdentity {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    uid: string;
    generation: number;
  };
}

export interface DriverRunIdentity {
  uid: string;
  attempt: number;
}

export interface DriverRequestBuilderContext {
  actor: ControlStoreActor;
  sessionId?: string;
  capabilityHandleRef?: string;
  /** The default lifetime applied when an adapter does not specify one. */
  deadlineMs?: number;
  /** Stable namespace for diagnostics in invalid fencing errors. */
  controller?: string;
}

export interface DriverRequestBuilderInput<TPayload> {
  method: string;
  payload: TPayload;
  resource: RuntimeResourceIdentity;
  /** Override the default controller actor for a specific policy operation. */
  actor?: ControlStoreActor;
  run?: DriverRunIdentity;
  fencingEpoch?: number | string;
  idempotencyKey: string;
  /** A precomputed digest is used by credential payloads with a fixed schema. */
  payloadSchemaDigest?: string;
  /** Otherwise the schema digest is derived from these method fields. */
  payloadSchema?: {
    apiVersion?: string;
    fields: readonly string[];
  };
  deadlineMs?: number;
  sessionKeyFingerprint?: string;
}

export interface DriverRequestBuilder extends DriverRequestBuilderContext {
  <TPayload>(input: DriverRequestBuilderInput<TPayload>): DriverRequestEnvelope<TPayload>;
}

/** Stable JSON-compatible representation used for driver policy digests. */
export function sha256DriverValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalDriverValue(value)).digest('hex')}`;
}

/** Stable canonical representation shared by digests and idempotency helpers. */
export function canonicalDriverValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalDriverValue).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => `${JSON.stringify(key)}:${canonicalDriverValue(item)}`)
        .join(',')
    }}`;
  }
  return JSON.stringify(value) ?? typeof value;
}

/** Convert a full resource into the strict identity object accepted by drivers. */
export function toDriverResourceIdentity(
  resource: RuntimeResourceIdentity,
): DriverRequestEnvelope['resource'] {
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    name: resource.metadata.name,
    uid: resource.metadata.uid,
    generation: resource.metadata.generation,
  };
}

/**
 * Validate a controller fencing epoch once at the adapter boundary. All
 * managed routes use this helper so malformed epochs fail closed uniformly.
 */
export function positiveLeaseEpoch(leaseEpoch: number | string, controller: string): number {
  const epoch = typeof leaseEpoch === 'number' ? leaseEpoch : Number(leaseEpoch);
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: `${controller} controller lease epoch '${String(leaseEpoch)}' is not a positive safe integer`,
      retryable: false,
    });
  }
  return epoch;
}

function requestId(method: string): string {
  return `${method}:${randomBytes(16).toString('hex')}`;
}

function trace() {
  return {
    traceId: randomBytes(16).toString('hex'),
    spanId: randomBytes(8).toString('hex'),
  };
}

/**
 * Build the common v1alpha1 driver envelope. Adapter-specific modules only
 * provide an immutable resource projection, payload and policy inputs; they
 * no longer duplicate request/session/fencing/trace construction.
 */
export function createDriverRequestBuilder(
  context: DriverRequestBuilderContext,
): DriverRequestBuilder {
  const controller = context.controller ?? 'runtime';
  return Object.assign(
    <TPayload>(input: DriverRequestBuilderInput<TPayload>): DriverRequestEnvelope<TPayload> => {
      const deadlineMs = input.deadlineMs ?? context.deadlineMs ?? 60_000;
      if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: `${controller} driver request deadline must be a positive finite duration`,
          retryable: false,
        });
      }
      const payloadSchemaDigest = input.payloadSchemaDigest ?? (
        input.payloadSchema
          ? sha256DriverValue({
            apiVersion: input.payloadSchema.apiVersion ?? `drivers.memeloop.io/${input.method}/v1alpha1`,
            fields: [...input.payloadSchema.fields],
          })
          : undefined
      );
      if (!payloadSchemaDigest) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: `${controller} driver request payload schema digest is required`,
          retryable: false,
        });
      }
      const fencingEpoch = input.fencingEpoch === undefined
        ? undefined
        : positiveLeaseEpoch(input.fencingEpoch, controller);
      const session = context.sessionId === undefined
        ? undefined
        : {
          id: context.sessionId,
          ...(input.sessionKeyFingerprint === undefined
            ? {}
            : { keyFingerprint: input.sessionKeyFingerprint }),
        };
      return {
        apiVersion: DRIVER_REQUEST_API_VERSION,
        method: input.method,
        resource: toDriverResourceIdentity(input.resource),
        ...(input.run === undefined ? {} : { run: input.run }),
        ...(fencingEpoch === undefined ? {} : { fencingEpoch }),
        requestId: requestId(input.method),
        idempotencyKey: input.idempotencyKey,
        deadline: new Date(Date.now() + deadlineMs).toISOString(),
        actor: input.actor ?? context.actor,
        ...(session === undefined ? {} : { session }),
        ...(context.capabilityHandleRef === undefined
          ? {}
          : { capabilityHandleRef: context.capabilityHandleRef }),
        trace: trace(),
        payloadSchemaDigest,
        payload: input.payload,
      };
    },
    context,
  );
}
