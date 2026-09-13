import { describe, expect, it, vi } from 'vitest';

import type { CredentialIssuePayload } from '../drivers/credentialManagement.js';
import { DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';
import { createManagedCredentialBrokerAdapter } from '../drivers/managedCredentialBrokerAdapter.js';
import { createInMemoryCredentialBroker, type CredentialGrantHandle, type CredentialProofVerifier } from '../security/credentialBroker.js';
import { base64UrlEncode, type ModelHandleSigner } from '../security/modelAccessHandle.js';

const now = () => new Date('2026-07-26T12:00:00.000Z');

function signer(): ModelHandleSigner {
  return {
    sign: async (payload) => new Uint8Array([payload.length % 251]),
    verify: async (payload, signature) => signature[0] === payload.length % 251,
  };
}

function envelope<T>(
  method: string,
  payload: T,
  idempotencyKey: string,
  fencingEpoch = 1,
): DriverRequestEnvelope<T> {
  return {
    apiVersion: DRIVER_REQUEST_API_VERSION,
    method,
    resource: {
      apiVersion: 'security.memeloop.io/v1alpha1',
      kind: 'CredentialGrant',
      name: 'grant-1',
      uid: 'grant-uid-1',
      generation: 1,
    },
    run: { uid: 'run-uid-1', attempt: 1 },
    fencingEpoch,
    requestId: `${method}:${idempotencyKey}`,
    idempotencyKey,
    deadline: '2026-07-26T12:01:00.000Z',
    actor: { id: 'controller/credential', kind: 'controller' },
    session: {
      id: 'worker-session-1',
      keyFingerprint: 'ed25519:worker-1',
    },
    capabilityHandleRef: 'capability:credential-1',
    trace: { traceId: 'trace-1', spanId: idempotencyKey },
    payloadSchemaDigest: `sha256:${'d'.repeat(64)}`,
    payload,
  };
}

function issuePayload(
  exposure: CredentialIssuePayload['exposure'] = 'worker-visible',
): CredentialIssuePayload {
  return {
    runRef: {
      apiVersion: 'run.memeloop.io/v1alpha1',
      kind: 'AgentRun',
      name: 'run-1',
      uid: 'run-uid-1',
    },
    workerKey: 'ed25519:worker-1',
    target: 'model/openai',
    targetMethod: 'generate',
    targetDriver: 'model-provider/openai',
    audience: 'model-provider/openai',
    policyDigest: `sha256:${'e'.repeat(64)}`,
    ttlMs: 30_000,
    exposure,
  };
}

describe('managed production Credential Broker adapter', () => {
  it('drives the signed broker without exposing its token and revokes materializations', async () => {
    const verifyAndConsume: CredentialProofVerifier['verifyAndConsume'] = vi.fn(
      async (
        { proof }: Parameters<CredentialProofVerifier['verifyAndConsume']>[0],
      ): Promise<boolean> =>
        proof.challengeId.startsWith('challenge-') &&
        proof.signature[0] === 7,
    );
    const broker = createInMemoryCredentialBroker({
      signer: signer(),
      proofVerifier: { verifyAndConsume },
      now,
    });
    const materialize = vi.fn(async () => 'vault-materialization:1');
    const revokeMaterialization = vi.fn(async () => {});
    const adapter = createManagedCredentialBrokerAdapter(broker, {
      name: 'signed-credential-broker',
      maxTtlMs: 60_000,
      now,
      materialize,
      revokeMaterialization,
      authorizeRequest: (request) => request.capabilityHandleRef === 'capability:credential-1',
      threatAssumptions: ['the signer and target driver are trusted'],
    });

    expect(await adapter.getCapabilities()).toMatchObject({
      persistence: 'process',
      supportedExposures: ['worker-visible'],
    });
    const issueRequest = envelope(
      'credential.issue',
      issuePayload(),
      'issue-1',
    );
    const issued = await adapter.issue(issueRequest);
    expect((await adapter.issue(issueRequest)).grantHandle).toBe(
      issued.grantHandle,
    );
    await expect(adapter.issue({
      ...issueRequest,
      payload: { ...issueRequest.payload, target: 'model/other' },
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(adapter.issue(envelope(
      'credential.issue',
      { ...issuePayload(), apiKey: 'must-not-cross-driver-boundary' } as never,
      'issue-secret-extension',
    ))).rejects.toMatchObject({ code: 'INVALID' });
    expect(issued.grantHandle).not.toContain('mlcg1');
    expect(issued).toMatchObject({
      resourceUid: 'grant-uid-1',
      runUid: 'run-uid-1',
      attempt: 1,
    });
    await expect(adapter.inspect({
      ...envelope(
        'credential.inspect',
        { grantHandle: issued.grantHandle },
        'inspect-denied',
      ),
      capabilityHandleRef: 'capability:wrong',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const renewed = await adapter.renew(envelope(
      'credential.renew',
      { grantHandle: issued.grantHandle, ttlMs: 40_000 },
      'renew-1',
    ));
    expect(renewed.grantHandle).toBe(issued.grantHandle);

    const materialized = await adapter.materialize(envelope(
      'credential.materialize',
      {
        grantHandle: issued.grantHandle,
        targetDriver: 'model-provider/openai',
        proof: {
          challengeId: 'challenge-1',
          signature: base64UrlEncode(new Uint8Array([7])),
        },
      },
      'materialize-1',
    ));
    expect(materialized.materializationHandle).toBe(
      'vault-materialization:1',
    );
    expect(materialize).toHaveBeenCalledOnce();
    expect(verifyAndConsume).toHaveBeenCalledOnce();

    const second = await adapter.issue(envelope(
      'credential.issue',
      issuePayload(),
      'issue-2',
    ));
    await expect(adapter.materialize(envelope(
      'credential.materialize',
      {
        grantHandle: second.grantHandle,
        targetDriver: 'model-provider/openai',
        proof: {
          challengeId: 'challenge-2',
          signature: base64UrlEncode(new Uint8Array([7])),
        },
      },
      'materialize-2',
    ))).rejects.toMatchObject({ code: 'CONFLICT' });

    await adapter.revoke(envelope(
      'credential.revoke',
      { grantHandle: issued.grantHandle },
      'revoke-1',
    ));
    expect(
      (await adapter.inspect(envelope(
        'credential.inspect',
        { grantHandle: issued.grantHandle },
        'inspect-1',
      )))?.revoked,
    ).toBe(true);
    expect(revokeMaterialization).toHaveBeenCalledWith(
      'vault-materialization:1',
    );
  });

  it('adopts and revokes a host-vault handle after adapter restart', async () => {
    const stored = new Map<string, CredentialGrantHandle>();
    const managedState = new Map<string, unknown>();
    const handleStore = {
      get: async (handle: string) => stored.get(handle),
      put: async (handle: string, value: CredentialGrantHandle) => {
        stored.set(handle, value);
      },
      delete: async (handle: string) => {
        stored.delete(handle);
      },
    };
    const stateStore = {
      get: async (key: string) => managedState.get(key),
      put: async (key: string, value: unknown) => {
        managedState.set(key, structuredClone(value));
      },
      delete: async (key: string) => {
        managedState.delete(key);
      },
    };
    const revokeMaterialization = vi.fn(async () => {});
    const createAdapter = () =>
      createManagedCredentialBrokerAdapter(
        createInMemoryCredentialBroker({
          signer: signer(),
          proofVerifier: { verifyAndConsume: async () => true },
          now,
        }),
        {
          name: 'durable-signed-broker',
          maxTtlMs: 60_000,
          now,
          materialize: async () => 'materialization:durable',
          revokeMaterialization,
          authorizeRequest: (request) => request.capabilityHandleRef === 'capability:credential-1',
          handleStore,
          stateStore,
          stableHandleFor: (request) => `credential://node-1/${request.resource.uid}`,
          threatAssumptions: ['the host credential vault is trusted and durable'],
        },
      );
    const issueRequest = envelope(
      'credential.issue',
      issuePayload(),
      'durable-issue',
      5,
    );
    const issued = await createAdapter().issue(issueRequest);
    expect(issued.grantHandle).toBe('credential://node-1/grant-uid-1');
    expect(stored.has(issued.grantHandle)).toBe(true);

    const restarted = createAdapter();
    expect(await restarted.getCapabilities()).toMatchObject({
      persistence: 'host',
    });
    expect((await restarted.issue(issueRequest)).grantHandle).toBe(
      issued.grantHandle,
    );
    expect(
      await restarted.inspect(envelope(
        'credential.inspect',
        { grantHandle: issued.grantHandle },
        'durable-inspect',
        5,
      )),
    ).toMatchObject({
      resourceUid: 'grant-uid-1',
      runUid: 'run-uid-1',
    });
    await expect(restarted.inspect(envelope(
      'credential.inspect',
      { grantHandle: issued.grantHandle },
      'durable-stale-inspect',
      4,
    ))).rejects.toMatchObject({ code: 'STALE_EPOCH' });
    await restarted.materialize(envelope(
      'credential.materialize',
      {
        grantHandle: issued.grantHandle,
        targetDriver: 'model-provider/openai',
        proof: {
          challengeId: 'challenge-durable',
          signature: base64UrlEncode(new Uint8Array([7])),
        },
      },
      'durable-materialize',
      5,
    ));

    await createAdapter().revoke(envelope(
      'credential.revoke',
      { grantHandle: issued.grantHandle },
      'durable-revoke',
      5,
    ));
    expect(stored.has(issued.grantHandle)).toBe(false);
    expect(revokeMaterialization).toHaveBeenCalledWith(
      'materialization:durable',
    );
    await expect(
      createAdapter().revoke(envelope(
        'credential.revoke',
        { grantHandle: 'credential://node-1/other-grant' },
        'durable-revoke',
        5,
      )),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('does not claim host persistence for a token vault without durable management state', async () => {
    const broker = createInMemoryCredentialBroker({
      signer: signer(),
      proofVerifier: { verifyAndConsume: async () => true },
      now,
    });
    const adapter = createManagedCredentialBrokerAdapter(broker, {
      name: 'vault-only',
      maxTtlMs: 60_000,
      now,
      materialize: async () => 'materialization:vault-only',
      authorizeRequest: () => true,
      handleStore: {
        get: async () => undefined,
        put: async () => {},
        delete: async () => {},
      },
      threatAssumptions: ['the vault persists tokens but not management state'],
    });

    await expect(adapter.getCapabilities()).resolves.toMatchObject({
      persistence: 'process',
    });
  });

  it('revokes a newly issued grant when trusted handle persistence fails', async () => {
    const broker = createInMemoryCredentialBroker({
      signer: signer(),
      proofVerifier: { verifyAndConsume: async () => true },
      now,
    });
    const revoke = vi.spyOn(broker, 'revoke');
    const adapter = createManagedCredentialBrokerAdapter(broker, {
      name: 'failing-host-vault',
      maxTtlMs: 60_000,
      now,
      materialize: async () => 'materialization:unreachable',
      authorizeRequest: () => true,
      handleStore: {
        get: async () => undefined,
        put: async () => {
          throw new Error('vault unavailable');
        },
        delete: async () => {},
      },
      threatAssumptions: ['the host vault may become unavailable'],
    });

    await expect(adapter.issue(envelope(
      'credential.issue',
      issuePayload(),
      'persistence-failure',
    ))).rejects.toMatchObject({
      code: 'UNKNOWN_EFFECT',
      retryable: false,
      details: { persistenceError: 'vault unavailable' },
    });
    expect(revoke).toHaveBeenCalledWith('grant-uid-1');
  });

  it('keeps the last durable token authoritative when renewal persistence fails', async () => {
    const broker = createInMemoryCredentialBroker({
      signer: signer(),
      proofVerifier: { verifyAndConsume: async () => true },
      now,
    });
    const stored = new Map<string, CredentialGrantHandle>();
    let rejectWrites = false;
    const adapter = createManagedCredentialBrokerAdapter(broker, {
      name: 'renewal-failure',
      maxTtlMs: 60_000,
      now,
      materialize: async () => 'materialization:renewal-failure',
      authorizeRequest: () => true,
      handleStore: {
        get: async (handle) => stored.get(handle),
        put: async (handle, value) => {
          if (rejectWrites) throw new Error('vault unavailable');
          stored.set(handle, value);
        },
        delete: async (handle) => {
          stored.delete(handle);
        },
      },
      stableHandleFor: (request) => `credential://${request.resource.uid}`,
      threatAssumptions: ['the vault may reject a renewal write'],
    });
    const issued = await adapter.issue(envelope(
      'credential.issue',
      issuePayload(),
      'renew-failure-issue',
    ));
    const originalExpiry = issued.expiresAt;
    rejectWrites = true;

    await expect(adapter.renew(envelope(
      'credential.renew',
      { grantHandle: issued.grantHandle, ttlMs: 40_000 },
      'renew-failure',
    ))).rejects.toThrow('vault unavailable');
    await expect(adapter.inspect(envelope(
      'credential.inspect',
      { grantHandle: issued.grantHandle },
      'renew-failure-inspect',
    ))).resolves.toMatchObject({ expiresAt: originalExpiry });
  });

  it('revokes a materialization when durable revocation metadata cannot be recorded', async () => {
    const broker = createInMemoryCredentialBroker({
      signer: signer(),
      proofVerifier: { verifyAndConsume: async () => true },
      now,
    });
    const stored = new Map<string, CredentialGrantHandle>();
    const managedState = new Map<string, unknown>();
    const revokeMaterialization = vi.fn(async () => {});
    const adapter = createManagedCredentialBrokerAdapter(broker, {
      name: 'materialization-state-failure',
      maxTtlMs: 60_000,
      now,
      materialize: async () => 'materialization:must-clean-up',
      revokeMaterialization,
      authorizeRequest: () => true,
      handleStore: {
        get: async (handle) => stored.get(handle),
        put: async (handle, value) => {
          stored.set(handle, value);
        },
        delete: async (handle) => {
          stored.delete(handle);
        },
      },
      stateStore: {
        get: async (key) => managedState.get(key),
        put: async (key, value) => {
          if (key.startsWith('materialization:')) {
            throw new Error('state unavailable');
          }
          managedState.set(key, value);
        },
        delete: async (key) => {
          managedState.delete(key);
        },
      },
      stableHandleFor: (request) => `credential://${request.resource.uid}`,
      threatAssumptions: ['target materialization is explicitly revocable'],
    });
    const issued = await adapter.issue(envelope(
      'credential.issue',
      issuePayload(),
      'materialization-failure-issue',
    ));

    await expect(adapter.materialize(envelope(
      'credential.materialize',
      {
        grantHandle: issued.grantHandle,
        targetDriver: 'model-provider/openai',
        proof: {
          challengeId: 'challenge-cleanup',
          signature: base64UrlEncode(new Uint8Array([7])),
        },
      },
      'materialization-failure',
    ))).rejects.toMatchObject({
      code: 'UNKNOWN_EFFECT',
      retryable: false,
      details: {
        persistenceError: 'state unavailable',
        cleanupSucceeded: true,
      },
    });
    expect(revokeMaterialization).toHaveBeenCalledWith(
      'materialization:must-clean-up',
    );
  });

  it('fails closed for unsupported exposure, driver scope, identity drift, and stale fencing', async () => {
    const broker = createInMemoryCredentialBroker({
      signer: signer(),
      proofVerifier: { verifyAndConsume: async () => true },
      now,
    });
    const adapter = createManagedCredentialBrokerAdapter(broker, {
      name: 'signed-credential-broker',
      maxTtlMs: 60_000,
      now,
      materialize: async () => 'materialization:1',
      authorizeRequest: (request) => request.capabilityHandleRef === 'capability:credential-1',
      threatAssumptions: ['the signer and target driver are trusted'],
    });

    await expect(adapter.issue(envelope(
      'credential.issue',
      issuePayload('none'),
      'unsupported-exposure',
    ))).rejects.toMatchObject({ code: 'UNSUPPORTED' });

    const issued = await adapter.issue(envelope(
      'credential.issue',
      issuePayload(),
      'issue-secure',
      5,
    ));
    await expect(adapter.inspect(envelope(
      'credential.inspect',
      { grantHandle: issued.grantHandle },
      'stale',
      4,
    ))).rejects.toMatchObject({ code: 'STALE_EPOCH' });

    await expect(adapter.materialize(envelope(
      'credential.materialize',
      {
        grantHandle: issued.grantHandle,
        targetDriver: 'tool-execution/local',
        proof: {
          challengeId: 'challenge-2',
          signature: base64UrlEncode(new Uint8Array([7])),
        },
      },
      'wrong-driver',
      5,
    ))).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const drifted = envelope(
      'credential.materialize',
      {
        grantHandle: issued.grantHandle,
        targetDriver: 'model-provider/openai',
        proof: {
          challengeId: 'challenge-3',
          signature: base64UrlEncode(new Uint8Array([7])),
        },
      },
      'wrong-worker',
      5,
    );
    drifted.session = {
      id: 'worker-session-2',
      keyFingerprint: 'ed25519:attacker',
    };
    await expect(adapter.materialize(drifted)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
