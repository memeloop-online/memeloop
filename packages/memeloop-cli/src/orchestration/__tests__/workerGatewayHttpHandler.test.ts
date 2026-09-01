import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  canonicalWorkerBootstrapDescriptorBytes,
  canonicalWorkerProtocolRequestBytes,
  createWorkerEnrollmentManifest,
  type SignedWorkerBootstrapSessionDescriptor,
  WORKER_PROTOCOL_VERSION,
  type WorkerProtocolRequest,
} from 'memeloop';
import { afterEach, describe, expect, it } from 'vitest';

import { fingerprintWorkerPublicKey, hashWorkerBootstrapToken, verifyWorkerEd25519Signature, workerBootstrapProofMessage } from '../nodeWorkerSecurity.js';
import { SQLiteControlStore } from '../sqliteControlStore.js';
import {
  createWorkerGatewayHttpHandler,
  DEFAULT_WORKER_GATEWAY_SESSION_TTL_MS,
  MAX_WORKER_GATEWAY_SESSION_TTL_MS,
  normalizeWorkerGatewaySessionTtlMs,
} from '../workerGatewayHttpHandler.js';

const actor = { id: 'controller/worker-gateway', kind: 'controller' as const };
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        })
      )
    ),
  );
});

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

describe('worker gateway HTTP boundary', () => {
  it('normalizes one bounded positive session TTL policy for every host route', () => {
    expect(normalizeWorkerGatewaySessionTtlMs(undefined)).toBe(
      DEFAULT_WORKER_GATEWAY_SESSION_TTL_MS,
    );
    expect(normalizeWorkerGatewaySessionTtlMs(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_WORKER_GATEWAY_SESSION_TTL_MS,
    );
    expect(() => normalizeWorkerGatewaySessionTtlMs(0)).toThrow(TypeError);
    expect(() => normalizeWorkerGatewaySessionTtlMs(Number.NaN)).toThrow(TypeError);
  });

  it('bootstraps once, verifies signed messages, and retains replay state across handlers', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-worker-http-'));
    const store = new SQLiteControlStore({
      filename: path.join(directory, 'control.db'),
      authorizer: { authorize: () => {} },
    });
    const token = randomBytes(32).toString('base64url');
    const pair = generateKeyPairSync('ed25519');
    const publicKey = Buffer.from(pair.publicKey.export({ format: 'der', type: 'spki' })).toString('base64url');
    const gatewayPair = generateKeyPairSync('ed25519');
    const gatewayPublicKey = Buffer.from(gatewayPair.publicKey.export({
      format: 'der',
      type: 'spki',
    })).toString('base64url');
    const gatewayKeyFingerprint = fingerprintWorkerPublicKey(gatewayPublicKey);
    await store.create(
      actor,
      createWorkerEnrollmentManifest('enrollment-1', {
        nodeRef: { apiVersion: 'nodes.memeloop.io/v1alpha1', kind: 'Node', name: 'node-1' },
        trustClass: 'quarantine',
        expectedGateway: 'https://gateway.example.test',
        gatewayKeyFingerprint,
        audience: 'worker-gateway://node-1',
        allowedProtocol: WORKER_PROTOCOL_VERSION,
        run: { uid: 'run-uid-1', attempt: 1, epoch: 3 },
        policyDigest: 'sha256:policy',
        allowedMethods: ['assignment.pull'],
        allowedTargets: ['run-uid-1'],
        bootstrapTokenHash: hashWorkerBootstrapToken(token),
        enrolledBy: actor.id,
        expiresAt: '2099-07-23T10:00:00.000Z',
      }),
    );
    const dispatches: unknown[] = [];
    const makeHandler = () =>
      createWorkerGatewayHttpHandler({
        store,
        actor,
        gatewayKeyFingerprint,
        signBootstrap: (message) => sign(null, message, gatewayPair.privateKey).toString('base64url'),
        dispatch: async (request) => {
          dispatches.push(request);
          return { assignment: 'redacted-workload' };
        },
      });
    const endpoint = await listen(makeHandler());
    const proof = sign(
      null,
      workerBootstrapProofMessage('enrollment-1', token),
      pair.privateKey,
    ).toString('base64url');
    const bootstrap = await fetch(`${endpoint}/v1/worker/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enrollmentName: 'enrollment-1',
        bootstrapToken: token,
        workerPublicKey: publicKey,
        proofSignature: proof,
      }),
    });
    expect(bootstrap.status).toBe(200);
    const descriptor = await bootstrap.json() as SignedWorkerBootstrapSessionDescriptor;
    expect(verifyWorkerEd25519Signature(
      gatewayPublicKey,
      canonicalWorkerBootstrapDescriptorBytes(descriptor),
      descriptor.gatewaySignature,
    )).toBe(true);
    const unsigned = {
      apiVersion: WORKER_PROTOCOL_VERSION,
      requestId: 'request-1',
      sessionName: descriptor.sessionName,
      sequence: 1,
      nonce: randomBytes(16).toString('base64url'),
      deadline: new Date(Date.now() + 10_000).toISOString(),
      audience: descriptor.audience,
      run: descriptor.run,
      method: 'assignment.pull' as const,
      target: 'run-uid-1',
      policyDigest: descriptor.policyDigest,
      payload: {},
    } satisfies Omit<WorkerProtocolRequest, 'signature'>;
    const message: WorkerProtocolRequest = {
      ...unsigned,
      signature: sign(
        null,
        canonicalWorkerProtocolRequestBytes(unsigned),
        pair.privateKey,
      ).toString('base64url'),
    };
    const accepted = await fetch(`${endpoint}/v1/worker/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      ok: true,
      payload: { assignment: 'redacted-workload' },
    });
    expect(dispatches).toHaveLength(1);

    const restartedEndpoint = await listen(makeHandler());
    const replay = await fetch(`${restartedEndpoint}/v1/worker/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
    });
    expect(replay.status).toBe(403);
    await expect(replay.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });

    const stolen = await fetch(`${endpoint}/v1/worker/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enrollmentName: 'enrollment-1',
        bootstrapToken: token,
        workerPublicKey: Buffer.from(
          generateKeyPairSync('ed25519').publicKey.export({
            format: 'der',
            type: 'spki',
          }),
        ).toString('base64url'),
        proofSignature: proof,
      }),
    });
    expect(stolen.status).toBe(403);
    expect(
      await store.get({
        apiVersion: 'security.memeloop.io/v1alpha1',
        kind: 'WorkerSession',
        name: descriptor.sessionName,
      }),
    ).toMatchObject({
      spec: { workerKeyFingerprint: fingerprintWorkerPublicKey(publicKey) },
      status: { lastSequence: 1 },
    });
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
