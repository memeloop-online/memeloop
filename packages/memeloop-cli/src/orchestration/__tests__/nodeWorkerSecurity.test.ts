import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createWorkerSessionManifest, WORKER_PROTOCOL_VERSION, WORKER_SESSION_API_VERSION, WORKER_SESSION_KIND, type WorkerSessionStatus } from 'memeloop';
import { describe, expect, it } from 'vitest';

import {
  createControlStoreWorkerReplayProtector,
  fingerprintWorkerPublicKey,
  hashWorkerBootstrapToken,
  loadOrCreateWorkerGatewayKeyPair,
  resolveControlStoreWorkerGatewaySession,
  verifyWorkerBootstrapToken,
  verifyWorkerEd25519Signature,
  workerBootstrapProofMessage,
} from '../nodeWorkerSecurity.js';
import { SQLiteControlStore } from '../sqliteControlStore.js';

const actor = { id: 'controller/worker-gateway', kind: 'controller' as const };

function keys() {
  const pair = generateKeyPairSync('ed25519');
  const publicDer = pair.publicKey.export({ format: 'der', type: 'spki' });
  return {
    privateKey: pair.privateKey,
    publicKey: Buffer.from(publicDer).toString('base64url'),
  };
}

describe('Node worker security ports', () => {
  it('hashes high-entropy bootstrap tokens and compares them safely', () => {
    const token = 'a'.repeat(32);
    const hash = hashWorkerBootstrapToken(token);
    expect(hash).toMatch(/^sha256:[A-Za-z0-9_-]+$/);
    expect(verifyWorkerBootstrapToken(token, hash)).toBe(true);
    expect(verifyWorkerBootstrapToken(`${token}x`, hash)).toBe(false);
    expect(() => hashWorkerBootstrapToken('short')).toThrow('at least 32 bytes');
  });

  it('fingerprints Ed25519 keys and verifies bootstrap/message signatures', () => {
    const pair = keys();
    const message = workerBootstrapProofMessage('enrollment-1', 'b'.repeat(32));
    const signature = sign(null, message, pair.privateKey).toString('base64url');
    expect(fingerprintWorkerPublicKey(pair.publicKey)).toMatch(/^sha256:/);
    expect(verifyWorkerEd25519Signature(pair.publicKey, message, signature)).toBe(true);
    expect(verifyWorkerEd25519Signature(pair.publicKey, new TextEncoder().encode('tampered'), signature)).toBe(false);
  });

  it('persists a stable private gateway identity with restrictive permissions', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-worker-key-'));
    const first = loadOrCreateWorkerGatewayKeyPair(directory);
    const second = loadOrCreateWorkerGatewayKeyPair(directory);
    expect(second.publicKeyFingerprint).toBe(first.publicKeyFingerprint);
    const message = new TextEncoder().encode('gateway-proof');
    expect(verifyWorkerEd25519Signature(first.publicKey, message, first.sign(message))).toBe(true);
    expect(fs.statSync(path.join(directory, 'worker-gateway-ed25519.pk8')).mode & 0o777).toBe(0o600);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('persists the sequence fence and resolves only active scoped sessions', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-worker-security-'));
    const store = new SQLiteControlStore({
      filename: path.join(directory, 'control.db'),
      authorizer: { authorize: () => {} },
    });
    const pair = keys();
    const manifest = createWorkerSessionManifest('session-1', {
      enrollmentRef: { apiVersion: 'security.memeloop.io/v1alpha1', kind: 'WorkerEnrollment', name: 'enrollment-1' },
      workerKeyFingerprint: fingerprintWorkerPublicKey(pair.publicKey),
      workerPublicKey: pair.publicKey,
      audience: 'worker-gateway://node-1',
      allowedProtocol: WORKER_PROTOCOL_VERSION,
      run: { uid: 'run-uid-1', attempt: 1, epoch: 2 },
      policyDigest: 'sha256:policy',
      allowedMethods: ['assignment.pull'],
      allowedTargets: ['run-uid-1'],
      ttlMs: 60_000,
    });
    const created = await store.create(actor, manifest);
    const active: WorkerSessionStatus = {
      phase: 'Active',
      issuedAt: '2026-07-23T10:00:00.000Z',
      expiresAt: '2099-07-23T10:01:00.000Z',
    };
    await store.updateStatus(
      actor,
      { apiVersion: WORKER_SESSION_API_VERSION, kind: WORKER_SESSION_KIND, name: 'session-1' },
      active,
      { resourceVersion: created.metadata.resourceVersion },
    );

    const firstGateway = createControlStoreWorkerReplayProtector(store, actor);
    expect(await firstGateway.consume('session-1', 1, 'abcdefghijklmnop')).toBe(true);
    const restartedGateway = createControlStoreWorkerReplayProtector(store, actor);
    expect(await restartedGateway.consume('session-1', 1, 'abcdefghijklmnop')).toBe(false);
    expect(await restartedGateway.consume('session-1', 3, 'qrstuvwxyzABCDEF')).toBe(false);
    expect(await restartedGateway.consume('session-1', 2, 'qrstuvwxyzABCDEF')).toBe(true);

    await expect(resolveControlStoreWorkerGatewaySession(store, 'session-1')).resolves.toMatchObject({
      name: 'session-1',
      run: { uid: 'run-uid-1', attempt: 1, epoch: 2 },
      allowedMethods: ['assignment.pull'],
    });
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
