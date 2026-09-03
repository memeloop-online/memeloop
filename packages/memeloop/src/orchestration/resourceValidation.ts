import type { OrchestrationResource, OrchestrationResourceStatus } from './client.js';
import { OrchestrationError } from './errors.js';

/**
 * Minimal structural contract shared by every persisted orchestration
 * resource.  A resource-specific guard is still required; this boundary only
 * prevents an untyped ControlStore response from being treated as a resource
 * before its durable identity is checked.
 */
export interface CanonicalOrchestrationResourceShape {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    uid: string;
    generation: number;
    resourceVersion: string;
    creationTimestamp: string;
  };
  spec: Record<string, unknown>;
}

export type CanonicalResourceGuard<T> = (value: unknown) => value is T;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Check the fields that are common to all persisted ControlStore resources. */
export function isCanonicalOrchestrationResource(
  value: unknown,
): value is CanonicalOrchestrationResourceShape {
  if (
    !isRecord(value) || typeof value.apiVersion !== 'string' || !value.apiVersion ||
    typeof value.kind !== 'string' || !value.kind || !isRecord(value.metadata) ||
    !isRecord(value.spec)
  ) {
    return false;
  }
  const metadata = value.metadata;
  return typeof metadata.name === 'string' && metadata.name.length > 0 &&
    typeof metadata.uid === 'string' && metadata.uid.length > 0 &&
    typeof metadata.generation === 'number' && Number.isSafeInteger(metadata.generation) &&
    metadata.generation >= 1 &&
    typeof metadata.resourceVersion === 'string' && metadata.resourceVersion.length > 0 &&
    typeof metadata.creationTimestamp === 'string' &&
    Number.isFinite(Date.parse(metadata.creationTimestamp));
}

/**
 * Validate a ControlStore result against both the common resource shape and a
 * resource-specific guard.  Mismatches fail closed as INVALID instead of
 * relying on a type assertion that could route an unrelated resource into a
 * side-effecting controller.
 */
export function requireCanonicalOrchestrationResource<T>(
  value: unknown,
  guard: CanonicalResourceGuard<T>,
  label: string,
): T {
  if (!isCanonicalOrchestrationResource(value) || !guard(value)) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: `${label} response did not match its canonical resource schema`,
      retryable: false,
    });
  }
  return value;
}

/** Optional-resource form used by get/reconciliation paths. */
export function requireCanonicalOrchestrationResourceOrNull<T>(
  value: unknown,
  guard: CanonicalResourceGuard<T>,
  label: string,
): T | null {
  return value === null || value === undefined
    ? null
    : requireCanonicalOrchestrationResource(value, guard, label);
}

/**
 * Keep readonly clone variance in one place when a typed resource crosses a
 * persistence boundary. structuredClone preserves the concrete generic type;
 * callers must validate untrusted input before invoking this helper.
 */
export function cloneCanonicalOrchestrationResource<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Adapt a validated concrete resource to the broad authorization shape.
 * Object.fromEntries intentionally creates a readonly-independent snapshot so
 * an authorizer cannot mutate the typed resource that will be persisted.
 */
export function toControlStoreAuthorizationResource<TSpec, TStatus extends OrchestrationResourceStatus>(
  value: OrchestrationResource<TSpec, TStatus>,
): OrchestrationResource {
  const spec = value.spec !== null && typeof value.spec === 'object'
    ? Object.fromEntries(Object.entries(value.spec))
    : {};
  const status = value.status === undefined
    ? undefined
    : Object.fromEntries(Object.entries(value.status));
  return {
    ...value,
    spec,
    ...(status === undefined ? {} : { status }),
  };
}
