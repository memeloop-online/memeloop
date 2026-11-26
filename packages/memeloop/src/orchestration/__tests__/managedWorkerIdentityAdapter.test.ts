import { describe, expect, it, vi } from 'vitest';

import { DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';
import { createManagedWorkerIdentityAdapter } from '../drivers/managedWorkerIdentityAdapter.js';
import { createWorkerEnrollmentManifest, type WorkerEnrollmentResource } from '../security/workerIdentity.js';
import { QuorumControlStore } from '../stores/quorumControlStore.js';

const now = () => new Date('2026-07-27T04:00:00.000Z');
const actor = { id: 'controller/worker-identity', kind: 'controller' as const };

function createRequest<T>(input: {
  method: string;
  payload: T;
  enrollment: WorkerEnrollmentResource;
  idempotencyKey: string;
}): DriverRequestEnvelope<T> {
  return {
    apiVersion: DRIVER_REQUEST_API_VERSION,
    method: input.method,
    resource: {
      apiVersion: input.enrollment.apiVersion,
      kind: input.enrollment.kind,
      name: input.enrollment.metadata.name,
      uid: input.enrollment.metadata.uid,
      generation: input.enrollment.metadata.generation,
    },
    fencingEpoch: input.enrollment.metadata.generation,
    requestId: `${input.method}:${input.idempotencyKey}`,
    idempotencyKey: input.idempotencyKey,
    deadline: '2026-07-27T04:01:00.000Z',
    actor,
    session: { id: 'worker-identity-session' },
    capabilityHandleRef: 'capability:worker-identity',
    trace: { traceId: 'trace-1', spanId: input.idempotencyKey },
    payloadSchemaDigest: `sha256:${'a'.repeat(64)}`,
    payload: input.payload,
  };
}

async function enrollment(store: QuorumControlStore): Promise<WorkerEnrollmentResource> {
  return await store.create(
    actor,
    createWorkerEnrollmentManifest(
      'enrollment-1',
      {
        nodeRef: {
          apiVersion: 'nodes.memeloop.io/v1alpha1',
          kind: 'Node',
          name: 'node-1',
        },
        trustClass: 'restricted',
        expectedGateway: 'https://gateway.example.test',
        gatewayKeyFingerprint: 'sha256:gateway',
        audience: 'worker-gateway://node-1',
        allowedProtocol: 'worker.memeloop.io/v1alpha1',
        run: { uid: 'run-uid-1', attempt: 1, epoch: 1 },
        policyDigest: 'sha256:policy',
        allowedMethods: ['assignment.pull'],
        bootstrapTokenHash: 'sha256:bootstrap-token',
        enrolledBy: actor.id,
        expiresAt: '2026-07-27T04:10:00.000Z',
      },
    ),
  ) as WorkerEnrollmentResource;
}

describe('managed production Worker Identity adapter', () => {
  it('routes real WorkerEnrollment proof and durable WorkerSession issuance', async () => {
    const store = new QuorumControlStore({
      memberId: 'identity-1',
      voters: ['identity-1'],
    });
    const authorizeRequest = vi.fn(
      (request: DriverRequestEnvelope) =>
        request.capabilityHandleRef === 'capability:worker-identity' &&
        request.session?.id === 'worker-identity-session',
    );
    const route = createManagedWorkerIdentityAdapter({
      store,
      actor,
      now,
      name: 'worker-ed25519-identity',
      authorizeRequest,
      createRequest,
      threatAssumptions: [
        'the WorkerEnrollment controller, token verifier, and Ed25519 verifier are trusted',
      ],
    });
    await enrollment(store);
    const verifyBootstrapToken = vi.fn(
      (token: string, expected: string) =>
        token === 'raw-bootstrap-token' &&
        expected === 'sha256:bootstrap-token',
    );
    const verifyWorkerProof = vi.fn(() => true);
    const session = await route.bindWorkerSession('enrollment-1', {
      bootstrapToken: 'raw-bootstrap-token',
      workerKeyFingerprint: 'sha256:worker-key',
      workerPublicKey: 'encoded-ed25519-public-key',
      gatewayKeyFingerprint: 'sha256:gateway',
      proof: {
        challenge: 'worker-bootstrap-challenge',
        signature: 'worker-ed25519-signature',
      },
      ttlMs: 120_000,
      verifyBootstrapToken,
      verifyWorkerProof,
    });

    expect(session.status).toMatchObject({ phase: 'Active' });
    expect(session.spec).toMatchObject({
      workerKeyFingerprint: 'sha256:worker-key',
      audience: 'worker-gateway://node-1',
      ttlMs: 120_000,
    });
    expect(verifyBootstrapToken).toHaveBeenCalledOnce();
    expect(verifyWorkerProof).toHaveBeenCalledOnce();
    expect(authorizeRequest).toHaveBeenCalledTimes(4);
    await expect(route.driver.getCapabilities()).resolves.toMatchObject({
      identityDomains: ['enrollment'],
      attestationFormats: ['worker-ed25519-bootstrap/v1'],
      supportsRotation: false,
      persistence: 'process',
    });
    expect(
      await store.get({
        apiVersion: 'security.memeloop.io/v1alpha1',
        kind: 'WorkerSession',
        name: `session-${
          (await store.get({
            apiVersion: 'security.memeloop.io/v1alpha1',
            kind: 'WorkerEnrollment',
            name: 'enrollment-1',
          }))!.metadata.uid
        }`,
      }),
    ).toMatchObject({ status: { phase: 'Active' } });
  });

  it('fails closed on rejected proof, capability, and payload extensions', async () => {
    const store = new QuorumControlStore({
      memberId: 'identity-2',
      voters: ['identity-2'],
    });
    const resource = await enrollment(store);
    const route = createManagedWorkerIdentityAdapter({
      store,
      actor,
      now,
      name: 'worker-ed25519-identity',
      authorizeRequest: (request) => request.capabilityHandleRef === 'capability:worker-identity',
      createRequest,
      threatAssumptions: ['the host identity verifier is trusted'],
    });
    await expect(route.bindWorkerSession('enrollment-1', {
      bootstrapToken: 'raw-bootstrap-token',
      workerKeyFingerprint: 'sha256:worker-key',
      workerPublicKey: 'encoded-ed25519-public-key',
      gatewayKeyFingerprint: 'sha256:gateway',
      proof: { challenge: 'challenge', signature: 'signature' },
      ttlMs: 60_000,
      verifyBootstrapToken: () => true,
      verifyWorkerProof: () => false,
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      await store.get({
        apiVersion: 'security.memeloop.io/v1alpha1',
        kind: 'WorkerSession',
        name: `session-${resource.metadata.uid}`,
      }),
    ).toBeNull();

    await expect(route.driver.inspect({
      ...createRequest({
        method: 'identity.inspect',
        payload: { handle: 'missing' },
        enrollment: resource,
        idempotencyKey: 'wrong-capability',
      }),
      capabilityHandleRef: 'capability:wrong',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(route.driver.inspect(createRequest({
      method: 'identity.inspect',
      payload: { handle: 'missing', rawToken: 'must-not-cross' } as never,
      enrollment: resource,
      idempotencyKey: 'extension',
    }))).rejects.toMatchObject({ code: 'INVALID' });

    const firstInspect = createRequest({
      method: 'identity.inspect',
      payload: { handle: 'missing-a' },
      enrollment: resource,
      idempotencyKey: 'stable-inspect',
    });
    await expect(route.driver.inspect(firstInspect)).resolves.toBeUndefined();
    await expect(route.driver.inspect({
      ...firstInspect,
      payload: { handle: 'missing-b' },
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
