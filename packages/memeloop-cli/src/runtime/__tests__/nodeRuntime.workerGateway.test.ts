import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  AUDIT_RECORD_API_VERSION,
  AUDIT_RECORD_KIND,
  type AuditRecordResource,
  createAgentRunManifest,
  createAgentWorkloadManifest,
  createWorkerEnrollmentManifest,
  WORKER_PROTOCOL_VERSION,
} from 'memeloop';
import { describe, expect, it } from 'vitest';

import { hashWorkerBootstrapToken } from '../../orchestration/nodeWorkerSecurity.js';
import { SQLiteAgentStorage } from '../../storage/sqliteStorage.js';
import { createNodeRuntime } from '../nodeRuntime.js';

const execute = promisify(execFile);
const workerEntrypoint = fileURLToPath(
  new URL(
    '../../../../memeloop-worker-runtime/src/entrypoint.mjs',
    import.meta.url,
  ),
);
const actor = { id: 'controller/worker-gateway-test', kind: 'controller' as const };

describe('createNodeRuntime dedicated worker gateway', () => {
  it('rejects a private CA that cannot fit in the bounded native bootstrap Secret', async () => {
    await expect(
      createNodeRuntime({
        config: { providers: [] },
        dataDir: path.join(os.tmpdir(), 'must-not-be-created'),
        workerGateway: { caCertificate: 'x'.repeat(8 * 1024 + 1) },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID',
      message: expect.stringContaining('8 KiB'),
    });
  });

  it('runs a profile-only external worker through enrollment, signatures, and ModelGateway', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-node-worker-gateway-'));
    const warnings: unknown[] = [];
    const runtime = await createNodeRuntime({
      dataDir,
      localNodeId: 'node-gateway',
      config: { providers: [] },
      includeVscodeCli: false,
      logger: {
        warn: (...arguments_: unknown[]) =>
          warnings.push(arguments_.map((argument) =>
            argument instanceof Error
              ? { message: argument.message, stack: argument.stack, code: (argument as { code?: unknown }).code }
              : argument
          )),
      },
      externalDrivers: { enabled: false },
      workloadExecution: { enabled: false },
      llmProvider: {
        name: 'worker-test-model',
        model: 'worker-test-model',
        chat: async function*() {
          yield { type: 'text-delta', content: 'gateway-model-ok', id: 'delta-1' };
        },
      } as never,
    });
    const server = http.createServer(runtime.workerGateway?.handler);
    try {
      expect(runtime.workerGateway).toBeDefined();
      await expect(runtime.managedIdentityDriver?.getCapabilities()).resolves
        .toMatchObject({
          identityDomains: ['enrollment'],
          attestationFormats: ['worker-ed25519-bootstrap/v1'],
          supportsRotation: false,
          persistence: 'process',
        });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('worker gateway did not bind');
      const gatewayUrl = `http://127.0.0.1:${address.port}`;

      const workloadManifest = createAgentWorkloadManifest('profile-worker', {
        profileId: 'memeloop:general-assistant',
        promptReference: 'answer from the model',
        trust: 'restricted',
        completionPolicy: 'complete',
      });
      const workload = await runtime.controlStore!.create(actor, workloadManifest);
      const runManifest = createAgentRunManifest('profile-worker-run', {
        workloadRef: {
          apiVersion: workload.apiVersion,
          kind: workload.kind,
          name: workload.metadata.name,
          uid: workload.metadata.uid,
        },
        promptReference: 'answer from the model',
      });
      const run = await runtime.controlStore!.create(actor, runManifest);
      const token = randomBytes(32).toString('base64url');
      const policyDigest = `sha256:${'a'.repeat(64)}`;
      await runtime.controlStore!.create(
        actor,
        createWorkerEnrollmentManifest('profile-worker-enrollment', {
          nodeRef: {
            apiVersion: 'nodes.memeloop.io/v1alpha1',
            kind: 'Node',
            name: 'node-gateway',
          },
          trustClass: 'restricted',
          expectedGateway: gatewayUrl,
          gatewayKeyFingerprint: runtime.workerGateway!.publicKeyFingerprint,
          audience: 'worker-gateway://node-gateway',
          allowedProtocol: WORKER_PROTOCOL_VERSION,
          run: { uid: run.metadata.uid, attempt: 1, epoch: 1 },
          policyDigest,
          allowedMethods: ['assignment.pull', 'capability.request'],
          allowedTargets: [run.metadata.uid],
          bootstrapTokenHash: hashWorkerBootstrapToken(token),
          enrolledBy: actor.id,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      );
      const bootstrapPath = path.join(dataDir, 'bootstrap.json');
      fs.writeFileSync(
        bootstrapPath,
        JSON.stringify({
          apiVersion: WORKER_PROTOCOL_VERSION,
          gatewayUrl,
          gatewayPublicKey: runtime.workerGateway!.publicKey,
          gatewayKeyFingerprint: runtime.workerGateway!.publicKeyFingerprint,
          enrollmentName: 'profile-worker-enrollment',
          bootstrapToken: token,
        }),
        { mode: 0o600 },
      );
      let stdout: string;
      try {
        ({ stdout } = await execute(
          process.execPath,
          ['--experimental-vm-modules', workerEntrypoint],
          {
            env: {
              MEMELOOP_WORKLOAD: JSON.stringify({
                name: workload.metadata.name,
                namespace: workload.metadata.namespace ?? 'default',
                uid: workload.metadata.uid,
                generation: workload.metadata.generation,
                spec: workload.spec,
              }),
              MEMELOOP_WORKER_BOOTSTRAP_FILE: bootstrapPath,
            },
            timeout: 15_000,
          },
        ));
      } catch (error) {
        const output = error as { stdout?: string; stderr?: string };
        throw new Error(
          `worker failed: ${output.stdout ?? ''}\n${output.stderr ?? ''}\n${
            warnings
              .map((warning) => JSON.stringify(warning))
              .join('\n')
          }`,
        );
      }
      expect(JSON.parse(stdout.slice('MEMELOOP_RESULT '.length))).toMatchObject({
        phase: 'Completed',
        summary: expect.stringContaining('gateway-model-ok'),
      });
      const sessions = await runtime.controlStore!.list({
        apiVersion: 'security.memeloop.io/v1alpha1',
        kind: 'WorkerSession',
      });
      expect(sessions.items).toHaveLength(1);
      expect(sessions.items[0].status).toMatchObject({
        phase: 'Active',
        lastSequence: 2,
      });
      const grants = await runtime.controlStore!.list({
        apiVersion: 'security.memeloop.io/v1alpha1',
        kind: 'WorkloadCapabilityGrant',
      });
      expect(grants.items).toHaveLength(1);
      expect(grants.items[0]).toMatchObject({
        spec: {
          run: { uid: run.metadata.uid, attempt: 1, epoch: 1 },
          workerKeyFingerprint: sessions.items[0].spec.workerKeyFingerprint,
          channelBinding: `gateway-key:${runtime.workerGateway!.publicKeyFingerprint}`,
          protocol: WORKER_PROTOCOL_VERSION,
          protocolMethod: 'capability.request',
          capability: 'runAgent',
          target: run.metadata.uid,
          policyDigest,
          budget: { maxRequests: 1, maxOutputBytes: 256 * 1024 },
          signature: expect.any(String),
        },
        status: {
          phase: 'Consumed',
          consumedAt: expect.any(String),
        },
      });
      const rejectedResponse = await fetch(`${gatewayUrl}/v1/worker/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiVersion: WORKER_PROTOCOL_VERSION,
          requestId: 'unknown-session-request',
          sessionName: 'unknown-session',
          sequence: 1,
          nonce: randomBytes(16).toString('base64url'),
          audience: 'worker-gateway://node-gateway',
          run: { uid: run.metadata.uid, attempt: 1, epoch: 1 },
          policyDigest,
          method: 'assignment.pull',
          target: run.metadata.uid,
          deadline: new Date(Date.now() + 10_000).toISOString(),
          payload: {},
          signature: 'forged',
        }),
      });
      expect(rejectedResponse.status).toBe(403);
      await expect(rejectedResponse.json()).resolves.toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN' },
      });
      const auditRecords = await runtime.controlStore!.list({
        apiVersion: AUDIT_RECORD_API_VERSION,
        kind: AUDIT_RECORD_KIND,
      });
      const workerAudits = (auditRecords.items as AuditRecordResource[])
        .filter((record) => record.spec.provenance.producer === 'worker-protocol-gateway');
      expect(workerAudits).toHaveLength(3);
      expect(workerAudits.filter((record) =>
        record.spec.data.kind === 'audit' &&
        record.spec.data.action === 'worker.protocol-request' &&
        record.spec.data.outcome === 'success'
      )).toHaveLength(2);
      expect(workerAudits).toEqual(expect.arrayContaining([
        expect.objectContaining({
          spec: expect.objectContaining({
            provenance: expect.objectContaining({
              subject: 'worker-session/rejected',
            }),
            data: {
              kind: 'audit',
              action: 'worker.protocol-request',
              outcome: 'denied',
              reasonCode: 'FORBIDDEN',
            },
          }),
        }),
      ]));
      expect(JSON.stringify(workerAudits)).not.toContain('answer from the model');
    } finally {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        })
      );
      await runtime.stop();
      await runtime.controlStore?.close();
      (runtime.storage as SQLiteAgentStorage).close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
