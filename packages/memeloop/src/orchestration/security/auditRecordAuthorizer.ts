import type { ControlStoreAuthorizationRequest } from '../controlStore.js';
import { OrchestrationError } from '../errors.js';
import { AUDIT_RECORD_KIND, type AuditRecordSpec } from '../resources.js';
import { containsSecrets } from './secretRedaction.js';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const FORBIDDEN_ATTRIBUTE = /(?:secret|token|password|credential|authorization|cookie|private[-_]?key)/i;
const SPEC_FIELDS = new Set([
  'stream',
  'sequence',
  'resourceUid',
  'recordKind',
  'receivedAt',
  'actor',
  'policyDigest',
  'capabilityDigest',
  'effect',
  'provenance',
  'attributes',
  'data',
  'previousDigest',
  'recordDigest',
  'requestFingerprint',
  'idempotencyDigest',
  'fencingEpoch',
]);

function forbidden(message: string): never {
  throw new OrchestrationError({
    code: 'FORBIDDEN',
    message,
    retryable: false,
  });
}

/**
 * Enforce AuditRecord append-only semantics in the protected ControlStore
 * write transaction. Only the actor stamped into immutable evidence may
 * create it; no status, apply, delete, or resource lease mutation is valid.
 */
export function createAuditRecordAuthorizer(): (
  request: ControlStoreAuthorizationRequest,
) => void {
  return (request) => {
    if (request.reference.kind !== AUDIT_RECORD_KIND) return;
    if (request.verb !== 'create') {
      forbidden('AuditRecord resources are append-only');
    }
    const spec = request.proposedResource?.spec as AuditRecordSpec | undefined;
    const attributes = spec?.attributes;
    const attributeEntries = attributes &&
        typeof attributes === 'object' &&
        !Array.isArray(attributes)
      ? Object.entries(attributes)
      : [];
    const data = spec?.data as Record<string, unknown> | undefined;
    const expectedDataFields = data?.kind === 'audit'
      ? ['kind', 'action', 'outcome', 'reasonCode']
      : data?.kind === 'event'
      ? ['kind', 'name', 'severity']
      : data?.kind === 'metric'
      ? ['kind', 'name', 'value', 'unit']
      : data?.kind === 'trace'
      ? ['kind', 'name', 'traceId', 'spanId', 'durationMs', 'status']
      : [];
    const dataMatchesKind = Boolean(
      data &&
        data.kind === spec?.recordKind &&
        Object.keys(data).every((field) => expectedDataFields.includes(field)) &&
        (
          (data.kind === 'audit' &&
            typeof data.action === 'string' &&
            ['success', 'denied', 'failure'].includes(String(data.outcome))) ||
          (data.kind === 'event' &&
            typeof data.name === 'string' &&
            ['debug', 'info', 'warning', 'error', 'critical'].includes(
              String(data.severity),
            )) ||
          (data.kind === 'metric' &&
            typeof data.name === 'string' &&
            typeof data.value === 'number' &&
            Number.isFinite(data.value) &&
            typeof data.unit === 'string') ||
          (data.kind === 'trace' &&
            typeof data.name === 'string' &&
            typeof data.traceId === 'string' &&
            typeof data.spanId === 'string' &&
            typeof data.durationMs === 'number' &&
            Number.isFinite(data.durationMs) &&
            data.durationMs >= 0 &&
            ['ok', 'error'].includes(String(data.status)))
        ),
    );
    if (
      !spec ||
      Object.keys(spec).some((field) => !SPEC_FIELDS.has(field)) ||
      spec.actor?.id !== request.actor.id ||
      spec.actor?.kind !== request.actor.kind ||
      !spec.stream ||
      spec.stream.length > 128 ||
      !Number.isSafeInteger(spec.sequence) ||
      spec.sequence < 1 ||
      !spec.resourceUid ||
      Number.isNaN(Date.parse(spec.receivedAt)) ||
      !['audit', 'event', 'metric', 'trace'].includes(spec.recordKind) ||
      !dataMatchesKind ||
      Object.values(data ?? {}).some(
        (value) => typeof value === 'string' && value.length > 256,
      ) ||
      !spec.provenance ||
      !['controller', 'gateway', 'driver', 'worker', 'operator'].includes(
        spec.provenance.source,
      ) ||
      !spec.provenance.producer ||
      spec.provenance.producer.length > 256 ||
      (spec.provenance.subject !== undefined &&
        (
          typeof spec.provenance.subject !== 'string' ||
          !spec.provenance.subject ||
          spec.provenance.subject.length > 256
        )) ||
      ![
        'read',
        'create',
        'update',
        'delete',
        'execute',
        'decision',
        'security',
      ].includes(spec.effect) ||
      !attributes ||
      typeof attributes !== 'object' ||
      Array.isArray(attributes) ||
      attributeEntries.length > 64 ||
      attributeEntries.some(([key, value]) =>
        !key ||
        key.length > 64 ||
        FORBIDDEN_ATTRIBUTE.test(key) ||
        typeof value !== 'string' ||
        value.length > 256 ||
        containsSecrets({ [key]: value })
      ) ||
      !Number.isSafeInteger(spec.fencingEpoch) ||
      spec.fencingEpoch < 1 ||
      !SHA256.test(spec.policyDigest) ||
      !SHA256.test(spec.capabilityDigest) ||
      !SHA256.test(spec.recordDigest) ||
      !SHA256.test(spec.requestFingerprint) ||
      !SHA256.test(spec.idempotencyDigest) ||
      (spec.previousDigest !== undefined && !SHA256.test(spec.previousDigest)) ||
      request.reference.name !==
        `audit-${spec.idempotencyDigest.slice('sha256:'.length, 62)}`
    ) {
      forbidden('AuditRecord creation evidence is invalid');
    }
  };
}
