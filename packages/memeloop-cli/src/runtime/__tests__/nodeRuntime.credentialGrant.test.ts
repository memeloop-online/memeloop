import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createAgentRunManifest,
  createAgentWorkloadManifest,
  createCredentialGrantManifest,
  createInMemoryCredentialBroker,
  type CredentialGrantHandle,
  type CredentialHandleVault,
} from 'memeloop';
import { describe, expect, it, vi } from 'vitest';

import { createHmacModelHandleSigner } from '../../orchestration/nodeModelGateway.js';
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
    const driver = createInMemoryCredentialBroker({
      signer: createHmacModelHandleSigner(new Uint8Array(32).fill(7)),
      proofVerifier: { verifyAndConsume: async () => true },
    });
    const revoke = vi.spyOn(driver, 'revoke');
    const warnings: Array<[unknown, unknown]> = [];
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: {
        name: 'test',
        model: 'test',
        chat: async function*() {},
      } as never,
      includeVscodeCli: false,
      localNodeId: 'node-a',
      logger: { warn: (message, error) => warnings.push([message, error]) },
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
      await expect(runtime.managedCredentialDriver?.getCapabilities()).resolves.toMatchObject({
        name: 'vault-jit',
        persistence: 'host',
      });
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
        policyDigest: `sha256:${'a'.repeat(64)}`,
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
      const persistedToken = [...values.values()][0]?.token;
      expect(persistedToken).toMatch(/^mlcg1\./);
      expect(JSON.stringify(issued)).not.toContain(persistedToken);

      // Force the terminal-Run cleanup down its CAS retry path: once that
      // watcher has listed the stale Issued grant, advance its resourceVersion
      // immediately before its first Revoked status write.
      const store = runtime.controlStore!;
      const list = store.list.bind(store);
      const get = store.get.bind(store);
      const updateStatus = store.updateStatus.bind(store);
      let terminalGrantListObserved = false;
      let conflictInjected = false;
      vi.spyOn(store, 'list').mockImplementation(async (query) => {
        const result = await list(query);
        if (query.kind === 'CredentialGrant') {
          terminalGrantListObserved = true;
        }
        return result;
      });
      vi.spyOn(store, 'updateStatus').mockImplementation(async (updateActor, updateReference, status, options) => {
        if (
          terminalGrantListObserved &&
          !conflictInjected &&
          (status as { phase?: string }).phase === 'Revoked' &&
          updateReference.kind === 'CredentialGrant'
        ) {
          conflictInjected = true;
          const latest = await get(updateReference);
          await updateStatus(
            actor,
            updateReference,
            { ...latest?.status, renewedAt: '2026-08-28T00:00:00.000Z' },
            { resourceVersion: latest!.metadata.resourceVersion },
          );
        }
        return updateStatus(updateActor, updateReference, status, options);
      });

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
      await waitFor(async () => {
        const current = await runtime.controlStore!.get(reference);
        return values.size === 0 &&
          (current?.status as { phase?: string } | undefined)?.phase === 'Revoked';
      });
      const revokedGrant = await runtime.controlStore!.get(reference);
      expect(revokedGrant?.status).toMatchObject({ phase: 'Revoked' });
      expect(revoke).toHaveBeenCalledWith(createdGrant.metadata.uid);
      expect(conflictInjected).toBe(true);
      expect(warnings).toEqual([]);
    } finally {
      await runtime.stop();
      expect(warnings).toEqual([]);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 10_000);
});
