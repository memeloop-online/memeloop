import { describe, expect, it } from 'vitest';

import { OrchestrationError } from '../errors.js';
import { WORKER_PROTOCOL_VERSION, type WorkerGatewaySession } from '../security/workerProtocol.js';
import {
  canonicalWorkloadCapabilityGrantBytes,
  consumeWorkloadCapabilityGrant,
  issueWorkloadCapabilityGrant,
  markWorkloadCapabilityGrantUnknownEffect,
  verifyWorkloadCapabilityGrant,
  type WorkloadCapabilityBudget,
  type WorkloadCapabilityGrantRequirements,
} from '../security/workloadCapabilityGrant.js';
import { QuorumControlStore } from '../stores/quorumControlStore.js';

const NOW = new Date('2026-07-26T10:00:00.000Z');
const actor = { id: 'controller/capability-broker', kind: 'controller' as const };
const session: WorkerGatewaySession = {
  name: 'session-1',
  workerKeyFingerprint: 'sha256:worker-key',
  workerPublicKey: 'worker-public-key',
  audience: 'worker-gateway://node-a',
  protocol: WORKER_PROTOCOL_VERSION,
  expiresAt: '2026-07-26T10:05:00.000Z',
  revoked: false,
  run: { uid: 'run-1', attempt: 2, epoch: 3 },
  policyDigest: 'sha256:policy',
  allowedMethods: ['capability.request'],
  allowedTargets: ['run-1'],
};
const channelBinding = 'gateway-key:sha256:gateway';

function signature(message: Uint8Array): string {
  return `test-signature:${Buffer.from(message).toString('base64url')}`;
}

function requirements(): WorkloadCapabilityGrantRequirements {
  return {
    grantId: 'grant-1',
    sessionName: session.name,
    run: session.run,
    workerKeyFingerprint: session.workerKeyFingerprint,
    channelBinding,
    audience: session.audience,
    protocol: session.protocol,
    protocolMethod: 'capability.request',
    capability: 'runAgent',
    target: 'run-1',
    policyDigest: session.policyDigest,
  };
}

