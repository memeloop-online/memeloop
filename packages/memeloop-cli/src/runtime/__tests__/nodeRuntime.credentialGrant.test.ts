import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAgentRunManifest, createAgentWorkloadManifest, createCredentialGrantManifest, type CredentialGrantHandle, type CredentialHandleVault } from 'memeloop';
import { describe, expect, it, vi } from 'vitest';

import { SQLiteAgentStorage } from '../../storage/sqliteStorage.js';
import { createNodeRuntime } from '../nodeRuntime.js';

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('waitFor timed out');
}

describe('createNodeRuntime credential grant controllers', () => {
  it('issues into an external vault and revokes when the Run completes', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-credential-grant-'));
    const values = new Map<string, CredentialGrantHandle>();
    const vault: CredentialHandleVault = {
      async put(reference, handle) {
        values.set(reference, handle);
      },
      async get(reference) {
        return values.get(reference);
      },
      async delete(reference) {
        values.delete(reference);
      },
    };
    const revoke = vi.fn();
    const driver = {
      async issue(request: { grantId?: string }) {
        const issuedAt = new Date();
        return {
          token: 'must-never-enter-control-store',
          claims: {
            runRef: {
              apiVersion: 'run.memeloop.io/v1alpha1',
              kind: 'AgentRun',
              name: 'run-1',
              uid: 'placeholder',
            },
            attempt: 1,
            workerKey: 'sha256:worker',
            target: 'https://api.example.test',
            method: 'POST',
            audience: 'example-api',
            policyDigest: 'sha256:policy',
            grantId: request.grantId ?? 'missing',
            issuedAt: issuedAt.toISOString(),
            expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString(),
          },
        };
      },
      revoke,
    };
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: {
        name: 'test',
        model: 'test',
        chat: async function*() {},
      } as never,
      includeVscodeCli: false,
      localNodeId: 'node-a',
      config: { providers: [] },
      workloadExecution: { enabled: false },
      toolExecution: { enabled: false },
      modelEndpointRegistration: { enabled: false },
      modelGateway: { enabled: false },
      externalDrivers: { enabled: false },
      credentialBroker: {
        driver: driver as never,
        vault,
        brokerClass: 'vault-jit',
        audiences: ['example-api'],
        methods: ['POST'],
        targets: ['https://api.example.test'],
        authorizeGrant: async () => true,
      },
    });
    try {
      const actor = { id: 'test/credential', kind: 'controller' as const };
      const workload = await runtime.controlStore!.create(
        actor,
        createAgentWorkloadManifest('work-1', {
          profileId: 'general-assistant',
          credentialPolicy: {
            brokerClass: 'vault-jit',
            audiences: ['example-api'],
            targets: ['https://api.example.test'],
          },
        }),
      );
      await runtime.controlStore!.updateStatus(actor, {
        apiVersion: workload.apiVersion,
        kind: workload.kind,
        name: workload.metadata.name,
      }, {
        phase: 'Scheduling',
        assignedNode: 'node-a',
      }, { resourceVersion: workload.metadata.resourceVersion });
      const runManifest = createAgentRunManifest('run-1', {
        workloadRef: {
          apiVersion: workload.apiVersion,
          kind: workload.kind,
          name: workload.metadata.name,
          uid: workload.metadata.uid,
        },
      });
      const run = await runtime.controlStore!.create(actor, runManifest);
      const grantManifest = createCredentialGrantManifest('grant-1', {
        runRef: {
          apiVersion: run.apiVersion,
          kind: run.kind,
          name: run.metadata.name,
          uid: run.metadata.uid,
        },
        attempt: 1,
        workerKey: 'sha256:worker',
        target: 'https://api.example.test',
        method: 'POST',
        audience: 'example-api',
        policyDigest: 'sha256:policy',
      });
      const createdGrant = await runtime.controlStore!.create(actor, grantManifest);
      const reference = {
        apiVersion: createdGrant.apiVersion,
        kind: createdGrant.kind,
        name: createdGrant.metadata.name,
      };
      await waitFor(async () => {
        const current = await runtime.controlStore!.get(reference);
        return (current?.status as { phase?: string } | undefined)?.phase === 'Issued';
      });
      const issued = await runtime.controlStore!.get(reference);
      expect(issued?.status).toMatchObject({
        phase: 'Issued',
        assignedNode: 'node-a',
        assignedBroker: 'vault-jit',
        handleRef: expect.any(String),
      });
      expect(JSON.stringify(issued)).not.toContain('must-never-enter-control-store');
      expect([...values.values()][0]?.token).toBe('must-never-enter-control-store');

      const currentRun = await runtime.controlStore!.get({
        apiVersion: run.apiVersion,
        kind: run.kind,
        name: run.metadata.name,
      });
      await runtime.controlStore!.updateStatus(actor, {
        apiVersion: run.apiVersion,
        kind: run.kind,
        name: run.metadata.name,
      }, {
        phase: 'Completed',
      }, { resourceVersion: currentRun!.metadata.resourceVersion });
      await waitFor(async () => values.size === 0);
      const revokedGrant = await runtime.controlStore!.get(reference);
      expect(revokedGrant?.status).toMatchObject({ phase: 'Revoked' });
      expect(revoke).toHaveBeenCalledWith(createdGrant.metadata.uid);
    } finally {
      await runtime.stop();
      await runtime.controlStore?.close();
      (runtime.storage as SQLiteAgentStorage).close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 10_000);
});
