import { describe, expect, it, vi } from 'vitest';

import type { OrchestrationResource } from '../client.js';
import type { ControlStore } from '../controlStore.js';
import {
  bindWorkerSession,
  createWorkerEnrollmentManifest,
  createWorkerSessionManifest,
  enrollWorker,
  isWorkerEnrollment,
  isWorkerSession,
  isWorkerSessionValid,
  revokeWorkerSession,
  WORKER_ENROLLMENT_KIND,
  WORKER_SESSION_KIND,
  type WorkerSessionResource,
} from '../security/workerIdentity.js';

const BOOTSTRAP_TOKEN = 'bootstrap-token';
const BOOTSTRAP_HASH = 'sha256:bootstrap-token';
const verifyBootstrapToken = (token: string, expectedHash: string) => token === BOOTSTRAP_TOKEN && expectedHash === BOOTSTRAP_HASH;
const verifyWorkerProof = (request: { challenge: string; signature: string }) => request.challenge === 'challenge-1' && request.signature === 'proof-1';
const ENROLLMENT_SCOPE = {
  expectedGateway: 'https://gateway.example.test',
  gatewayKeyFingerprint: 'sha256:gateway-key',
  audience: 'worker-gateway://node-1',
  allowedProtocol: 'worker.memeloop.io/v1alpha1',
  run: { uid: 'run-uid-1', attempt: 1, epoch: 1 },
  policyDigest: 'sha256:policy',
  allowedMethods: ['assignment.pull', 'session.heartbeat'] as const,
  allowedTargets: ['run-uid-1'],
};
const BINDING = {
  bootstrapToken: BOOTSTRAP_TOKEN,
  workerKeyFingerprint: 'worker-fp-abc',
  workerPublicKey: 'ed25519-public-key',
  gatewayKeyFingerprint: ENROLLMENT_SCOPE.gatewayKeyFingerprint,
  proof: { challenge: 'challenge-1', signature: 'proof-1' },
  ttlMs: 3600000,
  verifyBootstrapToken,
  verifyWorkerProof,
};

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
    list: vi.fn(async () => ({ items: [] })),
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

