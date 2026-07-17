import { describe, expect, it } from 'vitest';

import { createInMemoryCredentialBroker } from '../credentialBroker.js';
import type { ModelHandleSigner } from '../modelAccessHandle.js';
import { createCredentialGrantManifest, isCredentialGrant } from '../resources.js';

function fakeSigner(secret: string): ModelHandleSigner {
  const encoder = new TextEncoder();
  async function digest(payload: Uint8Array): Promise<Uint8Array> {
    const mixed = new Uint8Array(payload.length + secret.length);
    mixed.set(payload);
    mixed.set(encoder.encode(secret), payload.length);
    let hash = 0x81_1c_9d_c5;
    for (const byte of mixed) hash = Math.imul(hash ^ byte, 0x01_00_01_93) >>> 0;
    return new Uint8Array([hash & 0xff, (hash >> 8) & 0xff, (hash >> 16) & 0xff, (hash >> 24) & 0xff]);
  }
  return {
    sign: digest,
    verify: async (payload, signature) => {
      const expected = await digest(payload);
      return expected.every((byte, index) => byte === signature[index]);
    },
  };
}

const SCOPE = {
  runRef: { apiVersion: 'run.memeloop.io/v1alpha1', kind: 'AgentRun', name: 'run-1', uid: 'uid-run-1' },
  attempt: 1,
  workerKey: 'worker-fp-1',
  target: 'ssh://edge-node-7',
  method: 'exec',
  audience: 'broker://default',
  policyDigest: 'sha256:policy',
};

describe('CredentialGrant resource schema', () => {
  it('creates manifests that record scope without secrets', () => {
    const manifest = createCredentialGrantManifest('grant-1', {
      ...SCOPE,
      budget: { maxCalls: 10, maxCost: 1, currency: 'USD' },
      ttlMs: 300_000,
    });
    expect(manifest.apiVersion).toBe('security.memeloop.io/v1alpha1');
    expect(manifest.kind).toBe('CredentialGrant');
    expect(manifest.spec.target).toBe('ssh://edge-node-7');
    expect(isCredentialGrant(manifest)).toBe(true);
    expect(isCredentialGrant({ apiVersion: 'security.memeloop.io/v1alpha1', kind: 'SecurityProfile' })).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain('token');
  });
});

describe('createInMemoryCredentialBroker', () => {
  it('issues, verifies, and inspects a fully scoped grant', async () => {
    const broker = createInMemoryCredentialBroker({ signer: fakeSigner('s1') });
    const handle = await broker.issue(SCOPE);

    expect(handle.token.startsWith('mlcg1.')).toBe(true);
    const claims = await broker.verify(handle.token, {
      target: 'ssh://edge-node-7',
      method: 'exec',
      audience: 'broker://default',
      workerKey: 'worker-fp-1',
    });
    expect(claims.runRef?.name).toBe('run-1');
    expect(claims.attempt).toBe(1);

    const inspection = await broker.inspect(handle.token);
    expect(inspection.exposure).toBe('worker-visible');
    expect(inspection.rotationRequired).toBe(true);
    expect(inspection.rotationReason).toContain('rotate');
    expect(inspection.revoked).toBe(false);
  });

  it('rejects target, method, audience, and worker-key mismatches', async () => {
    const broker = createInMemoryCredentialBroker({ signer: fakeSigner('s1') });
    const handle = await broker.issue(SCOPE);

    await expect(broker.verify(handle.token, { target: 'ssh://other', method: 'exec' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(broker.verify(handle.token, { target: 'ssh://edge-node-7', method: 'read' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(broker.verify(handle.token, { target: 'ssh://edge-node-7', method: 'exec', audience: 'broker://other' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(broker.verify(handle.token, { target: 'ssh://edge-node-7', method: 'exec', workerKey: 'worker-fp-2' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('renews unexpired grants and refuses renewal after revocation', async () => {
    let current = new Date('2026-07-17T00:00:00.000Z');
    const broker = createInMemoryCredentialBroker({ signer: fakeSigner('s1'), now: () => current, defaultTtlMs: 60_000 });
    const handle = await broker.issue(SCOPE);

    current = new Date('2026-07-17T00:00:30.000Z');
    const renewed = await broker.renew(handle.token);
    expect(renewed.claims.renewedAt).toBe('2026-07-17T00:00:30.000Z');
    expect(Date.parse(renewed.claims.expiresAt)).toBeGreaterThan(Date.parse(handle.claims.expiresAt));

    broker.revoke(handle.claims.grantId);
    await expect(broker.renew(renewed.token)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(broker.verify(renewed.token, { target: 'ssh://edge-node-7', method: 'exec' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects expired grants', async () => {
    let current = new Date('2026-07-17T00:00:00.000Z');
    const broker = createInMemoryCredentialBroker({ signer: fakeSigner('s1'), now: () => current, defaultTtlMs: 1000 });
    const handle = await broker.issue(SCOPE);

    current = new Date('2026-07-17T00:00:02.000Z');
    await expect(broker.verify(handle.token, { target: 'ssh://edge-node-7', method: 'exec' }))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('requires target, method, and audience at issuance', async () => {
    const broker = createInMemoryCredentialBroker({ signer: fakeSigner('s1') });
    await expect(broker.issue({ ...SCOPE, target: '' })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(broker.issue({ ...SCOPE, method: '' })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(broker.issue({ ...SCOPE, audience: '' })).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('marks revoked grants as rotation-required in inspection', async () => {
    const broker = createInMemoryCredentialBroker({ signer: fakeSigner('s1') });
    const handle = await broker.issue({ target: 'vault:db', method: 'read', audience: 'broker://default' });

    let inspection = await broker.inspect(handle.token);
    expect(inspection.exposure).toBe('none');
    expect(inspection.rotationRequired).toBe(false);

    broker.revoke(handle.claims.grantId);
    inspection = await broker.inspect(handle.token);
    expect(inspection.revoked).toBe(true);
    expect(inspection.rotationRequired).toBe(true);
  });
});
