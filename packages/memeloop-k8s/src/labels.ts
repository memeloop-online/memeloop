/**
 * Kubernetes label keys and runtime annotation keys for the memeloop K8s
 * driver. Every Job/Deployment created by the driver carries `memeloop.io/*`
 * labels so the control plane can list/filter them via label selectors
 * without touching other cluster workloads.
 */

/** Set on every object managed by this driver. */
export const LABEL_MANAGED_BY = 'memeloop.io/managed-by';
/** `AgentWorkload` or `ToolOperation`. */
export const LABEL_RESOURCE_KIND = 'memeloop.io/resource-kind';
export const LABEL_WORKLOAD_UID = 'memeloop.io/workload-uid';
export const LABEL_WORKLOAD_NAME = 'memeloop.io/workload-name';
export const LABEL_WORKLOAD_NAMESPACE = 'memeloop.io/workload-namespace';
export const LABEL_OPERATION_UID = 'memeloop.io/operation-uid';
export const LABEL_OPERATION_NAME = 'memeloop.io/operation-name';
export const LABEL_OPERATION_NAMESPACE = 'memeloop.io/operation-namespace';
/** Carries ToolOperation `spec.idempotencyKey` for adopt-before-create. */
export const LABEL_IDEMPOTENCY_KEY = 'memeloop.io/idempotency-key';

/** Value of {@link LABEL_MANAGED_BY} for every memeloop-managed object. */
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
 * - `memeloop.io/runtime-cpu`: decimal CPU cores, e.g. `"0.5"` (maps to both
 *   resource requests and limits).
 * - `memeloop.io/runtime-memory`: memory bytes, e.g. `"536870912"` (maps to
 *   both resource requests and limits).
 */
export const ANNOTATION_RUNTIME_IMAGE = 'memeloop.io/runtime-image';
export const ANNOTATION_RUNTIME_COMMAND = 'memeloop.io/runtime-command';
export const ANNOTATION_RUNTIME_ENV = 'memeloop.io/runtime-env';
export const ANNOTATION_RUNTIME_CPU = 'memeloop.io/runtime-cpu';
export const ANNOTATION_RUNTIME_MEMORY = 'memeloop.io/runtime-memory';

/** Environment variable carrying the serialized ToolOperation payload. */
export const ENV_TOOL_OPERATION = 'MEMELOOP_TOOL_OPERATION';
/** Environment variable carrying the serialized AgentWorkload identity. */
export const ENV_WORKLOAD = 'MEMELOOP_WORKLOAD';

/**
 * Sanitize an arbitrary value into a valid Kubernetes label value: at most 63
 * characters of alphanumerics plus `-_.`, starting and ending alphanumeric.
 * Non-conforming characters are replaced with `-`.
 */
export function sanitizeLabelValue(value: string): string {
  let cleaned = value.replaceAll(/[^a-zA-Z0-9\-_.]/g, '-');
  if (cleaned.length > 63) cleaned = cleaned.slice(0, 63);
  cleaned = cleaned.replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9]+$/, '');
  return cleaned.length > 0 ? cleaned : 'unknown';
}

/**
 * Sanitize a resource name into a DNS-1123 subdomain (valid Job/Deployment
 * name): lowercase alphanumerics plus `-`, max 63 chars.
 */
export function sanitizeDnsName(value: string): string {
  const cleaned = value.toLowerCase().replaceAll(/[^a-z0-9-]/g, '-').replaceAll(/^-+|-+$/g, '');
  const trimmed = cleaned.length > 52 ? cleaned.slice(0, 52) : cleaned;
  return trimmed.length > 0 ? trimmed : 'unnamed';
}

/** Short deterministic suffix derived from a resource UID. */
export function uidSuffix(uid: string): string {
  return sanitizeDnsName(uid).slice(0, 8) || 'nouid';
}

/** Deterministic workload object name: `ml-wl-<name>-<uid8>`. */
export function workloadObjectName(name: string, uid: string): string {
  return `ml-wl-${sanitizeDnsName(name)}-${uidSuffix(uid)}`;
}

/** Deterministic tool-operation Job name: `ml-op-<name>-<uid8>`. */
export function toolOperationJobName(name: string, uid: string): string {
  return `ml-op-${sanitizeDnsName(name)}-${uidSuffix(uid)}`;
}
