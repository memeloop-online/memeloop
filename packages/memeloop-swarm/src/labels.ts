/**
 * Swarm label keys and runtime annotation keys for the memeloop Swarm driver.
 *
 * All Swarm services created by this driver carry `io.memeloop.*` labels so
 * the control plane can list/filter them without touching other services.
 */

/** Set on every service managed by this driver. */
export const LABEL_MANAGED_BY = 'io.memeloop.managed-by';
/** `AgentWorkload` or `ToolOperation`. */
export const LABEL_RESOURCE_KIND = 'io.memeloop.resource-kind';
export const LABEL_WORKLOAD_UID = 'io.memeloop.workload.uid';
export const LABEL_WORKLOAD_NAME = 'io.memeloop.workload.name';
export const LABEL_WORKLOAD_NAMESPACE = 'io.memeloop.workload.namespace';
export const LABEL_OPERATION_UID = 'io.memeloop.operation.uid';
export const LABEL_OPERATION_NAME = 'io.memeloop.operation.name';
export const LABEL_OPERATION_NAMESPACE = 'io.memeloop.operation.namespace';
/** Carries ToolOperation `spec.idempotencyKey` for adopt-before-create. */
export const LABEL_IDEMPOTENCY_KEY = 'io.memeloop.operation.idempotency-key';

/** Value of {@link LABEL_MANAGED_BY} for every memeloop-managed service. */
export const MANAGED_BY_VALUE = 'memeloop';

/**
 * Workload runtime annotations (on `metadata.annotations`).
 *
 * The AgentWorkload spec is intentionally portable and does not name a
 * container image; the minimal documented mapping is:
 *
 * - `memeloop.io/runtime-image` (required): container image reference.
 * - `memeloop.io/runtime-command`: JSON string array, e.g. `["node","loop.mjs"]`.
 * - `memeloop.io/runtime-env`: JSON object of environment variables.
 * - `memeloop.io/runtime-cpu`: decimal CPU cores reserved/limited, e.g. `"0.5"`.
 * - `memeloop.io/runtime-memory`: memory bytes reserved/limited, e.g. `"536870912"`.
 */
export const ANNOTATION_RUNTIME_IMAGE = 'memeloop.io/runtime-image';
export const ANNOTATION_RUNTIME_COMMAND = 'memeloop.io/runtime-command';
export const ANNOTATION_RUNTIME_ENV = 'memeloop.io/runtime-env';
export const ANNOTATION_RUNTIME_CPU = 'memeloop.io/runtime-cpu';
export const ANNOTATION_RUNTIME_MEMORY = 'memeloop.io/runtime-memory';

export const ENV_WORKLOAD = 'MEMELOOP_WORKLOAD';
export const ENV_WORKLOAD_SCRIPT = 'MEMELOOP_WORKLOAD_SCRIPT';
export const ENV_WORKER_BOOTSTRAP_FILE = 'MEMELOOP_WORKER_BOOTSTRAP_FILE';
export const WORKER_BOOTSTRAP_PATH = '/run/secrets/memeloop-bootstrap.json';

/**
 * Sanitize an arbitrary value into a valid Docker/K8s-style label value:
 * lowercase alphanumerics plus `-_.`, max 63 chars.
 */
export function sanitizeLabelValue(value: string): string {
  const cleaned = value.replaceAll(/[^a-zA-Z0-9\-_.]/g, '-');
  return cleaned.length > 63 ? cleaned.slice(0, 63) : cleaned;
}

/**
 * Sanitize a resource name into a valid Swarm service / DNS-style name:
 * lowercase alphanumerics plus `-`, max 63 chars.
 */
export function sanitizeResourceName(value: string): string {
  const cleaned = value.toLowerCase().replaceAll(/[^a-z0-9-]/g, '-').replaceAll(/^-+|-+$/g, '');
  const trimmed = cleaned.length > 52 ? cleaned.slice(0, 52) : cleaned;
  return trimmed.length > 0 ? trimmed : 'unnamed';
}

/** Short deterministic suffix derived from a resource UID. */
export function uidSuffix(uid: string): string {
  return sanitizeResourceName(uid).slice(0, 8) || 'nouid';
}

/** Deterministic service name for an AgentWorkload: `ml-wl-<name>-<uid8>`. */
export function workloadServiceName(name: string, uid: string): string {
  return `ml-wl-${sanitizeResourceName(name)}-${uidSuffix(uid)}`;
}

/** Deterministic service name for a ToolOperation: `ml-op-<name>-<uid8>`. */
export function toolOperationServiceName(name: string, uid: string): string {
  return `ml-op-${sanitizeResourceName(name)}-${uidSuffix(uid)}`;
}
