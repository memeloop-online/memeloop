import { describe, expect, it, vi } from 'vitest';

import type { OrchestrationResource } from '../client.js';
import type { ControlStore } from '../controlStore.js';
import { isIdentityRevoked, promoteIdentity, revokeQuarantineIdentity } from '../security/identityLifecycle.js';
import {
  WORKER_ENROLLMENT_API_VERSION,
  WORKER_ENROLLMENT_KIND,
  WORKER_SESSION_API_VERSION,
  WORKER_SESSION_KIND,
  type WorkerEnrollmentResource,
  type WorkerSessionResource,
} from '../security/workerIdentity.js';

function makeStore(): ControlStore {
  const resources = new Map<string, OrchestrationResource>();
  let resourceVersion = 0;

  return {
    create: vi.fn(async (_actor, manifest) => {
      resourceVersion += 1;
      const resource: OrchestrationResource = {
        ...manifest,
        metadata: {
          ...manifest.metadata,
          name: manifest.metadata.name ?? '',
          uid: `uid-${manifest.metadata.name}`,
          generation: 1,
          resourceVersion: String(resourceVersion),
          creationTimestamp: '2026-07-18T00:00:00.000Z',
        },
      };
      resources.set(manifest.metadata.name ?? '', resource);
      return resource;
    }),
    get: vi.fn(async (reference) => resources.get(reference.name ?? '') ?? null),
    updateStatus: vi.fn(async (_actor, reference, status, _options) => {
      const existing = resources.get(reference.name ?? '');
      if (!existing) throw new Error('not found');
      resourceVersion += 1;
      const updated = {
        ...existing,
        status: status as Record<string, unknown>,
        metadata: { ...existing.metadata, resourceVersion: String(resourceVersion) },
      };
      resources.set(reference.name ?? '', updated);
      return updated;
    }),
    list: vi.fn(async (query) => {
      const items = [...resources.values()].filter((resource) => resource.kind === query.kind);
      return { items };
    }),
    watch: vi.fn(() => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) })),
    delete: vi.fn(async () => ({ deleted: true })),
    acquireLease: vi.fn(async () => ({})),
    renewLease: vi.fn(async () => ({})),
    releaseLease: vi.fn(async () => {}),
    compact: vi.fn(async () => ({})),
    snapshot: vi.fn(async () => ({})),
    getHealth: vi.fn(async () => ({})),
    close: vi.fn(async () => {}),
  } as unknown as ControlStore;
}

function makeEnrollment(
  name: string,
  trustClass: 'trusted' | 'restricted' | 'quarantine',
  status?: WorkerEnrollmentResource['status'],
): WorkerEnrollmentResource {
  return {
    apiVersion: WORKER_ENROLLMENT_API_VERSION,
    kind: WORKER_ENROLLMENT_KIND,
    metadata: {
      name,
      namespace: 'default',
      uid: `uid-${name}`,
      generation: 1,
      resourceVersion: '1',
      creationTimestamp: '2026-07-18T00:00:00.000Z',
    },
    spec: {
      nodeRef: { apiVersion: 'memeloop/v1', kind: 'Node', name: 'node-1' },
      trustClass,
      bootstrapTokenHash: 'sha256:token123',
      enrolledBy: 'controller/admin',
      expiresAt: '2026-07-19T00:00:00.000Z',
    },
    status,
  };
}

function makeSession(
  name: string,
  enrollmentName: string,
  status?: WorkerSessionResource['status'],
): WorkerSessionResource {
  return {
    apiVersion: WORKER_SESSION_API_VERSION,
    kind: WORKER_SESSION_KIND,
    metadata: {
      name,
      namespace: 'default',
      uid: `uid-${name}`,
      generation: 1,
      resourceVersion: '1',
      creationTimestamp: '2026-07-18T00:00:00.000Z',
    },
    spec: {
      enrollmentRef: { apiVersion: WORKER_ENROLLMENT_API_VERSION, kind: WORKER_ENROLLMENT_KIND, name: enrollmentName },
      workerKeyFingerprint: 'worker-fp-abc',
      ttlMs: 3600000,
    },
    status,
  };
}