describe('WorkloadCapabilityGrant', () => {
  it('canonicalizes signed nested keys independently of the host locale', () => {
    const bytes = canonicalWorkloadCapabilityGrantBytes({
      signature: 'excluded',
      z: 2,
      ä: 1,
    } as never);
    expect(new TextDecoder().decode(bytes)).toBe('{"z":2,"ä":1}');
  });

  it('issues, verifies, persists, and atomically consumes a signed single-use grant', async () => {
    const store = new QuorumControlStore({ memberId: 'n1', voters: ['n1'] });
    const grant = await issueWorkloadCapabilityGrant(
      store,
      actor,
      {
        grantId: 'grant-1',
        session,
        channelBinding,
        protocolMethod: 'capability.request',
        capability: 'runAgent',
        target: 'run-1',
        budget: { maxRequests: 1, maxInputBytes: 4096, maxOutputBytes: 8192 },
        ttlMs: 10 * 60_000,
      },
      signature,
      () => NOW,
    );

    expect(grant).toMatchObject({
      apiVersion: 'security.memeloop.io/v1alpha1',
      kind: 'WorkloadCapabilityGrant',
      metadata: { name: 'grant-1' },
      spec: {
        grantId: 'grant-1',
        run: session.run,
        workerKeyFingerprint: session.workerKeyFingerprint,
        channelBinding,
        expiresAt: session.expiresAt,
        budget: { maxRequests: 1 },
      },
      status: { phase: 'Authorized' },
    });
    await expect(
      verifyWorkloadCapabilityGrant(
        grant,
        requirements(),
        (message, signed) => signed === signature(message),
        () => NOW,
      ),
    ).resolves.toBeUndefined();

    const consumed = await consumeWorkloadCapabilityGrant(store, actor, grant, () => NOW);
    expect(consumed.status).toEqual({
      phase: 'Consumed',
      consumedAt: NOW.toISOString(),
    });
    await expect(consumeWorkloadCapabilityGrant(store, actor, consumed, () => NOW))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects untrusted issuers, scope escalation, and invalid budgets', async () => {
    const store = new QuorumControlStore({ memberId: 'n1', voters: ['n1'] });
    const base = {
      grantId: 'grant-1',
      session,
      channelBinding,
      protocolMethod: 'capability.request' as const,
      capability: 'runAgent',
      target: 'run-1',
      budget: { maxRequests: 1 as const },
      ttlMs: 60_000,
    };

    await expect(
      issueWorkloadCapabilityGrant(
        store,
        { id: 'worker/hostile', kind: 'verifier' },
        base,
        signature,
        () => NOW,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      issueWorkloadCapabilityGrant(
        store,
        actor,
        { ...base, target: 'another-run' },
        signature,
        () => NOW,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      issueWorkloadCapabilityGrant(
        store,
        actor,
        {
          ...base,
          budget: { maxRequests: 0 } as unknown as WorkloadCapabilityBudget,
        },
        signature,
        () => NOW,
      ),
    ).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('fails verification on tampering, expiry, or a non-authorized lifecycle phase', async () => {
    const store = new QuorumControlStore({ memberId: 'n1', voters: ['n1'] });
    const grant = await issueWorkloadCapabilityGrant(
      store,
      actor,
      {
        grantId: 'grant-1',
        session,
        channelBinding,
        protocolMethod: 'capability.request',
        capability: 'runAgent',
        target: 'run-1',
        budget: { maxRequests: 1 },
        ttlMs: 60_000,
      },
      signature,
      () => NOW,
    );
    const verifier = (message: Uint8Array, signed: string) => signed === signature(message);

    await expect(
      verifyWorkloadCapabilityGrant(
        { ...grant, spec: { ...grant.spec, target: 'tampered' } },
        requirements(),
        verifier,
        () => NOW,
      ),
    ).rejects.toBeInstanceOf(OrchestrationError);
    await expect(
      verifyWorkloadCapabilityGrant(
        { ...grant, spec: { ...grant.spec, signature: 'forged' } },
        requirements(),
        verifier,
        () => NOW,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      verifyWorkloadCapabilityGrant(
        { ...grant, spec: { ...grant.spec, expiresAt: 'not-a-date' } },
        requirements(),
        verifier,
        () => NOW,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      verifyWorkloadCapabilityGrant(
        grant,
        requirements(),
        verifier,
        () => new Date('2026-07-26T10:02:00.000Z'),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      verifyWorkloadCapabilityGrant(
        { ...grant, status: { phase: 'Revoked' } },
        requirements(),
        verifier,
        () => NOW,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('records unknown effect after a consumed grant loses execution outcome', async () => {
    const store = new QuorumControlStore({ memberId: 'n1', voters: ['n1'] });
    const grant = await issueWorkloadCapabilityGrant(
      store,
      actor,
      {
        grantId: 'grant-unknown',
        session: { ...session, name: 'session-unknown' },
        channelBinding,
        protocolMethod: 'capability.request',
        capability: 'runAgent',
        target: 'run-1',
        budget: { maxRequests: 1 },
        ttlMs: 60_000,
      },
      signature,
      () => NOW,
    );
    const consumed = await consumeWorkloadCapabilityGrant(store, actor, grant, () => NOW);
    const unknown = await markWorkloadCapabilityGrantUnknownEffect(
      store,
      actor,
      consumed,
      'client disconnected after execution started',
      () => NOW,
    );
    expect(unknown.status).toMatchObject({
      phase: 'UnknownEffect',
      unknownEffectAt: NOW.toISOString(),
      reason: 'client disconnected after execution started',
    });
    await expect(markWorkloadCapabilityGrantUnknownEffect(store, actor, unknown, 'duplicate'))
      .resolves.toEqual(unknown);
  });
});
