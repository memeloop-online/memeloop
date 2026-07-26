import { OrchestrationError } from '../errors.js';
import { containsSecrets } from '../security/secretRedaction.js';

import type { DriverConformanceSuite } from './driverConformance.js';
import { assertDriverRequestEnvelope, type DriverRequestEnvelope } from './driverRequest.js';

export type AuditTelemetryRecordKind = 'audit' | 'event' | 'metric' | 'trace';
export type AuditEffect =
  | 'read'
  | 'create'
  | 'update'
  | 'delete'
  | 'execute'
  | 'decision'
  | 'security';

export interface AuditTelemetryCapabilities {
  name: string;
  recordKinds: AuditTelemetryRecordKind[];
  appendOnly: true;
  trustedReceiverTime: true;
  tamperEvident: true;
  maxRecordsPerResource: number;
  maxAttributes: number;
  persistence: 'process' | 'host' | 'external';
  threatAssumptions: string[];
}

export interface AuditProvenance {
  source: 'controller' | 'gateway' | 'driver' | 'worker' | 'operator';
  producer: string;
  subject?: string;
}

export interface AuditTelemetryRecord {
  sequence: number;
  recordHandle: string;
  resourceUid: string;
  kind: AuditTelemetryRecordKind;
  receivedAt: string;
  actor: { id: string; kind: 'controller' | 'verifier' | 'admin' };
  policyDigest: string;
  capabilityDigest: string;
  effect: AuditEffect;
  provenance: AuditProvenance;
  attributes: Record<string, string>;
  data:
    | {
      kind: 'audit';
      action: string;
      outcome: 'success' | 'denied' | 'failure';
      reasonCode?: string;
    }
    | {
      kind: 'event';
      name: string;
      severity: 'debug' | 'info' | 'warning' | 'error' | 'critical';
    }
    | {
      kind: 'metric';
      name: string;
      value: number;
      unit: string;
    }
    | {
      kind: 'trace';
      name: string;
      traceId: string;
      spanId: string;
      durationMs: number;
      status: 'ok' | 'error';
    };
  previousDigest?: string;
  recordDigest: string;
}

interface CommonRecordPayload {
  policyDigest: string;
  effect: AuditEffect;
  provenance: AuditProvenance;
  attributes?: Record<string, string>;
}

export interface AuditTelemetryManagementDriver {
  getCapabilities(): Promise<AuditTelemetryCapabilities>;
  appendAudit(
    request: DriverRequestEnvelope<
      CommonRecordPayload & {
        action: string;
        outcome: 'success' | 'denied' | 'failure';
        reasonCode?: string;
      }
    >,
  ): Promise<AuditTelemetryRecord>;
  emitEvent(
    request: DriverRequestEnvelope<
      CommonRecordPayload & {
        name: string;
        severity: 'debug' | 'info' | 'warning' | 'error' | 'critical';
      }
    >,
  ): Promise<AuditTelemetryRecord>;
  emitMetric(
    request: DriverRequestEnvelope<
      CommonRecordPayload & {
        name: string;
        value: number;
        unit: string;
      }
    >,
  ): Promise<AuditTelemetryRecord>;
  emitTrace(
    request: DriverRequestEnvelope<
      CommonRecordPayload & {
        name: string;
        traceId: string;
        spanId: string;
        durationMs: number;
        status: 'ok' | 'error';
      }
    >,
  ): Promise<AuditTelemetryRecord>;
  readRecords(
    request: DriverRequestEnvelope<{
      afterSequence?: number;
      limit: number;
      kinds?: AuditTelemetryRecordKind[];
    }>,
  ): Promise<{ records: AuditTelemetryRecord[]; chainHead?: string }>;
}

export interface FakeAuditTelemetryState {
  records: AuditTelemetryRecord[];
  idempotency: Map<string, number>;
  idempotencyFingerprints: Map<string, string>;
  fences: Map<string, number>;
  appendTail: Promise<void>;
}

