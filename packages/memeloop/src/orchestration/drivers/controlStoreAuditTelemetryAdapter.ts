import type { ControlLeaseGrant, ControlStore } from '../controlStore.js';
import { OrchestrationError } from '../errors.js';
import { AUDIT_RECORD_API_VERSION, AUDIT_RECORD_KIND, type AuditRecordResource, type AuditRecordSpec, createAuditRecordManifest } from '../resources.js';
import { containsSecrets } from '../security/secretRedaction.js';

import {
  type AuditEffect,
  type AuditProvenance,
  type AuditTelemetryManagementDriver,
  type AuditTelemetryRecord,
  type AuditTelemetryRecordKind,
} from './auditTelemetryManagement.js';
import { assertDriverRequestEnvelope, canonicalDriverValue, type DriverRequestEnvelope } from './driverRequest.js';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const FORBIDDEN_ATTRIBUTE = /(?:secret|token|password|credential|authorization|cookie|private[-_]?key)/i;
const RECORD_KINDS: AuditTelemetryRecordKind[] = [
  'audit',
  'event',
  'metric',
  'trace',
];

interface CommonRecordPayload {
  policyDigest: string;
  effect: AuditEffect;
  provenance: AuditProvenance;
  attributes?: Record<string, string>;
}

export interface ControlStoreAuditTelemetryAdapterOptions {
  store: ControlStore;
  name: string;
  authorizeRequest(
    request: DriverRequestEnvelope,
  ): boolean | Promise<boolean>;
  now?: () => Date;
  maxRecordsPerResource?: number;
  maxAttributes?: number;
  persistence: 'host' | 'external';
  threatAssumptions: string[];
}

function invalid(message: string): never {
  throw new OrchestrationError({
    code: 'INVALID',
    message,
    retryable: false,
  });
}

function boundedString(
  value: unknown,
  field: string,
  maximum = 256,
): string {
  if (typeof value !== 'string' || !value || value.length > maximum) {
    invalid(`managed audit ${field} is invalid`);
  }
  return value;
}