describe('WorkerEnrollment and WorkerSession', () => {
  async function createEnrollment(
    store: ControlStore,
    expiresAt = '2026-07-19T00:00:00.000Z',
  ): Promise<void> {
    await enrollWorker(store, { id: 'controller/admin', kind: 'controller' }, 'enroll-1', {
      nodeRef: { apiVersion: 'memeloop/v1', kind: 'Node', name: 'node-1' },
      trustClass: 'restricted',
      ...ENROLLMENT_SCOPE,
      allowedMethods: [...ENROLLMENT_SCOPE.allowedMethods],
      bootstrapTokenHash: BOOTSTRAP_HASH,
      enrolledBy: 'controller/admin',
      expiresAt,
    });
  }

  it('creates WorkerEnrollment manifest with correct schema', () => {
    const manifest = createWorkerEnrollmentManifest('enroll-1', {
      nodeRef: { apiVersion: 'memeloop/v1', kind: 'Node', name: 'node-1' },
      trustClass: 'restricted',
      ...ENROLLMENT_SCOPE,
      allowedMethods: [...ENROLLMENT_SCOPE.allowedMethods],
      bootstrapTokenHash: 'sha256:token123',
      enrolledBy: 'controller/admin',
      expiresAt: '2026-07-19T00:00:00.000Z',
    });

    expect(manifest.apiVersion).toBe('security.memeloop.io/v1alpha1');
    expect(manifest.kind).toBe(WORKER_ENROLLMENT_KIND);
    expect(manifest.spec.trustClass).toBe('restricted');
  });

  it('creates WorkerSession manifest with correct schema', () => {
    const manifest = createWorkerSessionManifest('session-1', {
      enrollmentRef: { apiVersion: 'security.memeloop.io/v1alpha1', kind: WORKER_ENROLLMENT_KIND, name: 'enroll-1' },
      workerKeyFingerprint: 'worker-fp-abc',
      workerPublicKey: 'ed25519-public-key',
      audience: ENROLLMENT_SCOPE.audience,
      allowedProtocol: ENROLLMENT_SCOPE.allowedProtocol,
      run: ENROLLMENT_SCOPE.run,
      policyDigest: ENROLLMENT_SCOPE.policyDigest,
      allowedMethods: [...ENROLLMENT_SCOPE.allowedMethods],
      ttlMs: 3600000,
    });

    expect(manifest.apiVersion).toBe('security.memeloop.io/v1alpha1');
    expect(manifest.kind).toBe(WORKER_SESSION_KIND);
    expect(manifest.spec.workerKeyFingerprint).toBe('worker-fp-abc');
  });

  it('identifies WorkerEnrollment and WorkerSession resources', () => {
    const enrollment = { kind: WORKER_ENROLLMENT_KIND } as OrchestrationResource;
    const session = { kind: WORKER_SESSION_KIND } as OrchestrationResource;
    const other = { kind: 'AgentRun' } as OrchestrationResource;

    expect(isWorkerEnrollment(enrollment)).toBe(true);
    expect(isWorkerEnrollment(session)).toBe(false);
    expect(isWorkerSession(session)).toBe(true);
    expect(isWorkerSession(other)).toBe(false);
  });

  it('enrolls worker with controller actor', async () => {
    const store = makeStore();
    const enrollment = await enrollWorker(
      store,
      { id: 'controller/admin', kind: 'controller' },
      'enroll-1',
      {
        nodeRef: { apiVersion: 'memeloop/v1', kind: 'Node', name: 'node-1' },
        trustClass: 'restricted',
        ...ENROLLMENT_SCOPE,
        allowedMethods: [...ENROLLMENT_SCOPE.allowedMethods],
        bootstrapTokenHash: 'sha256:token123',
        enrolledBy: 'controller/admin',
        expiresAt: '2026-07-19T00:00:00.000Z',
      },
    );

    expect(enrollment.kind).toBe(WORKER_ENROLLMENT_KIND);
    expect(store.create).toHaveBeenCalledWith(
      { id: 'controller/admin', kind: 'controller' },
      expect.objectContaining({ kind: WORKER_ENROLLMENT_KIND }),
    );
  });

  it('rejects enrollment by non-controller actor', async () => {
    const store = makeStore();
    await expect(
      enrollWorker(
        store,
        { id: 'worker/node-1', kind: 'verifier' },
        'enroll-1',
        {
          nodeRef: { apiVersion: 'memeloop/v1', kind: 'Node', name: 'node-1' },
          trustClass: 'restricted',
          ...ENROLLMENT_SCOPE,
          allowedMethods: [...ENROLLMENT_SCOPE.allowedMethods],
          bootstrapTokenHash: 'sha256:token123',
          enrolledBy: 'worker/node-1',
          expiresAt: '2026-07-19T00:00:00.000Z',
        },
      ),
    ).rejects.toThrow('requires controller or admin actor');
  });

  it('binds worker session with ephemeral identity', async () => {
    const store = makeStore();
    const now = () => new Date('2026-07-18T00:00:00.000Z');
    await createEnrollment(store);

    const session = await bindWorkerSession(
      store,
      { id: 'controller/admin', kind: 'controller' },
      'enroll-1',
      BINDING,
      now,
    );

    expect(session.kind).toBe(WORKER_SESSION_KIND);
    expect(session.spec.workerKeyFingerprint).toBe('worker-fp-abc');
    expect(session.status?.phase).toBe('Active');
    expect(session.status?.expiresAt).toBe('2026-07-18T01:00:00.000Z');
  });

  it('revokes worker session', async () => {
    const store = makeStore();
    const now = () => new Date('2026-07-18T00:00:00.000Z');
    await createEnrollment(store);

    // First create a session.
    const session = await bindWorkerSession(
      store,
      { id: 'controller/admin', kind: 'controller' },
      'enroll-1',
      BINDING,
      now,
    );

    // Then revoke it.
    await revokeWorkerSession(
      store,
      { id: 'controller/admin', kind: 'controller' },
      session.metadata.name,
      'security incident',
      now,
    );

    const updated = await store.get({ apiVersion: 'security.memeloop.io/v1alpha1', kind: WORKER_SESSION_KIND, name: session.metadata.name });
    expect(updated?.status?.phase).toBe('Revoked');
    expect(updated?.status?.revokeReason).toBe('security incident');
  });

  it('rejects invalid and expired bootstrap tokens before creating a session', async () => {
    const now = () => new Date('2026-07-18T00:00:00.000Z');
    const invalidStore = makeStore();
    await createEnrollment(invalidStore);
    await expect(bindWorkerSession(
      invalidStore,
      { id: 'controller/admin', kind: 'controller' },
      'enroll-1',
      {
        ...BINDING,
        bootstrapToken: 'wrong',
      },
      now,
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const expiredStore = makeStore();
    await createEnrollment(expiredStore, '2026-07-17T23:59:59.000Z');
    await expect(bindWorkerSession(
      expiredStore,
      { id: 'controller/admin', kind: 'controller' },
      'enroll-1',
      BINDING,
      now,
    )).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('consumes an enrollment once and caps the session at enrollment expiry', async () => {
    const store = makeStore();
    const now = () => new Date('2026-07-18T00:00:00.000Z');
    await createEnrollment(store, '2026-07-18T00:10:00.000Z');
    const first = await bindWorkerSession(
      store,
      { id: 'controller/admin', kind: 'controller' },
      'enroll-1',
      {
        ...BINDING,
        ttlMs: 3600000,
      },
      now,
    );
    expect(first.spec.ttlMs).toBe(600_000);
    expect(first.status?.expiresAt).toBe('2026-07-18T00:10:00.000Z');

    await expect(bindWorkerSession(
      store,
      { id: 'controller/admin', kind: 'controller' },
      'enroll-1',
      {
        ...BINDING,
        workerKeyFingerprint: 'different-worker',
        ttlMs: 1000,
      },
      now,
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('checks session validity correctly', () => {
    const validSession: WorkerSessionResource = {
      apiVersion: 'security.memeloop.io/v1alpha1',
      kind: WORKER_SESSION_KIND,
      metadata: { name: 's1', namespace: 'default', uid: 'u1', generation: 1, resourceVersion: '1', creationTimestamp: '2026-07-18T00:00:00.000Z' },
      spec: {
        enrollmentRef: { apiVersion: 'security.memeloop.io/v1alpha1', kind: WORKER_ENROLLMENT_KIND, name: 'e1' },
        workerKeyFingerprint: 'fp1',
        workerPublicKey: 'ed25519-public-key',
        audience: ENROLLMENT_SCOPE.audience,
        allowedProtocol: ENROLLMENT_SCOPE.allowedProtocol,
        run: ENROLLMENT_SCOPE.run,
        policyDigest: ENROLLMENT_SCOPE.policyDigest,
        allowedMethods: [...ENROLLMENT_SCOPE.allowedMethods],
        ttlMs: 3600000,
      },
      status: {
        phase: 'Active',
        expiresAt: '2026-07-18T01:00:00.000Z',
      },
    };

    const expiredSession: WorkerSessionResource = {
      ...validSession,
      status: { phase: 'Active', expiresAt: '2026-07-17T23:00:00.000Z' },
    };

    const revokedSession: WorkerSessionResource = {
      ...validSession,
      status: { phase: 'Revoked', expiresAt: '2026-07-18T01:00:00.000Z' },
    };

    const now = new Date('2026-07-18T00:00:00.000Z');
    expect(isWorkerSessionValid(validSession, now)).toBe(true);
    expect(isWorkerSessionValid(expiredSession, now)).toBe(false);
    expect(isWorkerSessionValid(revokedSession, now)).toBe(false);
  });
});
