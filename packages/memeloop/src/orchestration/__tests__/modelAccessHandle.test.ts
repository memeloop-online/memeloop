import { describe, expect, it } from 'vitest';

import { OrchestrationError } from '../errors.js';
import { base64UrlDecode, base64UrlEncode, createInMemoryModelAccessHandleBroker, type ModelHandleSigner } from '../security/modelAccessHandle.js';

function fakeSigner(secret: string): ModelHandleSigner {
  const encoder = new TextEncoder();
  async function digest(payload: Uint8Array): Promise<Uint8Array> {
    const key = encoder.encode(secret);
    const mixed = new Uint8Array(payload.length + key.length);
    mixed.set(payload);
    mixed.set(key, payload.length);
    let hash = 0x81_1c_9d_c5;
    for (const byte of mixed) {
      hash = Math.imul(hash ^ byte, 0x01_00_01_93) >>> 0;
    }
    return new Uint8Array([hash & 0xff, (hash >> 8) & 0xff, (hash >> 16) & 0xff, (hash >> 24) & 0xff]);
  }
  return {
    sign: digest,
    verify: async (payload, signature) => {
      const expected = await digest(payload);
      return expected.length === signature.length && expected.every((byte, index) => byte === signature[index]);
    },
  };
}

const MODEL_REF = { apiVersion: 'models.memeloop.io/v1alpha1', kind: 'ModelClass', name: 'mock-1' };

describe('base64url', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlDecode(encoded))).toEqual(Array.from(bytes));
  });

  it('round-trips empty and single-byte inputs', () => {
    expect(Array.from(base64UrlDecode(base64UrlEncode(new Uint8Array([]))))).toEqual([]);
    expect(Array.from(base64UrlDecode(base64UrlEncode(new Uint8Array([42]))))).toEqual([42]);
  });
});

describe('createInMemoryModelAccessHandleBroker', () => {
  it('issues and verifies a handle binding run, attempt, worker key, budget, and expiry', async () => {
    const broker = createInMemoryModelAccessHandleBroker({ signer: fakeSigner('s1'), audience: 'gateway://default' });
    const handle = await broker.issueModelAccessHandle({
      runRef: { apiVersion: 'run.memeloop.io/v1alpha1', kind: 'AgentRun', name: 'run-1', uid: 'uid-run-1' },
      attempt: 2,
      workerKey: 'worker-fp-1',
      modelClassRef: MODEL_REF,
      modelDigest: 'sha256:m1',
      policyDigest: 'sha256:policy',
      budget: { maxInputTokens: 10_000, maxOutputTokens: 2000, maxCost: 0.5, currency: 'USD', maxConcurrent: 1 },
      ttlMs: 60_000,
    });

    expect(handle.token.startsWith('mlh1.')).toBe(true);
    expect(handle.claims.audience).toBe('gateway://default');
    expect(handle.claims.workerKey).toBe('worker-fp-1');
    expect(handle.claims.budget?.maxCost).toBe(0.5);

    const verified = await broker.verifyModelAccessHandle(handle.token, { workerKey: 'worker-fp-1' });
    expect(verified.handleId).toBe(handle.claims.handleId);
    expect(verified.runRef?.name).toBe('run-1');
    expect(verified.attempt).toBe(2);
  });

  it('rejects tampered tokens', async () => {
    const broker = createInMemoryModelAccessHandleBroker({ signer: fakeSigner('s1'), audience: 'gateway://default' });
    const handle = await broker.issueModelAccessHandle({ modelClassRef: MODEL_REF });
    const parts = handle.token.split('.');
    const tamperedPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ ...handle.claims, handleId: 'forged' })));
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    await expect(broker.verifyModelAccessHandle(tampered)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects expired handles', async () => {
    let current = new Date('2026-07-16T00:00:00.000Z');
    const broker = createInMemoryModelAccessHandleBroker({
      signer: fakeSigner('s1'),
      audience: 'gateway://default',
      now: () => current,
      defaultTtlMs: 1000,
    });
    const handle = await broker.issueModelAccessHandle({ modelClassRef: MODEL_REF });

    current = new Date('2026-07-16T00:00:02.000Z');
    await expect(broker.verifyModelAccessHandle(handle.token)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('rejects audience mismatch', async () => {
    const broker = createInMemoryModelAccessHandleBroker({ signer: fakeSigner('s1'), audience: 'gateway://default' });
    const handle = await broker.issueModelAccessHandle({ modelClassRef: MODEL_REF });

    await expect(broker.verifyModelAccessHandle(handle.token, { audience: 'gateway://other' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects worker key mismatch when a key is bound', async () => {
    const broker = createInMemoryModelAccessHandleBroker({ signer: fakeSigner('s1'), audience: 'gateway://default' });
    const handle = await broker.issueModelAccessHandle({ modelClassRef: MODEL_REF, workerKey: 'worker-fp-1' });

    await expect(broker.verifyModelAccessHandle(handle.token, { workerKey: 'worker-fp-2' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('caps requested TTL at the broker maximum', async () => {
    const now = new Date('2026-07-16T00:00:00.000Z');
    const broker = createInMemoryModelAccessHandleBroker({
      signer: fakeSigner('s1'),
      audience: 'gateway://default',
      now: () => now,
      maxTtlMs: 1000,
    });
    const handle = await broker.issueModelAccessHandle({ modelClassRef: MODEL_REF, ttlMs: 10_000_000 });
    expect(Date.parse(handle.claims.expiresAt) - Date.parse(handle.claims.issuedAt)).toBe(1000);
  });

  it('rejects issuance without a model reference', async () => {
    const broker = createInMemoryModelAccessHandleBroker({ signer: fakeSigner('s1'), audience: 'gateway://default' });
    await expect(
      broker.issueModelAccessHandle({ modelClassRef: { apiVersion: '', kind: '', name: '' } }),
    ).rejects.toBeInstanceOf(OrchestrationError);
  });

  it('rejects partial or inexact Run bindings', async () => {
    const broker = createInMemoryModelAccessHandleBroker({
      signer: fakeSigner('s1'),
      audience: 'gateway://default',
    });
    await expect(broker.issueModelAccessHandle({
      modelClassRef: MODEL_REF,
      runRef: {
        apiVersion: 'run.memeloop.io/v1alpha1',
        kind: 'AgentRun',
        name: 'run-without-uid',
      },
      attempt: 1,
    })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(broker.issueModelAccessHandle({
      modelClassRef: MODEL_REF,
      attempt: 1,
    })).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('rejects malformed tokens', async () => {
    const broker = createInMemoryModelAccessHandleBroker({ signer: fakeSigner('s1'), audience: 'gateway://default' });
    await expect(broker.verifyModelAccessHandle('not-a-handle')).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('rejects revoked handles before expiry', async () => {
    const broker = createInMemoryModelAccessHandleBroker({ signer: fakeSigner('s1'), audience: 'gateway://default' });
    const handle = await broker.issueModelAccessHandle({ modelClassRef: MODEL_REF });

    await expect(broker.verifyModelAccessHandle(handle.token)).resolves.toMatchObject({ handleId: handle.claims.handleId });

    broker.revokeModelAccessHandle(handle.claims.handleId);
    await expect(broker.verifyModelAccessHandle(handle.token)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
