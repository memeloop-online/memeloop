import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  canonicalWorkerProtocolRequestBytes,
  createAgentRunManifest,
  createAgentWorkloadManifest,
  createWorkerEnrollmentManifest,
  type SignedWorkerBootstrapSessionDescriptor,
  WORKER_CHECKPOINT_API_VERSION,
  WORKER_CHECKPOINT_SCHEMA_VERSION,
  WORKER_PROTOCOL_VERSION,
  type WorkerGatewaySession,
  type WorkerProtocolMethod,
  type WorkerProtocolRequest,
} from 'memeloop';
import { describe, expect, it } from 'vitest';

import { hashWorkerBootstrapToken, workerBootstrapProofMessage } from '../../orchestration/nodeWorkerSecurity.js';
import { createWorkerArtifactUploadStore, type WorkerArtifactManifest } from '../../orchestration/workerArtifactUploadStore.js';
import { createNodeRuntime } from '../nodeRuntime.js';

const session = {
  name: 'worker-artifact-runtime-session',
  run: { uid: 'worker-artifact-runtime-run', attempt: 1, epoch: 1 },
} as WorkerGatewaySession;

describe('createNodeRuntime worker artifact lifecycle', () => {
  it('wires host artifact TTL configuration and the trusted run cleanup port', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-runtime-artifacts-'));
    let runtime: Awaited<ReturnType<typeof createNodeRuntime>> | undefined;
    try {
      const bytes = Buffer.from('runtime-owned-artifact');
      const seeded = createWorkerArtifactUploadStore(dataDir, {
        minFreeDiskBytes: 0,
        now: () => 1_000,
        statfs: async () => ({ availableBytes: 1_000_000n }),
      });
      const begin = await seeded.handle(session, {
        operation: 'begin',
        name: 'runtime-artifact',
        relativePath: 'dist/runtime-artifact.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: bytes.byteLength,
      }) as { uploadId: string };
      await seeded.handle(session, {
        operation: 'chunk',
        uploadId: begin.uploadId,
        offset: 0,
        byteLength: bytes.byteLength,
        sha256: hash(bytes),
        data: bytes.toString('base64'),
      });
      const manifest = await seeded.handle(session, {
        operation: 'commit',
        uploadId: begin.uploadId,
        sizeBytes: bytes.byteLength,
        contentHash: hash(bytes),
      }) as WorkerArtifactManifest;

      runtime = await createNodeRuntime({
        dataDir,
        localNodeId: 'worker-artifact-runtime-node',
        includeVscodeCli: false,
        llmProvider: {
          name: 'worker-artifact-test-provider',
          modelId: 'worker-artifact-test-model',
          chat: async function*() {
            yield { type: 'finish' as const, finishReason: 'stop' as const };
          },
        } as never,
        config: { providers: [] },
        externalDrivers: { enabled: false },
        workloadExecution: { enabled: false },
        workerGateway: {
          artifacts: {
            minFreeDiskBytes: 0,
            retainedArtifactTtlMs: 100,
            now: () => 1_100,
            statfs: async () => ({ availableBytes: 1_000_000n }),
          },
        },
      });

      expect(runtime.workerGateway?.artifacts.deleteArtifactsForRun).toEqual(expect.any(Function));
      await expect(runtime.workerGateway?.artifacts.resolveManifest(
        session.run.uid,
        manifest.artifactHandle,
      )).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(runtime.workerGateway?.artifacts.deleteArtifactsForRun(session.run.uid)).resolves.toBe(0);
      expect(fs.existsSync(path.join(dataDir, 'worker-artifacts', 'sha256', hash(bytes).slice(7))))
        .toBe(false);
    } finally {
      await runtime?.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('createNodeRuntime worker checkpoint gateway', () => {
  it('persists run-bound state across runtime restart and rejects another conversation', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-runtime-checkpoints-'));
    let first: Awaited<ReturnType<typeof createNodeRuntime>> | undefined;
    let second: Awaited<ReturnType<typeof createNodeRuntime>> | undefined;
    let server: http.Server | undefined;
    try {
      first = await runtimeForCheckpointTest(dataDir);
      const firstSession = await enrollCheckpointWorker(first, 'first');
      server = firstSession.server;
      const assignment = await firstSession.call('assignment.pull', {}) as {
        conversationId: string;
      };
      await expect(firstSession.call('checkpoint.save', {
        conversationId: assignment.conversationId,
        key: 'state:count',
        value: { count: 1 },
        expectedRevision: 0,
        fencingEpoch: 0,
      })).resolves.toMatchObject({ saved: true, revision: 1, fencingEpoch: 0 });
      await expect(firstSession.call('checkpoint.save', {
        conversationId: assignment.conversationId,
        key: 'state:count',
        value: { count: 2 },
        expectedRevision: 1,
        fencingEpoch: 0,
      })).resolves.toMatchObject({ saved: true, revision: 2, fencingEpoch: 0 });
      await expect(firstSession.call('checkpoint.load', {
        conversationId: 'external:default:another-workload',
        key: 'state:count',
      })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(firstSession.call('checkpoint.load', {
        conversationId: assignment.conversationId,
        key: 'state:count',
        extra: true,
      })).rejects.toMatchObject({ code: 'INVALID' });
      await expect(firstSession.call('checkpoint.save', {
        conversationId: assignment.conversationId,
        key: 'too-large',
        value: 'x'.repeat(512 * 1024 + 1),
      })).rejects.toMatchObject({ code: 'INVALID' });
      first.context.loopCheckpoints = undefined;
      await expect(firstSession.call('checkpoint.load', {
        conversationId: assignment.conversationId,
        key: 'state:count',
      })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
      await closeServer(server);
      server = undefined;
      await first.stop();
      first = undefined;

      second = await runtimeForCheckpointTest(dataDir);
      const secondSession = await enrollCheckpointWorker(second, 'second', firstSession.binding);
      server = secondSession.server;
      await expect(secondSession.call('checkpoint.load', {
        conversationId: assignment.conversationId,
        key: 'state:count',
      })).resolves.toMatchObject({ found: true, value: { count: 2 }, revision: 2, fencingEpoch: 0 });
    } finally {
      await closeServer(server);
      await first?.stop();
      await second?.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});

async function runtimeForCheckpointTest(dataDir: string) {
  return createNodeRuntime({
    dataDir,
    localNodeId: 'checkpoint-gateway-node',
    includeVscodeCli: false,
    logger: { warn() {} },
    llmProvider: {
      name: 'worker-checkpoint-test-provider',
      modelId: 'worker-checkpoint-test-model',
      chat: async function*() {
        yield { type: 'finish' as const, finishReason: 'stop' as const };
      },
    } as never,
    config: { providers: [] },
    externalDrivers: { enabled: false },
    workloadExecution: { enabled: false },
    workerGateway: { enabled: true },
  });
}

async function enrollCheckpointWorker(
  runtime: Awaited<ReturnType<typeof createNodeRuntime>>,
  suffix: string,
  binding?: { runUid: string },
): Promise<{
  server: http.Server;
  binding: { runUid: string };
  call(method: WorkerProtocolMethod, payload: unknown): Promise<unknown>;
}> {
  if (!runtime.workerGateway || !runtime.context.controlStore) throw new Error('worker gateway unavailable');
  const store = runtime.context.controlStore;
  const actor = { id: 'controller/checkpoint-test', kind: 'controller' as const };
  let runUid = binding?.runUid;
  if (!runUid) {
    const workload = await store.create(
      actor,
      createAgentWorkloadManifest(`checkpoint-workload-${suffix}`, {
        profileId: 'general',
        promptReference: 'test checkpoint persistence',
      }),
    );
    const run = await store.create(
      actor,
      createAgentRunManifest(`checkpoint-run-${suffix}`, {
        workloadRef: {
          apiVersion: workload.apiVersion,
          kind: workload.kind,
          name: workload.metadata.name,
          namespace: workload.metadata.namespace,
          uid: workload.metadata.uid,
        },
      }),
    );
    runUid = run.metadata.uid;
  }
  const token = randomBytes(32).toString('base64url');
  const pair = generateKeyPairSync('ed25519');
  const workerPublicKey = Buffer.from(pair.publicKey.export({ format: 'der', type: 'spki' })).toString('base64url');
  const enrollmentName = `checkpoint-enrollment-${suffix}`;
  await store.create(
    actor,
    createWorkerEnrollmentManifest(enrollmentName, {
      nodeRef: { apiVersion: 'nodes.memeloop.io/v1alpha1', kind: 'Node', name: 'checkpoint-gateway-node' },
      trustClass: 'restricted',
      expectedGateway: 'http://127.0.0.1',
      gatewayKeyFingerprint: runtime.workerGateway.publicKeyFingerprint,
      audience: 'worker-gateway://checkpoint-gateway-node',
      allowedProtocol: WORKER_PROTOCOL_VERSION,
      run: { uid: runUid, attempt: 1, epoch: 1 },
      policyDigest: 'sha256:checkpoint-test',
      allowedMethods: ['assignment.pull', 'checkpoint.load', 'checkpoint.save'],
      allowedTargets: [runUid],
      bootstrapTokenHash: hashWorkerBootstrapToken(token),
      enrolledBy: actor.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  const server = http.createServer(runtime.workerGateway.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('worker gateway did not bind');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const bootstrapResponse = await fetch(`${endpoint}/v1/worker/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enrollmentName,
      bootstrapToken: token,
      workerPublicKey,
      proofSignature: sign(
        null,
        workerBootstrapProofMessage(enrollmentName, token),
        pair.privateKey,
      ).toString('base64url'),
    }),
  });
  if (!bootstrapResponse.ok) throw new Error(`worker bootstrap failed: ${bootstrapResponse.status}`);
  const descriptor = await bootstrapResponse.json() as SignedWorkerBootstrapSessionDescriptor;
  let sequence = 0;
  return {
    server,
    binding: { runUid },
    async call(method, payload) {
      sequence += 1;
      if (method === 'checkpoint.load' || method === 'checkpoint.save') {
        const value = payload && typeof payload === 'object' && !Array.isArray(payload)
          ? payload as Record<string, unknown>
          : {};
        payload = {
          ...value,
          scope: value.scope ?? {
            scriptDigest: `sha256:${'0'.repeat(64)}`,
            apiVersion: WORKER_CHECKPOINT_API_VERSION,
            schemaVersion: WORKER_CHECKPOINT_SCHEMA_VERSION,
            runId: runUid,
          },
          ...(method === 'checkpoint.save'
            ? {
              expectedRevision: typeof value.expectedRevision === 'number' ? value.expectedRevision : 0,
              fencingEpoch: typeof value.fencingEpoch === 'number' ? value.fencingEpoch : 0,
            }
            : {}),
        };
      }
      const unsigned = {
        apiVersion: WORKER_PROTOCOL_VERSION,
        requestId: `checkpoint-${suffix}-${sequence}`,
        sessionName: descriptor.sessionName,
        sequence,
        nonce: randomBytes(16).toString('base64url'),
        deadline: new Date(Date.now() + 10_000).toISOString(),
        audience: descriptor.audience,
        run: descriptor.run,
        method,
        target: runUid,
        policyDigest: descriptor.policyDigest,
        payload,
      } satisfies Omit<WorkerProtocolRequest, 'signature'>;
      const response = await fetch(`${endpoint}/v1/worker/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          {
            ...unsigned,
            signature: sign(
              null,
              canonicalWorkerProtocolRequestBytes(unsigned),
              pair.privateKey,
            ).toString('base64url'),
          } satisfies WorkerProtocolRequest,
        ),
      });
      const result = await response.json() as {
        ok: boolean;
        payload?: unknown;
        error?: unknown;
      };
      if (!result.ok) throw result.error;
      return result.payload;
    },
  };
}

async function closeServer(server: http.Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function hash(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