function exactFields(
  value: unknown,
  allowed: readonly string[],
  location: string,
): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`managed audit ${location} must be an object`);
  }
  const unknown = Object.keys(value).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) {
    invalid(
      `managed audit ${location} contains unsupported fields: ${unknown.join(', ')}`,
    );
  }
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalDriverValue(value));
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${
    [...new Uint8Array(result)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  }`;
}

function recordName(idempotencyDigest: string): string {
  return `audit-${idempotencyDigest.slice('sha256:'.length, 62)}`;
}

function publicRecord(resource: AuditRecordResource): AuditTelemetryRecord {
  const spec = resource.spec;
  return {
    sequence: spec.sequence,
    recordHandle: `audit-record:${resource.metadata.name}`,
    resourceUid: spec.resourceUid,
    kind: spec.recordKind,
    receivedAt: spec.receivedAt,
    actor: structuredClone(spec.actor),
    policyDigest: spec.policyDigest,
    capabilityDigest: spec.capabilityDigest,
    effect: spec.effect,
    provenance: structuredClone(spec.provenance),
    attributes: structuredClone(spec.attributes),
    data: structuredClone(spec.data),
    ...(spec.previousDigest ? { previousDigest: spec.previousDigest } : {}),
    recordDigest: spec.recordDigest,
  };
}

/**
 * ControlStore-backed production audit sink. A short ControlStore lease
 * serializes a named stream across processes; immutable AuditRecord resources
 * retain idempotency, fencing, quota, and hash-chain evidence across restarts.
 */
export function createControlStoreAuditTelemetryAdapter(
  options: ControlStoreAuditTelemetryAdapterOptions,
): AuditTelemetryManagementDriver {
  const now = options.now ?? (() => new Date());
  const maxRecordsPerResource = options.maxRecordsPerResource ?? 10_000;
  const maxAttributes = options.maxAttributes ?? 16;
  const stream = boundedString(options.name, 'stream name', 128);
  const holderNonce = new Uint8Array(16);
  globalThis.crypto.getRandomValues(holderNonce);
  const holder = `${stream}-${
    [...holderNonce]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  }`;
  const leaseName = `audit-${stream}`
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 253);
  if (
    !options.threatAssumptions.length ||
    !Number.isSafeInteger(maxRecordsPerResource) ||
    maxRecordsPerResource < 1 ||
    !Number.isSafeInteger(maxAttributes) ||
    maxAttributes < 1
  ) invalid('managed audit adapter options are invalid');

  async function listStream(): Promise<AuditRecordResource[]> {
    const result = await options.store.list<AuditRecordSpec>({
      apiVersion: AUDIT_RECORD_API_VERSION,
      kind: AUDIT_RECORD_KIND,
    });
    return (result.items as AuditRecordResource[])
      .filter((item) => item.spec.stream === stream)
      .sort((left, right) => left.spec.sequence - right.spec.sequence);
  }

  async function acquire(
    actor: DriverRequestEnvelope['actor'],
    deadline: string,
  ): Promise<ControlLeaseGrant> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 100 && now().getTime() < Date.parse(deadline); attempt += 1) {
      try {
        return await options.store.acquireLease(actor, {
          name: leaseName,
          holder,
          ttlMs: 5000,
        });
      } catch (error) {
        lastError = error;
        if (
          !(error instanceof OrchestrationError) ||
          error.code !== 'CONFLICT'
        ) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
    throw lastError instanceof OrchestrationError
      ? lastError
      : new OrchestrationError({
        code: 'TIMEOUT',
        message: 'managed audit append lock timed out',
        retryable: true,
      });
  }

  async function authorized<T>(
    request: DriverRequestEnvelope<T>,
    method: string,
    fields: string[],
  ): Promise<void> {
    exactFields(request.payload, fields, `${method} payload`);
    assertDriverRequestEnvelope(request, {
      now,
      requireFencing: true,
      requireCapability: true,
      expectedMethod: method,
    });
    if (!await options.authorizeRequest(request)) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: 'managed audit capability was rejected',
        retryable: false,
      });
    }
  }

  function common(payload: CommonRecordPayload): {
    policyDigest: string;
    effect: AuditEffect;
    provenance: AuditProvenance;
    attributes: Record<string, string>;
  } {
    if (!SHA256.test(boundedString(payload.policyDigest, 'policyDigest', 80))) {
      invalid('managed audit policyDigest must be canonical');
    }
    if (
      ![
        'read',
        'create',
        'update',
        'delete',
        'execute',
        'decision',
        'security',
      ].includes(payload.effect)
    ) invalid('managed audit effect is invalid');
    const provenance = payload.provenance;
    if (
      !provenance ||
      ![
        'controller',
        'gateway',
        'driver',
        'worker',
        'operator',
      ].includes(provenance.source)
    ) invalid('managed audit provenance is invalid');
    boundedString(provenance.producer, 'provenance producer');
    if (provenance.subject !== undefined) {
      boundedString(provenance.subject, 'provenance subject');
    }
    const attributes = payload.attributes ?? {};
    if (Object.keys(attributes).length > maxAttributes) {
      invalid('managed audit attribute quota exceeded');
    }
    for (const [key, value] of Object.entries(attributes)) {
      if (
        !key ||
        key.length > 64 ||
        FORBIDDEN_ATTRIBUTE.test(key) ||
        typeof value !== 'string' ||
        value.length > 256 ||
        containsSecrets({ [key]: value })
      ) invalid(`managed audit attribute '${key}' is invalid or sensitive`);
    }
    return {
      policyDigest: payload.policyDigest,
      effect: payload.effect,
      provenance: structuredClone(provenance),
      attributes: structuredClone(attributes),
    };
  }

  async function verify(
    records: AuditRecordResource[],
  ): Promise<string | undefined> {
    let previousDigest: string | undefined;
    let sequence = 0;
    for (const resource of records) {
      const spec = resource.spec;
      sequence += 1;
      if (
        spec.sequence !== sequence ||
        spec.previousDigest !== previousDigest
      ) {
        throw new OrchestrationError({
          code: 'INTERNAL',
          message: `managed audit chain is broken at sequence ${spec.sequence}`,
          retryable: false,
        });
      }
      const { recordDigest, ...unsigned } = spec;
      if (recordDigest !== await digest(unsigned)) {
        throw new OrchestrationError({
          code: 'INTERNAL',
          message: `managed audit record ${spec.sequence} failed integrity verification`,
          retryable: false,
        });
      }
      previousDigest = spec.recordDigest;
    }
    return previousDigest;
  }

  async function append(
    request: DriverRequestEnvelope<CommonRecordPayload>,
    recordKind: AuditTelemetryRecordKind,
    data: AuditTelemetryRecord['data'],
  ): Promise<AuditTelemetryRecord> {
    const metadata = common(request.payload);
    const requestFingerprint = await digest(request.payload);
    const idempotencyDigest = await digest({
      stream,
      resourceUid: request.resource.uid,
      method: request.method,
      idempotencyKey: request.idempotencyKey,
    });
    const name = recordName(idempotencyDigest);
    const lease = await acquire(request.actor, request.deadline);
    try {
      const records = await listStream();
      const chainHead = await verify(records);
      const existing = records.find(
        (item) => item.spec.idempotencyDigest === idempotencyDigest,
      );
      if (existing) {
        if (existing.spec.requestFingerprint !== requestFingerprint) {
          throw new OrchestrationError({
            code: 'CONFLICT',
            message: 'managed audit idempotency key was reused with different input',
            retryable: false,
          });
        }
        return publicRecord(existing);
      }
      const currentFence = records
        .filter((item) => item.spec.resourceUid === request.resource.uid)
        .reduce(
          (maximum, item) => Math.max(maximum, item.spec.fencingEpoch),
          0,
        );
      if ((request.fencingEpoch as number) < currentFence) {
        throw new OrchestrationError({
          code: 'STALE_EPOCH',
          message: `stale managed audit fencing epoch ${request.fencingEpoch}; current epoch is ${currentFence}`,
          retryable: false,
        });
      }
      const resourceCount = records.filter(
        (item) => item.spec.resourceUid === request.resource.uid,
      ).length;
      if (resourceCount >= maxRecordsPerResource) {
        throw new OrchestrationError({
          code: 'EXHAUSTED',
          message: `managed audit quota of ${maxRecordsPerResource} records was exceeded`,
          retryable: false,
        });
      }
      const unsigned = {
        sequence: records.length + 1,
        resourceUid: request.resource.uid,
        recordKind,
        receivedAt: now().toISOString(),
        actor: {
          id: request.actor.id,
          kind: request.actor.kind,
        },
        ...metadata,
        capabilityDigest: await digest(request.capabilityHandleRef),
        data,
        ...(chainHead ? { previousDigest: chainHead } : {}),
      };
      const unsignedSpec = {
        stream,
        ...unsigned,
        requestFingerprint,
        idempotencyDigest,
        fencingEpoch: request.fencingEpoch as number,
      };
      const spec: AuditRecordSpec = {
        ...unsignedSpec,
        recordDigest: await digest(unsignedSpec),
      };
      const created = await options.store.create<AuditRecordSpec>(
        request.actor,
        createAuditRecordManifest(name, spec),
        { idempotencyKey: `audit-record:${idempotencyDigest}` },
      ) as AuditRecordResource;
      return publicRecord(created);
    } finally {
      await options.store.releaseLease(request.actor, lease).catch(() => undefined);
    }
  }

  return {
    async getCapabilities() {
      return {
        name: stream,
        recordKinds: RECORD_KINDS,
        appendOnly: true,
        trustedReceiverTime: true,
        tamperEvident: true,
        maxRecordsPerResource,
        maxAttributes,
        persistence: options.persistence,
        threatAssumptions: [...options.threatAssumptions],
      };
    },
    async appendAudit(request) {
      await authorized(request, 'audit.append', [
        'policyDigest',
        'effect',
        'provenance',
        'attributes',
        'action',
        'outcome',
        'reasonCode',
      ]);
      const action = boundedString(request.payload.action, 'action');
      if (!['success', 'denied', 'failure'].includes(request.payload.outcome)) {
        invalid('managed audit outcome is invalid');
      }
      if (request.payload.reasonCode !== undefined) {
        boundedString(request.payload.reasonCode, 'reasonCode');
      }
      return append(request, 'audit', {
        kind: 'audit',
        action,
        outcome: request.payload.outcome,
        ...(request.payload.reasonCode
          ? { reasonCode: request.payload.reasonCode }
          : {}),
      });
    },
    async emitEvent(request) {
      await authorized(request, 'telemetry.emit-event', [
        'policyDigest',
        'effect',
        'provenance',
        'attributes',
        'name',
        'severity',
      ]);
      const name = boundedString(request.payload.name, 'event name');
      if (
        !['debug', 'info', 'warning', 'error', 'critical'].includes(
          request.payload.severity,
        )
      ) invalid('managed audit event severity is invalid');
      return append(request, 'event', {
        kind: 'event',
        name,
        severity: request.payload.severity,
      });
    },
    async emitMetric(request) {
      await authorized(request, 'telemetry.emit-metric', [
        'policyDigest',
        'effect',
        'provenance',
        'attributes',
        'name',
        'value',
        'unit',
      ]);
      const name = boundedString(request.payload.name, 'metric name');
      const unit = boundedString(request.payload.unit, 'metric unit', 64);
      if (!Number.isFinite(request.payload.value)) {
        invalid('managed audit metric value must be finite');
      }
      return append(request, 'metric', {
        kind: 'metric',
        name,
        value: request.payload.value,
        unit,
      });
    },
    async emitTrace(request) {
      await authorized(request, 'telemetry.emit-trace', [
        'policyDigest',
        'effect',
        'provenance',
        'attributes',
        'name',
        'traceId',
        'spanId',
        'durationMs',
        'status',
      ]);
      const name = boundedString(request.payload.name, 'trace name');
      const traceId = boundedString(
        request.payload.traceId,
        'traceId',
        128,
      );
      const spanId = boundedString(request.payload.spanId, 'spanId', 128);
      if (
        !Number.isFinite(request.payload.durationMs) ||
        request.payload.durationMs < 0
      ) invalid('managed audit trace duration must be non-negative');
      if (!['ok', 'error'].includes(request.payload.status)) {
        invalid('managed audit trace status is invalid');
      }
      return append(request, 'trace', {
        kind: 'trace',
        name,
        traceId,
        spanId,
        durationMs: request.payload.durationMs,
        status: request.payload.status,
      });
    },
    async readRecords(request) {
      await authorized(request, 'audit.read', [
        'afterSequence',
        'limit',
        'kinds',
      ]);
      const afterSequence = request.payload.afterSequence ?? 0;
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        invalid('managed audit afterSequence is invalid');
      }
      if (
        !Number.isSafeInteger(request.payload.limit) ||
        request.payload.limit < 1 ||
        request.payload.limit > 100
      ) invalid('managed audit read limit must be between 1 and 100');
      const kinds = request.payload.kinds;
      if (
        kinds !== undefined &&
        (
          !Array.isArray(kinds) ||
          kinds.some((kind) => !RECORD_KINDS.includes(kind))
        )
      ) invalid('managed audit record kind filter is invalid');
      const records = await listStream();
      const chainHead = await verify(records);
      const currentFence = records
        .filter((item) => item.spec.resourceUid === request.resource.uid)
        .reduce(
          (maximum, item) => Math.max(maximum, item.spec.fencingEpoch),
          0,
        );
      if ((request.fencingEpoch as number) < currentFence) {
        throw new OrchestrationError({
          code: 'STALE_EPOCH',
          message: `stale managed audit fencing epoch ${request.fencingEpoch}; current epoch is ${currentFence}`,
          retryable: false,
        });
      }
      return {
        records: records
          .filter((item) =>
            item.spec.resourceUid === request.resource.uid &&
            item.spec.sequence > afterSequence &&
            (!kinds || kinds.includes(item.spec.recordKind))
          )
          .slice(0, request.payload.limit)
          .map(publicRecord),
        ...(chainHead ? { chainHead } : {}),
      };
    },
  };
}