export function createFakeAuditTelemetryState(): FakeAuditTelemetryState {
  return {
    records: [],
    idempotency: new Map(),
    idempotencyFingerprints: new Map(),
    fences: new Map(),
    appendTail: Promise.resolve(),
  };
}

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const FORBIDDEN_ATTRIBUTE = /(?:secret|token|password|credential|authorization|cookie|private[-_]?key)/i;

function invalid(message: string): never {
  throw new OrchestrationError({ code: 'INVALID', message, retryable: false });
}

function stable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
        .join(',')
    }}`;
  }
  return JSON.stringify(value) ?? typeof value;
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stable(value));
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${
    [...new Uint8Array(result)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  }`;
}

function requiredString(value: unknown, field: string, maximum = 256): string {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as Record<string, unknown>)[field] !== 'string'
  ) invalid(`audit payload '${field}' is required`);
  const result = (value as Record<string, string>)[field];
  if (!result || result.length > maximum) {
    invalid(`audit payload '${field}' must contain at most ${maximum} characters`);
  }
  return result;
}

/**
 * Durable-state, append-only reference sink. It deliberately accepts only
 * bounded metadata, never arbitrary log payloads or worker-supplied timestamps.
 */
export function createFakeAuditTelemetryManagementDriver(options: {
  state?: FakeAuditTelemetryState;
  now?: () => Date;
  maxRecordsPerResource?: number;
  maxAttributes?: number;
} = {}): AuditTelemetryManagementDriver {
  const state = options.state ?? createFakeAuditTelemetryState();
  const now = options.now ?? (() => new Date());
  const maxRecordsPerResource = options.maxRecordsPerResource ?? 10_000;
  const maxAttributes = options.maxAttributes ?? 16;

  function validate<T>(
    request: DriverRequestEnvelope<T>,
    expectedMethod: string,
    actorKinds: Array<'controller' | 'verifier' | 'admin'>,
  ): void {
    assertDriverRequestEnvelope(request, {
      now,
      requireFencing: true,
      requireCapability: true,
      expectedMethod,
    });
    if (!actorKinds.includes(request.actor.kind)) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `actor kind '${request.actor.kind}' cannot call ${expectedMethod}`,
        retryable: false,
      });
    }
    const epoch = request.fencingEpoch as number;
    const current = state.fences.get(request.resource.uid) ?? 0;
    if (epoch < current) {
      throw new OrchestrationError({
        code: 'STALE_EPOCH',
        message: `stale audit fencing epoch ${epoch}; current epoch is ${current}`,
        retryable: false,
      });
    }
    state.fences.set(request.resource.uid, epoch);
  }

  function common(request: DriverRequestEnvelope<CommonRecordPayload>): {
    policyDigest: string;
    effect: AuditEffect;
    provenance: AuditProvenance;
    attributes: Record<string, string>;
  } {
    const policyDigest = requiredString(request.payload, 'policyDigest', 80);
    if (!SHA256.test(policyDigest)) invalid('audit policyDigest must be canonical');
    const effect = request.payload.effect;
    if (!['read', 'create', 'update', 'delete', 'execute', 'decision', 'security'].includes(effect)) {
      invalid('audit effect is invalid');
    }
    const provenance = request.payload.provenance;
    if (!provenance || !['controller', 'gateway', 'driver', 'worker', 'operator'].includes(provenance.source)) {
      invalid('audit provenance source is invalid');
    }
    requiredString(provenance, 'producer');
    if (provenance.subject !== undefined) requiredString(provenance, 'subject');
    const attributes = request.payload.attributes ?? {};
    const entries = Object.entries(attributes);
    if (entries.length > maxAttributes) invalid('audit attribute quota exceeded');
    for (const [key, value] of entries) {
      if (
        !key ||
        key.length > 64 ||
        FORBIDDEN_ATTRIBUTE.test(key) ||
        typeof value !== 'string' ||
        value.length > 256 ||
        containsSecrets({ [key]: value })
      ) invalid(`audit attribute '${key}' is invalid or sensitive`);
    }
    return {
      policyDigest,
      effect,
      provenance: structuredClone(provenance),
      attributes: structuredClone(attributes),
    };
  }

  async function append(
    request: DriverRequestEnvelope<CommonRecordPayload>,
    kind: AuditTelemetryRecordKind,
    data: AuditTelemetryRecord['data'],
  ): Promise<AuditTelemetryRecord> {
    const idempotencyKey = `${request.resource.uid}:${request.method}:${request.idempotencyKey}`;
    const fingerprint = stable(request.payload);
    let release!: () => void;
    const previousAppend = state.appendTail;
    state.appendTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previousAppend;
    try {
      const existingSequence = state.idempotency.get(idempotencyKey);
      if (existingSequence !== undefined) {
        if (state.idempotencyFingerprints.get(idempotencyKey) !== fingerprint) {
          throw new OrchestrationError({
            code: 'CONFLICT',
            message: 'audit idempotency key was reused with different input',
            retryable: false,
          });
        }
        return structuredClone(state.records[existingSequence - 1]);
      }
      const count = state.records.reduce(
        (total, record) => total + Number(record.resourceUid === request.resource.uid),
        0,
      );
      if (count >= maxRecordsPerResource) {
        throw new OrchestrationError({
          code: 'EXHAUSTED',
          message: `audit quota of ${maxRecordsPerResource} records was exceeded`,
          retryable: false,
        });
      }
      const metadata = common(request);
      const previousDigest = state.records.at(-1)?.recordDigest;
      const sequence = state.records.length + 1;
      const unsigned = {
        sequence,
        recordHandle: `audit-record:${sequence}`,
        resourceUid: request.resource.uid,
        kind,
        receivedAt: now().toISOString(),
        actor: {
          id: request.actor.id,
          kind: request.actor.kind,
        },
        ...metadata,
        capabilityDigest: await digest(request.capabilityHandleRef),
        data,
        ...(previousDigest ? { previousDigest } : {}),
      };
      const record: AuditTelemetryRecord = {
        ...unsigned,
        recordDigest: await digest(unsigned),
      };
      state.records.push(record);
      state.idempotency.set(idempotencyKey, sequence);
      state.idempotencyFingerprints.set(idempotencyKey, fingerprint);
      return structuredClone(record);
    } finally {
      release();
    }
  }

  return {
    async getCapabilities() {
      return {
        name: 'fake-audit-telemetry',
        recordKinds: ['audit', 'event', 'metric', 'trace'],
        appendOnly: true,
        trustedReceiverTime: true,
        tamperEvident: true,
        maxRecordsPerResource,
        maxAttributes,
        persistence: 'host',
        threatAssumptions: [
          'the injected state, host clock, and authenticated receiver are trusted',
        ],
      };
    },
    async appendAudit(request) {
      validate(request, 'audit.append', ['controller', 'verifier', 'admin']);
      const action = requiredString(request.payload, 'action');
      const outcome = request.payload.outcome;
      if (!['success', 'denied', 'failure'].includes(outcome)) {
        invalid('audit outcome is invalid');
      }
      const reasonCode = request.payload.reasonCode;
      if (reasonCode !== undefined) requiredString(request.payload, 'reasonCode');
      return append(request, 'audit', {
        kind: 'audit',
        action,
        outcome,
        ...(reasonCode ? { reasonCode } : {}),
      });
    },
    async emitEvent(request) {
      validate(request, 'telemetry.emit-event', ['controller', 'verifier', 'admin']);
      const name = requiredString(request.payload, 'name');
      const severity = request.payload.severity;
      if (!['debug', 'info', 'warning', 'error', 'critical'].includes(severity)) {
        invalid('event severity is invalid');
      }
      return append(request, 'event', { kind: 'event', name, severity });
    },
    async emitMetric(request) {
      validate(request, 'telemetry.emit-metric', ['controller', 'verifier', 'admin']);
      const name = requiredString(request.payload, 'name');
      const unit = requiredString(request.payload, 'unit', 64);
      if (!Number.isFinite(request.payload.value)) invalid('metric value must be finite');
      return append(request, 'metric', {
        kind: 'metric',
        name,
        value: request.payload.value,
        unit,
      });
    },
    async emitTrace(request) {
      validate(request, 'telemetry.emit-trace', ['controller', 'verifier', 'admin']);
      const name = requiredString(request.payload, 'name');
      const traceId = requiredString(request.payload, 'traceId', 128);
      const spanId = requiredString(request.payload, 'spanId', 128);
      if (
        !Number.isFinite(request.payload.durationMs) ||
        request.payload.durationMs < 0
      ) invalid('trace durationMs must be a non-negative finite number');
      if (!['ok', 'error'].includes(request.payload.status)) invalid('trace status is invalid');
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
      validate(request, 'audit.read', ['controller', 'verifier', 'admin']);
      const afterSequence = request.payload.afterSequence ?? 0;
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        invalid('audit afterSequence is invalid');
      }
      if (
        !Number.isSafeInteger(request.payload.limit) ||
        request.payload.limit < 1 ||
        request.payload.limit > 100
      ) invalid('audit read limit must be between 1 and 100');
      const kinds = request.payload.kinds;
      if (
        kinds !== undefined &&
        (!Array.isArray(kinds) ||
          kinds.some((kind) => !['audit', 'event', 'metric', 'trace'].includes(kind)))
      ) invalid('audit record kind filter is invalid');
      let previousDigest: string | undefined;
      for (const record of state.records) {
        if (record.previousDigest !== previousDigest) {
          throw new OrchestrationError({
            code: 'INTERNAL',
            message: `audit chain is broken at sequence ${record.sequence}`,
            retryable: false,
          });
        }
        const { recordDigest, ...unsigned } = record;
        if (recordDigest !== await digest(unsigned)) {
          throw new OrchestrationError({
            code: 'INTERNAL',
            message: `audit record ${record.sequence} failed integrity verification`,
            retryable: false,
          });
        }
        previousDigest = recordDigest;
      }
      const records = state.records
        .filter((record) =>
          record.resourceUid === request.resource.uid &&
          record.sequence > afterSequence &&
          (!kinds || kinds.includes(record.kind))
        )
        .slice(0, request.payload.limit)
        .map((record) => structuredClone(record));
      return { records, chainHead: state.records.at(-1)?.recordDigest };
    },
  };
}

