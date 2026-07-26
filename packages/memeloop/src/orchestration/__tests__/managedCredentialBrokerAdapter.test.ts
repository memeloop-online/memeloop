import { describe, expect, it, vi } from 'vitest';

import type { CredentialIssuePayload } from '../drivers/credentialManagement.js';
import { DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';
import { createManagedCredentialBrokerAdapter } from '../drivers/managedCredentialBrokerAdapter.js';
import { createInMemoryCredentialBroker, type CredentialProofVerifier } from '../security/credentialBroker.js';
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
    expect(issued.grantHandle).not.toContain('mlcg1');
    expect(issued).toMatchObject({
      resourceUid: 'grant-uid-1',
      runUid: 'run-uid-1',
      attempt: 1,
    });

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