describe('revokeQuarantineIdentity', () => {
  it('revokes quarantine enrollment and all active sessions', async () => {
    const store = makeStore();
    const now = () => new Date('2026-07-18T00:00:00.000Z');

    // Create enrollment and sessions.
    const enrollment = makeEnrollment('enroll-1', 'quarantine');
    await store.create({ id: 'controller/admin', kind: 'controller' }, enrollment);

    const session1 = makeSession('session-1', 'enroll-1', { phase: 'Active', expiresAt: '2026-07-18T01:00:00.000Z' });
    const session2 = makeSession('session-2', 'enroll-1', { phase: 'Active', expiresAt: '2026-07-18T01:00:00.000Z' });
    await store.create({ id: 'controller/admin', kind: 'controller' }, session1);
    await store.create({ id: 'controller/admin', kind: 'controller' }, session2);

    const record = await revokeQuarantineIdentity(
      store,
      { id: 'controller/admin', kind: 'controller' },
      'enroll-1',
      'security-incident',
      'evidence-123',
      now,
    );

    expect(record.enrollmentName).toBe('enroll-1');
    expect(record.sessionNames).toContain('session-1');
    expect(record.sessionNames).toContain('session-2');
    expect(record.reason).toBe('security-incident');

    // Verify enrollment is revoked.
    const updatedEnrollment = await store.get({
      apiVersion: WORKER_ENROLLMENT_API_VERSION,
      kind: WORKER_ENROLLMENT_KIND,
      name: 'enroll-1',
    }) as WorkerEnrollmentResource;
    expect(updatedEnrollment.status?.phase).toBe('Revoked');

    // Verify sessions are revoked.
    const updatedSession1 = await store.get({
      apiVersion: WORKER_SESSION_API_VERSION,
      kind: WORKER_SESSION_KIND,
      name: 'session-1',
    }) as WorkerSessionResource;
    expect(updatedSession1.status?.phase).toBe('Revoked');
  });

  it('rejects revocation of non-quarantine enrollment', async () => {
    const store = makeStore();
    const enrollment = makeEnrollment('enroll-1', 'restricted');
    await store.create({ id: 'controller/admin', kind: 'controller' }, enrollment);

    await expect(
      revokeQuarantineIdentity(
        store,
        { id: 'controller/admin', kind: 'controller' },
        'enroll-1',
        'security-incident',
      ),
    ).rejects.toThrow('Only quarantine identities can be permanently revoked');
  });

  it('rejects revocation by non-controller actor', async () => {
    const store = makeStore();
    await expect(
      revokeQuarantineIdentity(
        store,
        { id: 'worker/node-1', kind: 'verifier' },
        'enroll-1',
        'security-incident',
      ),
    ).rejects.toThrow('requires controller or admin actor');
  });
});

describe('promoteIdentity', () => {
  it('revokes quarantine identity and creates new trusted enrollment', async () => {
    const store = makeStore();
    const now = () => new Date('2026-07-18T00:00:00.000Z');

    const enrollment = makeEnrollment('enroll-1', 'quarantine');
    await store.create({ id: 'controller/admin', kind: 'controller' }, enrollment);

    const newEnrollment = await promoteIdentity(
      store,
      { id: 'controller/admin', kind: 'controller' },
      {
        sourceEnrollmentName: 'enroll-1',
        targetTrustClass: 'trusted',
        verificationEvidence: 'reimage-attestation-456',
        verifiedBy: 'verifier/main',
        approvedBy: 'controller/admin',
      },
      now,
    );

    expect(newEnrollment.spec.trustClass).toBe('trusted');
    expect(newEnrollment.spec.enrolledBy).toBe('controller/admin');

    // Old enrollment should be revoked.
    const oldEnrollment = await store.get({
      apiVersion: WORKER_ENROLLMENT_API_VERSION,
      kind: WORKER_ENROLLMENT_KIND,
      name: 'enroll-1',
    }) as WorkerEnrollmentResource;
    expect(oldEnrollment.status?.phase).toBe('Revoked');
  });

  it('rejects promotion of non-quarantine enrollment', async () => {
    const store = makeStore();
    const enrollment = makeEnrollment('enroll-1', 'restricted');
    await store.create({ id: 'controller/admin', kind: 'controller' }, enrollment);

    await expect(
      promoteIdentity(
        store,
        { id: 'controller/admin', kind: 'controller' },
        {
          sourceEnrollmentName: 'enroll-1',
          targetTrustClass: 'trusted',
          verificationEvidence: 'evidence',
          verifiedBy: 'verifier/main',
          approvedBy: 'controller/admin',
        },
      ),
    ).rejects.toThrow('Only quarantine identities can be promoted');
  });
});

describe('isIdentityRevoked', () => {
  it('returns true for revoked enrollment', async () => {
    const store = makeStore();
    const enrollment = makeEnrollment('enroll-1', 'quarantine', { phase: 'Revoked' });
    await store.create({ id: 'controller/admin', kind: 'controller' }, enrollment);

    expect(await isIdentityRevoked(store, 'enroll-1')).toBe(true);
  });

  it('returns false for active enrollment', async () => {
    const store = makeStore();
    const enrollment = makeEnrollment('enroll-1', 'quarantine', { phase: 'Bound' });
    await store.create({ id: 'controller/admin', kind: 'controller' }, enrollment);

    expect(await isIdentityRevoked(store, 'enroll-1')).toBe(false);
  });

  it('returns false for missing enrollment', async () => {
    const store = makeStore();
    expect(await isIdentityRevoked(store, 'missing')).toBe(false);
  });
});
