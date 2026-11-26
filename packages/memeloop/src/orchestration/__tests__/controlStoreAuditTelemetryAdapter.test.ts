import { describe, expect, it } from 'vitest';

import { createAuditTelemetryConformanceSuite } from '../drivers/auditTelemetryManagement.js';
import { createControlStoreAuditTelemetryAdapter } from '../drivers/controlStoreAuditTelemetryAdapter.js';
import { DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';
import { AUDIT_RECORD_API_VERSION, AUDIT_RECORD_KIND, type AuditRecordResource } from '../resources.js';
import { createAuditRecordAuthorizer } from '../security/auditRecordAuthorizer.js';
import { QuorumControlStore } from '../stores/quorumControlStore.js';

const now = () => new Date('2026-07-26T12:00:00.000Z');

function request<T>(
  method: string,
  payload: T,
  idempotencyKey: string,
  fencingEpoch = 1,
  resourceUid = 'audit-uid-1',
  actorKind: 'controller' | 'verifier' | 'admin' = 'controller',
): DriverRequestEnvelope<T> {
  return {
    apiVersion: DRIVER_REQUEST_API_VERSION,
    method,
    resource: {
      apiVersion: 'audit.memeloop.io/v1alpha1',
      kind: 'AuditStream',
      name: resourceUid,
      uid: resourceUid,
      generation: 1,
    },
    fencingEpoch,
    requestId: `${method}:${idempotencyKey}`,
    idempotencyKey,
    deadline: '2026-07-26T12:01:00.000Z',
    actor: { id: `${actorKind}/audit`, kind: actorKind },
    session: { id: 'audit-session' },
    capabilityHandleRef: 'capability:audit',
    trace: { traceId: 'audit-trace', spanId: idempotencyKey },
    payloadSchemaDigest: `sha256:${'c'.repeat(64)}`,
    payload,
  };
}

function store(memberId: string): QuorumControlStore {
  return new QuorumControlStore({
    memberId,
    voters: [memberId],
    authorizer: { authorize: createAuditRecordAuthorizer() },
  });
}

function driver(
  controlStore: QuorumControlStore,
  name = 'node-audit',
  maxRecordsPerResource = 10_000,
) {
  return createControlStoreAuditTelemetryAdapter({
    store: controlStore,
    name,
    now,
    maxRecordsPerResource,
    persistence: 'host',
    authorizeRequest: (value) =>
      value.capabilityHandleRef === 'capability:audit' &&
      value.session?.id === 'audit-session',
    threatAssumptions: [
      'the ControlStore, append lease, controller request factory, and host clock are trusted',
    ],
  });
}

describe('ControlStore production Audit/Telemetry adapter', () => {
  it('passes the durable management conformance suite', async () => {
    const durableStore = store('audit-durable');
    const quotaStore = store('audit-quota');
    const suite = createAuditTelemetryConformanceSuite({
      createRequest: request,
      recreate: () => driver(durableStore),
      createQuotaDriver: () => driver(quotaStore, 'quota-audit', 1),
    });
    const durable = driver(durableStore);
    for (const test of suite.tests) await test.run(durable);

    const records = await durableStore.list({
      apiVersion: AUDIT_RECORD_API_VERSION,
      kind: AUDIT_RECORD_KIND,
    });
    expect(records.items.length).toBeGreaterThanOrEqual(5);
    expect(
      (records.items as AuditRecordResource[]).every(
        (record) =>
          !JSON.stringify(record).includes('capability:audit') &&
          record.spec.recordDigest.startsWith('sha256:'),
      ),
    ).toBe(true);
  });

  it('rejects direct mutation and an invalid managed capability', async () => {
    const controlStore = store('audit-protection');
    const managed = driver(controlStore);
    await expect(managed.appendAudit({
      ...request(
        'audit.append',
        {
          policyDigest: `sha256:${'a'.repeat(64)}`,
          effect: 'security' as const,
          provenance: {
            source: 'gateway' as const,
            producer: 'worker-gateway',
          },
          action: 'worker.request',
          outcome: 'success' as const,
        },
        'bad-capability',
      ),
      capabilityHandleRef: 'capability:forged',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const record = await managed.appendAudit(request(
      'audit.append',
      {
        policyDigest: `sha256:${'a'.repeat(64)}`,
        effect: 'security' as const,
        provenance: {
          source: 'gateway' as const,
          producer: 'worker-gateway',
        },
        action: 'worker.request',
        outcome: 'success' as const,
      },
      'protected',
    ));
    const name = record.recordHandle.slice('audit-record:'.length);
    const current = await controlStore.get({
      apiVersion: AUDIT_RECORD_API_VERSION,
      kind: AUDIT_RECORD_KIND,
      name,
    });
    await expect(controlStore.updateStatus(
      { id: 'admin/audit', kind: 'admin' },
      {
        apiVersion: AUDIT_RECORD_API_VERSION,
        kind: AUDIT_RECORD_KIND,
        name,
      },
      { phase: 'rewritten' },
      { resourceVersion: current!.metadata.resourceVersion },
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('serializes concurrent appenders sharing a durable stream', async () => {
    const controlStore = store('audit-concurrency');
    const first = driver(controlStore, 'shared-audit');
    const second = driver(controlStore, 'shared-audit');
    const common = {
      policyDigest: `sha256:${'a'.repeat(64)}`,
      effect: 'security' as const,
      provenance: {
        source: 'controller' as const,
        producer: 'concurrency-test',
      },
      outcome: 'success' as const,
    };
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 ? first : second).appendAudit(request(
          'audit.append',
          { ...common, action: `concurrent-${index}` },
          `concurrent-${index}`,
        ))),
    );
    const read = await first.readRecords(request(
      'audit.read',
      { afterSequence: 0, limit: 100 },
      'concurrent-read',
    ));
    expect(read.records).toHaveLength(12);
    expect(read.records.map((record) => record.sequence)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(read.chainHead).toMatch(/^sha256:/);
  });
});