export function createAuditTelemetryConformanceSuite(options: {
  createRequest<T>(
    method: string,
    payload: T,
    idempotencyKey: string,
    fencingEpoch?: number,
    resourceUid?: string,
    actorKind?: 'controller' | 'verifier' | 'admin',
  ): DriverRequestEnvelope<T>;
  recreate(driver: AuditTelemetryManagementDriver): AuditTelemetryManagementDriver;
  createQuotaDriver(): AuditTelemetryManagementDriver;
}): DriverConformanceSuite {
  const policyDigest = `sha256:${'a'.repeat(64)}`;
  const common = {
    policyDigest,
    effect: 'security' as const,
    provenance: {
      source: 'gateway' as const,
      producer: 'worker-gateway',
      subject: 'worker/session-1',
    },
    attributes: { runUid: 'run-1' },
  };
  return {
    interfaceKind: 'audit-telemetry',
    tests: [
      {
        name: 'declares append-only, trusted-time, tamper-evident persistence',
        description: 'Audit security and quota capabilities are explicit',
        run: async (value) => {
          const capabilities = await (value as AuditTelemetryManagementDriver)
            .getCapabilities();
          if (
            capabilities.recordKinds.length !== 4 ||
            !capabilities.appendOnly ||
            !capabilities.trustedReceiverTime ||
            !capabilities.tamperEvident ||
            capabilities.maxRecordsPerResource < 1 ||
            !capabilities.threatAssumptions.length
          ) throw new Error('audit capabilities are incomplete');
        },
      },
      {
        name: 'audit binds trusted envelope metadata and receiver time',
        description: 'Workers cannot forge actor, capability, resource, or time',
        run: async (value) => {
          const driver = value as AuditTelemetryManagementDriver;
          const record = await driver.appendAudit(options.createRequest(
            'audit.append',
            {
              ...common,
              action: 'worker.request',
              outcome: 'denied' as const,
              reasonCode: 'FORBIDDEN',
            },
            'audit',
          ));
          if (
            record.receivedAt !== '2026-07-26T12:00:00.000Z' ||
            record.actor.id !== 'controller/audit' ||
            !record.capabilityDigest.startsWith('sha256:') ||
            record.resourceUid !== 'audit-uid-1'
          ) throw new Error('trusted audit metadata is incomplete');
        },
      },
      {
        name: 'event metric and trace are typed while secret-shaped metadata is rejected',
        description: 'Telemetry remains bounded metadata instead of a secret log channel',
        run: async (value) => {
          const driver = value as AuditTelemetryManagementDriver;
          await driver.emitEvent(options.createRequest(
            'telemetry.emit-event',
            { ...common, name: 'worker.denied', severity: 'warning' as const },
            'event',
          ));
          await driver.emitMetric(options.createRequest(
            'telemetry.emit-metric',
            { ...common, name: 'worker.requests', value: 1, unit: 'count' },
            'metric',
          ));
          await driver.emitTrace(options.createRequest(
            'telemetry.emit-trace',
            {
              ...common,
              name: 'gateway.dispatch',
              traceId: 'trace-1',
              spanId: 'span-1',
              durationMs: 5,
              status: 'ok' as const,
            },
            'trace',
          ));
          await driver.emitEvent(options.createRequest(
            'telemetry.emit-event',
            {
              ...common,
              attributes: { message: 'sk-sensitive-value-must-not-enter-audit' },
              name: 'unsafe',
              severity: 'error' as const,
            },
            'secret',
          )).then(
            () => {
              throw new Error('secret-shaped attribute was accepted');
            },
            () => undefined,
          );
        },
      },
      {
        name: 'records survive restart, retry idempotently, and expose a verified chain',
        description: 'Acknowledged records remain immutable and tamper evident',
        run: async (value) => {
          let driver = value as AuditTelemetryManagementDriver;
          const request = options.createRequest(
            'audit.append',
            { ...common, action: 'resource.apply', outcome: 'success' as const },
            'durable',
          );
          const first = await driver.appendAudit(request);
          driver = options.recreate(driver);
          const retry = await driver.appendAudit(request);
          const read = await driver.readRecords(options.createRequest(
            'audit.read',
            { afterSequence: 0, limit: 100 },
            'read',
          ));
          if (
            first.recordHandle !== retry.recordHandle ||
            !read.chainHead ||
            !read.records.some((record) => record.recordHandle === first.recordHandle)
          ) throw new Error('durable audit retry or chain read failed');
        },
      },
      {
        name: 'quota, ownership, idempotency drift, and stale fencing fail closed',
        description: 'Backpressure and distributed isolation are enforced',
        run: async (value) => {
          const driver = value as AuditTelemetryManagementDriver;
          const request = options.createRequest(
            'audit.append',
            { ...common, action: 'security.check', outcome: 'success' as const },
            'isolation',
            3,
          );
          await driver.appendAudit(request);
          await driver.appendAudit({
            ...request,
            payload: { ...request.payload, outcome: 'failure' as const },
          }).then(
            () => {
              throw new Error('audit idempotency drift was accepted');
            },
            () => undefined,
          );
          await driver.readRecords(options.createRequest(
            'audit.read',
            { limit: 10 },
            'foreign',
            3,
            'foreign-audit-uid',
          )).then((result) => {
            if (result.records.length) throw new Error('foreign records were disclosed');
          });
          await driver.appendAudit(options.createRequest(
            'audit.append',
            { ...common, action: 'stale', outcome: 'success' as const },
            'stale',
            2,
          )).then(
            () => {
              throw new Error('stale fencing epoch was accepted');
            },
            () => undefined,
          );
          const quota = options.createQuotaDriver();
          await quota.appendAudit(options.createRequest(
            'audit.append',
            { ...common, action: 'one', outcome: 'success' as const },
            'quota-one',
          ));
          await quota.appendAudit(options.createRequest(
            'audit.append',
            { ...common, action: 'two', outcome: 'success' as const },
            'quota-two',
          )).then(
            () => {
              throw new Error('audit quota was not enforced');
            },
            () => undefined,
          );
        },
      },
    ],
  };
}
