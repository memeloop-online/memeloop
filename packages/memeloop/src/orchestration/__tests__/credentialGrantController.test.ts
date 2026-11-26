import { describe, expect, it, vi } from 'vitest';

import {
  createCredentialGrantBindingController,
  createCredentialGrantExecutionController,
  createCredentialGrantLifecycleController,
  type CredentialHandleVault,
  revokeCredentialGrant,
} from '../credentialGrantController.js';
import type { CredentialManagementDriver } from '../drivers/credentialManagement.js';
import { DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';
import type { CredentialGrantResource } from '../resources.js';
import type { CredentialBrokerDriver, CredentialGrantHandle } from '../security/credentialBroker.js';

function grant(status: CredentialGrantResource['status'] = { phase: 'Pending' }): CredentialGrantResource {
  return {
    apiVersion: 'security.memeloop.io/v1alpha1',
    kind: 'CredentialGrant',
    metadata: {
      name: 'grant-1',
      namespace: 'default',
      uid: 'grant-uid',
      generation: 1,
      resourceVersion: '4',
      creationTimestamp: '',
    },
    spec: {
      runRef: {
        apiVersion: 'run.memeloop.io/v1alpha1',
        kind: 'AgentRun',
        name: 'run-1',
        uid: 'run-uid',
      },
      attempt: 1,
      workerKey: 'sha256:worker',
      target: 'https://api.example.test/v1',
      method: 'POST',
      audience: 'example-api',
      policyDigest: 'sha256:policy',
      ttlMs: 30_000,
    },
    status,
  };
}

function request(resource: CredentialGrantResource, leaseEpoch = 'epoch-1') {
  return {
    resource,
    actor: { id: 'controller/credential', kind: 'controller' as const },
    leaseEpoch,
    now: new Date('2026-07-23T00:00:00Z'),
  };
}

function handle(): CredentialGrantHandle {
  return {
    token: 'opaque-secret-token',
    claims: {
      ...grant().spec,
      grantId: 'grant-uid',
      issuedAt: '2026-07-23T01:00:00.000Z',
      expiresAt: '2026-07-23T01:01:00.000Z',
    },
  };
}

function vault(): CredentialHandleVault & { values: Map<string, CredentialGrantHandle> } {
  const values = new Map<string, CredentialGrantHandle>();
  return {
    values,
    async put(reference, value) {
      values.set(reference, value);
    },
    async get(reference) {
      return values.get(reference);
    },
    async delete(reference) {
      values.delete(reference);
    },
  };
}

function managedRequest<T>(
  method: string,
  payload: T,
): DriverRequestEnvelope<T> {
  return {
    apiVersion: DRIVER_REQUEST_API_VERSION,
    method,
    resource: {
      apiVersion: 'security.memeloop.io/v1alpha1',
      kind: 'CredentialGrant',
      name: 'grant-1',
      uid: 'grant-uid',
      generation: 1,
    },
    run: { uid: 'run-uid', attempt: 1 },
    fencingEpoch: 1,
    requestId: `${method}:request`,
    idempotencyKey: `${method}:grant-uid`,
    deadline: '2026-07-23T02:00:00.000Z',
    actor: { id: 'controller/credential', kind: 'controller' },
    capabilityHandleRef: 'capability:credential',
    trace: { traceId: 'trace', spanId: method },
    payloadSchemaDigest: `sha256:${'a'.repeat(64)}`,
    payload,
  };
}

describe('credential grant controllers', () => {
  it('binds only to a healthy broker satisfying node, class, scope, and capacity', async () => {
    const controller = createCredentialGrantBindingController({
      requirementsForGrant: async () => ({
        requiredNode: 'worker-b',
        brokerClass: 'vault-jit',
      }),
      listBrokers: async () => [
        {
          nodeId: 'worker-a',
          brokerClass: 'vault-jit',
          healthy: true,
          audiences: ['example-api'],
        },
        {
          nodeId: 'worker-b',
          brokerClass: 'vault-jit',
          healthy: true,
          audiences: ['example-api'],
          methods: ['POST'],
          targets: ['https://api.example.test/*'],
          activeGrants: 0,
          maxGrants: 1,
        },
      ],
      now: () => new Date('2026-07-23T00:30:00Z'),
    });
    const result = await controller.reconcile(request(grant()));
    expect(result.status).toMatchObject({
      phase: 'Pending',
      assignedNode: 'worker-b',
      assignedBroker: 'vault-jit',
      binding: { leaseEpoch: 'epoch-1' },
      conditions: [{ type: 'CredentialBrokerScheduled', status: 'True' }],
    });
  });

  it('fails closed when broker scope or capacity is unavailable', async () => {
    const controller = createCredentialGrantBindingController({
      listBrokers: async () => [{
        nodeId: 'worker-a',
        brokerClass: 'vault-jit',
        healthy: true,
        audiences: ['other'],
        activeGrants: 1,
        maxGrants: 1,
      }],
    });
    const result = await controller.reconcile(request(grant()));
    expect(result.status).not.toMatchObject({ assignedBroker: expect.any(String) });
    expect(result.status?.conditions?.[0]).toMatchObject({
      status: 'False',
      reason: 'NoEligibleBroker',
    });
  });

  it('persists a terminal denial from host-bound grant admission', async () => {
    const controller = createCredentialGrantBindingController({
      requirementsForGrant: async () => ({ denyReason: 'worker key is not enrolled' }),
      listBrokers: vi.fn(),
    });
    const result = await controller.reconcile(request(grant()));
    expect(result.status).toMatchObject({
      phase: 'Failed',
      error: { code: 'FORBIDDEN', message: 'worker key is not enrolled' },
    });
  });

  it('claims before issue and stores the token only in the external vault', async () => {
    const issue = vi.fn(async () => handle());
    const handleVault = vault();
    const broker = { issue } as unknown as CredentialBrokerDriver;
    const controller = createCredentialGrantExecutionController({
      nodeId: 'worker-a',
      getBroker: async () => broker,
      vault: handleVault,
    });
    const bound = {
      phase: 'Pending' as const,
      assignedNode: 'worker-a',
      assignedBroker: 'vault-jit',
      binding: { leaseEpoch: 'bind-1', boundAt: '' },
    };
    const claim = await controller.reconcile(request(grant(bound), 'exec-1'));
    expect(claim.status).toMatchObject({
      phase: 'Issuing',
      issuanceClaim: { leaseEpoch: 'exec-1' },
    });
    expect(issue).not.toHaveBeenCalled();

    const issued = await controller.reconcile(request(grant(claim.status), 'exec-1'));
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({
      grantId: 'grant-uid',
      workerKey: 'sha256:worker',
    }));
    expect(issued.status).toMatchObject({
      phase: 'Issued',
      handleRef: 'credential://worker-a/grant-uid',
      exposure: 'worker-visible',
      rotationRequired: true,
    });
    expect(JSON.stringify(issued.status)).not.toContain(handle().token);
    expect(handleVault.values.get('credential://worker-a/grant-uid')?.token).toBe(handle().token);
  });

  it('fails unknown-effect after controller epoch changes during issuance', async () => {
    const issue = vi.fn();
    const controller = createCredentialGrantExecutionController({
      nodeId: 'worker-a',
      getBroker: async () => ({ issue } as unknown as CredentialBrokerDriver),
      vault: vault(),
    });
    const result = await controller.reconcile(request(
      grant({
        phase: 'Issuing',
        assignedNode: 'worker-a',
        assignedBroker: 'vault-jit',
        binding: { leaseEpoch: 'bind-1', boundAt: '' },
        issuanceClaim: { leaseEpoch: 'old', claimedAt: '' },
      }),
      'new',
    ));
    expect(result.status).toMatchObject({ error: { code: 'UNKNOWN_EFFECT' } });
    expect(issue).not.toHaveBeenCalled();
  });

  it('routes issue and lifecycle revocation through the managed driver', async () => {
    const issue = vi.fn(async () => ({
      grantHandle: 'managed://grant-uid',
      resourceUid: 'grant-uid',
      runUid: 'run-uid',
      attempt: 1,
      workerKey: 'sha256:worker',
      target: 'https://api.example.test/v1',
      targetMethod: 'POST',
      targetDriver: 'example-api',
      audience: 'example-api',
      policyDigest: 'sha256:policy',
      issuedAt: '2026-07-23T01:00:00.000Z',
      expiresAt: '2026-07-23T01:01:00.000Z',
      revoked: false,
      exposure: 'worker-visible' as const,
      rotationRequired: true,
    }));
    const revoke = vi.fn(async () => {});
    const managed = { issue, revoke } as unknown as CredentialManagementDriver;
    const narrowIssue = vi.fn();
    const execution = createCredentialGrantExecutionController({
      nodeId: 'worker-a',
      getBroker: async () => ({ issue: narrowIssue } as unknown as CredentialBrokerDriver),
      vault: vault(),
      managed: {
        getDriver: async () => managed,
        createIssueRequest: async ({ grant: resource }) =>
          managedRequest('credential.issue', {
            runRef: resource.spec.runRef,
            workerKey: resource.spec.workerKey,
            target: resource.spec.target,
            targetMethod: resource.spec.method,
            targetDriver: resource.spec.audience,
            audience: resource.spec.audience,
            policyDigest: resource.spec.policyDigest,
            ttlMs: resource.spec.ttlMs ?? 30_000,
            exposure: 'worker-visible' as const,
          }),
      },
    });
    const issuing = grant({
      phase: 'Issuing',
      assignedNode: 'worker-a',
      assignedBroker: 'vault-jit',
      binding: { leaseEpoch: 'bind-1', boundAt: '' },
      issuanceClaim: { leaseEpoch: 'exec-1', claimedAt: '' },
    });
    const issued = await execution.reconcile(request(issuing, 'exec-1'));
    expect(issued.status).toMatchObject({
      phase: 'Issued',
      handleRef: 'managed://grant-uid',
    });
    expect(issue).toHaveBeenCalledOnce();
    expect(narrowIssue).not.toHaveBeenCalled();

    const lifecycle = createCredentialGrantLifecycleController({
      nodeId: 'worker-a',
      getBroker: async () => undefined,
      vault: vault(),
      isRunTerminal: async () => true,
      managed: {
        getDriver: async () => managed,
        createRevokeRequest: async ({ grantHandle }) => managedRequest('credential.revoke', { grantHandle }),
      },
    });
    await lifecycle.reconcile(request(grant({
      ...issued.status,
      assignedNode: 'worker-a',
      assignedBroker: 'vault-jit',
    })));
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('revokes the deterministic grant and deletes vault material', async () => {
    const handleVault = vault();
    await handleVault.put('credential://worker-a/grant-uid', handle());
    const revoke = vi.fn();
    const broker = { revoke } as unknown as CredentialBrokerDriver;
    await revokeCredentialGrant(
      grant({
        phase: 'Issued',
        handleRef: 'credential://worker-a/grant-uid',
      }),
      broker,
      handleVault,
    );
    expect(revoke).toHaveBeenCalledWith('grant-uid');
    expect(handleVault.values.size).toBe(0);
  });

  it('revokes issued grants when the Run terminates or the grant expires', async () => {
    const handleVault = vault();
    await handleVault.put('credential://worker-a/grant-uid', handle());
    const revoke = vi.fn();
    const lifecycle = createCredentialGrantLifecycleController({
      nodeId: 'worker-a',
      getBroker: async () => ({ revoke } as unknown as CredentialBrokerDriver),
      vault: handleVault,
      isRunTerminal: async () => true,
      now: () => new Date('2026-07-23T01:00:30Z'),
    });
    const status = {
      phase: 'Issued' as const,
      assignedNode: 'worker-a',
      assignedBroker: 'vault-jit',
      binding: { leaseEpoch: 'bind-1', boundAt: '' },
      handleRef: 'credential://worker-a/grant-uid',
      expiresAt: '2026-07-23T01:01:00.000Z',
    };
    const terminated = await lifecycle.reconcile(request(grant(status)));
    expect(terminated.status).toMatchObject({
      phase: 'Revoked',
      revokedAt: '2026-07-23T01:00:30.000Z',
    });

    await handleVault.put('credential://worker-a/grant-uid', handle());
    const expiry = createCredentialGrantLifecycleController({
      nodeId: 'worker-a',
      getBroker: async () => ({ revoke } as unknown as CredentialBrokerDriver),
      vault: handleVault,
      isRunTerminal: async () => false,
      now: () => new Date('2026-07-23T01:02:00Z'),
    });
    expect((await expiry.reconcile(request(grant(status)))).status)
      .toMatchObject({ phase: 'Expired' });
  });
});
