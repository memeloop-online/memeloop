import {
  BUILTIN_RUNTIME_CLASSES,
  createAgentWorkloadManifest,
  createNetworkClassManifest,
  createScriptDeploymentClient,
  createStorageClassManifest,
  createVolumeClaimManifest,
  type OrchestrationResource,
} from 'memeloop';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { SQLiteAgentStorage } from '../../storage/sqliteStorage.js';
import { createNodeRuntime } from '../nodeRuntime.js';

const OK_SCRIPT = 'export default async function* s(ctx) { yield { type: "message", data: "ok:" + ctx.input.message }; }';
const PID_SCRIPT = 'export default async function* s() { yield { type: "message", data: "pid:" + process.pid }; }';

function mkLLMProvider() {
  return {
    name: 'embed-test',
    model: 'embed-model',
    chat: async function*() {
      yield { type: 'text-delta' as const, content: 'ok', id: '1' };
    },
  };
}

describe('createNodeRuntime workload execution end to end (Phase 4.2)', () => {
  it('deploys a script, schedules it onto this node, and executes it to Completed', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-workload-exec-'));
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: mkLLMProvider() as never,
      includeVscodeCli: false,
      localNodeId: 'node-a',
      config: { providers: [] },
    });
    try {
      expect(runtime.bindingControllerRunner).toBeDefined();
      expect(runtime.workloadExecutionController).toBeDefined();

      const client = createScriptDeploymentClient(runtime.context.scriptDeployment!);
      const result = await client.deploy({ source: OK_SCRIPT, lifecycle: 'run-once' });
      expect(result.deployed).toBe(true);

      const workloadRef = {
        apiVersion: 'workload.memeloop.io/v1alpha1',
        kind: 'AgentWorkload',
        name: result.workload!.metadata.name,
      };
      const deadline = Date.now() + 15_000;
      let phase: string | undefined;
      while (Date.now() < deadline) {
        const workload = await runtime.controlStore!.get(workloadRef);
        phase = (workload?.status as { phase?: string } | undefined)?.phase;
        if (phase === 'Completed' || phase === 'Failed') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(phase).toBe('Completed');

      const run = await runtime.controlStore!.get({
        apiVersion: 'run.memeloop.io/v1alpha1',
        kind: 'AgentRun',
        name: `${result.workload!.metadata.name}-run`,
      });
      expect(run?.status).toMatchObject({ phase: 'Completed', exitCode: 0 });
      expect((run?.status as { summary?: string }).summary).toContain('ok:');
    } finally {
      await runtime.stop();
      await runtime.controlStore?.close();
      (runtime.storage as SQLiteAgentStorage).close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('honors RuntimeClass process isolation: the script runs in a child process (24.18/Phase 4.2)', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-workload-isolation-'));
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: mkLLMProvider() as never,
      includeVscodeCli: false,
      localNodeId: 'node-a',
      config: { providers: [] },
    });
    try {
      const client = createScriptDeploymentClient(runtime.context.scriptDeployment!);
      const result = await client.deploy({ source: PID_SCRIPT, lifecycle: 'run-once' });
      expect(result.deployed).toBe(true);

      const workloadRef = {
        apiVersion: 'workload.memeloop.io/v1alpha1',
        kind: 'AgentWorkload',
        name: result.workload!.metadata.name,
      };
      const deadline = Date.now() + 15_000;
      let phase: string | undefined;
      while (Date.now() < deadline) {
        const workload = await runtime.controlStore!.get(workloadRef);
        phase = (workload?.status as { phase?: string } | undefined)?.phase;
        if (phase === 'Completed' || phase === 'Failed') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(phase).toBe('Completed');

      const run = await runtime.controlStore!.get({
        apiVersion: 'run.memeloop.io/v1alpha1',
        kind: 'AgentRun',
        name: `${result.workload!.metadata.name}-run`,
      });
      const summary = (run?.status as { summary?: string }).summary ?? '';
      // A pid different from this (the daemon's) process proves the script
      // executed behind a real OS process boundary, not in-process.
      expect(summary).toMatch(/^pid:\d+$/);
      expect(summary).not.toBe(`pid:${process.pid}`);
    } finally {
      await runtime.stop();
      await runtime.controlStore?.close();
      (runtime.storage as SQLiteAgentStorage).close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('independently binds a live ModelEndpoint before starting an AgentRun', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-model-binding-'));
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: mkLLMProvider() as never,
      includeVscodeCli: false,
      localNodeId: 'node-a',
      config: { providers: [] },
      logger: { warn() {} },
    });
    try {
      expect(runtime.modelEndpointBindingControllerRunner).toBeDefined();
      await runtime.controlStore!.create(
        { id: 'test/model-workload', kind: 'controller' },
        createAgentWorkloadManifest('model-workload', {
          profileId: 'general-assistant',
          modelPolicy: { modelClass: 'embed-test-embed-model' },
        }),
      );

      const deadline = Date.now() + 10_000;
      let run: OrchestrationResource | null = null;
      while (Date.now() < deadline) {
        run = await runtime.controlStore!.get({
          apiVersion: 'run.memeloop.io/v1alpha1',
          kind: 'AgentRun',
          name: 'model-workload-run',
        });
        if ((run?.status as { assignedModelEndpoint?: unknown } | undefined)?.assignedModelEndpoint) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(run?.status).toMatchObject({
        assignedModelEndpoint: {
          kind: 'ModelEndpoint',
          name: 'embed-test-embed-model-node-a',
        },
        modelBinding: {
          leaseEpoch: expect.any(String),
          endpointResourceVersion: expect.any(String),
        },
      });
    } finally {
      await runtime.stop();
      await runtime.controlStore?.close();
      (runtime.storage as SQLiteAgentStorage).close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('binds and consumes a NetworkAttachment before launching an isolated script', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-network-attachment-'));
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: mkLLMProvider() as never,
      includeVscodeCli: false,
      localNodeId: 'node-a',
      config: { providers: [] },
      logger: { warn() {} },
    });
    try {
      await runtime.controlStore!.create(
        { id: 'test/network-class', kind: 'controller' },
        createNetworkClassManifest('process-net', {
          driver: 'process-env',
          proxy: { httpsProxy: 'http://proxy.test:8080', noProxy: ['localhost'] },
          enforcement: 'best-effort',
        }),
      );
      const source = 'export default async function* s() { yield String(process.env.HTTPS_PROXY) + "/" + String(process.env.NO_PROXY); }';
      const result = await createScriptDeploymentClient(runtime.context.scriptDeployment!).deploy({
        source,
        lifecycle: 'run-once',
        networkPolicy: {
          networkClass: 'process-net',
          minimumEnforcement: 'process',
        },
      });
      expect(result.deployed).toBe(true);

      const deadline = Date.now() + 10_000;
      let run: OrchestrationResource | null = null;
      while (Date.now() < deadline) {
        run = await runtime.controlStore!.get({
          apiVersion: 'run.memeloop.io/v1alpha1',
          kind: 'AgentRun',
          name: `${result.workload!.metadata.name}-run`,
        });
        if ((run?.status as { phase?: string } | undefined)?.phase === 'Completed') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(run?.status).toMatchObject({
        phase: 'Completed',
        summary: 'http://proxy.test:8080/localhost',
        networkAttachmentRef: {
          kind: 'NetworkAttachment',
          name: `${result.workload!.metadata.name}-run-network`,
        },
      });
      const attachmentReference = {
        apiVersion: 'network.memeloop.io/v1alpha1',
        kind: 'NetworkAttachment',
        name: `${result.workload!.metadata.name}-run-network`,
      };
      let attachment: OrchestrationResource | null = null;
      while (Date.now() < deadline) {
        attachment = await runtime.controlStore!.get(attachmentReference);
        if ((attachment?.status as { phase?: string } | undefined)?.phase === 'Detached') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(attachment?.status).toMatchObject({
        phase: 'Detached',
        assignedNode: 'node-a',
        assignedDriver: 'process-env',
        handle: expect.any(String),
        releaseRequestedAt: expect.any(String),
        detachedAt: expect.any(String),
        binding: {
          leaseEpoch: expect.any(String),
          networkClassResourceVersion: expect.any(String),
        },
        executionClaim: { leaseEpoch: expect.any(String) },
      });
    } finally {
      await runtime.stop();
      await runtime.controlStore?.close();
      (runtime.storage as SQLiteAgentStorage).close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('provisions, publishes, consumes, and unpublishes a local volume claim', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-volume-'));
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: mkLLMProvider() as never,
      includeVscodeCli: false,
      localNodeId: 'node-a',
      config: { providers: [] },
      logger: { warn() {} },
    });
    try {
      const actor = { id: 'test/storage', kind: 'controller' as const };
      await runtime.controlStore!.create(
        actor,
        createStorageClassManifest('local-data', {
          driver: 'local-directory',
          allowedAccessModes: ['ReadWriteOnce'],
        }),
      );
      await runtime.controlStore!.create(
        actor,
        createVolumeClaimManifest('data-claim', {
          storageClassRef: {
            apiVersion: 'storage.memeloop.io/v1alpha1',
            kind: 'StorageClass',
            name: 'local-data',
          },
          accessMode: 'ReadWriteOnce',
          sizeBytes: 1024,
        }),
      );
      const claimReference = {
        apiVersion: 'storage.memeloop.io/v1alpha1',
        kind: 'AgentVolumeClaim',
        name: 'data-claim',
      };
      const claimDeadline = Date.now() + 10_000;
      let claim: OrchestrationResource | null = null;
      while (Date.now() < claimDeadline) {
        claim = await runtime.controlStore!.get(claimReference);
        if ((claim?.status as { phase?: string } | undefined)?.phase === 'Bound') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(claim?.status).toMatchObject({
        phase: 'Bound',
        assignedNode: 'node-a',
        assignedDriver: 'local-directory',
        volumeRef: { uid: expect.any(String) },
      });

      const source = 'export default async function* s() { yield String(process.env.MEMELOOP_VOLUME_DATA) + "/" + process.env.MEMELOOP_VOLUME_DATA_READ_ONLY; }';
      const result = await createScriptDeploymentClient(runtime.context.scriptDeployment!).deploy({
        source,
        lifecycle: 'run-once',
        storagePolicy: {
          storageClass: 'local-data',
          volumes: [{ name: 'data', claimRef: 'data-claim' }],
        },
      });
      const runReference = {
        apiVersion: 'run.memeloop.io/v1alpha1',
        kind: 'AgentRun',
        name: `${result.workload!.metadata.name}-run`,
      };
      const runDeadline = Date.now() + 10_000;
      let run: OrchestrationResource | null = null;
      while (Date.now() < runDeadline) {
        run = await runtime.controlStore!.get(runReference);
        const status = run?.status as { phase?: string; volumePhase?: string } | undefined;
        if (status?.phase === 'Completed' && status.volumePhase === 'Released') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(run?.status).toMatchObject({
        phase: 'Completed',
        volumePhase: 'Released',
        summary: expect.stringMatching(/^\/.*\/false$/),
        volumeBindings: [{
          name: 'data',
          assignedNode: 'node-a',
          assignedDriver: 'local-directory',
          publishHandle: expect.any(String),
        }],
      });
      expect(JSON.stringify(
        (run?.status as { volumeBindings?: unknown } | undefined)?.volumeBindings,
      )).not.toContain(path.join(dataDir, 'volumes'));
      const volume = await runtime.controlStore!.get({
        apiVersion: 'storage.memeloop.io/v1alpha1',
        kind: 'AgentVolume',
        name: 'data-claim-volume',
      });
      expect(volume?.status).toMatchObject({ phase: 'Bound', publishedTo: [] });
    } finally {
      await runtime.stop();
      await runtime.controlStore?.close();
      (runtime.storage as SQLiteAgentStorage).close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('uses the host-provided multi-node inventory instead of silently forcing local placement', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-remote-schedule-'));
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: mkLLMProvider() as never,
      includeVscodeCli: false,
      localNodeId: 'node-a',
      config: { providers: [] },
      workloadExecution: {
        listSchedulerNodes: async () => [{
          name: 'node-b',
          trustClass: 'trusted',
          faultDomain: 'remote-lab',
          labels: { site: 'remote' },
          availableRuntimeClasses: Object.keys(BUILTIN_RUNTIME_CLASSES),
        }],
      },
    });
    try {
      const result = await createScriptDeploymentClient(runtime.context.scriptDeployment!).deploy({
        source: OK_SCRIPT,
        lifecycle: 'run-once',
        nodeSelector: { site: 'remote' },
      });
      const workloadRef = {
        apiVersion: 'workload.memeloop.io/v1alpha1',
        kind: 'AgentWorkload',
        name: result.workload!.metadata.name,
      };
      const deadline = Date.now() + 5000;
      let status: { phase?: string; assignedNode?: string } | undefined;
      while (Date.now() < deadline) {
        const workload = await runtime.controlStore!.get(workloadRef);
        status = workload?.status as typeof status;
        if (status?.phase === 'Scheduling' || status?.phase === 'Failed') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(status?.phase, JSON.stringify(status)).toBe('Scheduling');
      expect(status?.assignedNode).toBe('node-b');
    } finally {
      await runtime.stop();
      await runtime.controlStore?.close();
      (runtime.storage as SQLiteAgentStorage).close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('fails process-isolated scripts closed when the host disables its process driver', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-no-process-driver-'));
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: mkLLMProvider() as never,
      includeVscodeCli: false,
      localNodeId: 'node-a',
      config: { providers: [] },
      workloadExecution: { processIsolation: false },
    });
    try {
      const result = await createScriptDeploymentClient(runtime.context.scriptDeployment!).deploy({
        source: OK_SCRIPT,
        lifecycle: 'run-once',
      });
      const workloadRef = {
        apiVersion: 'workload.memeloop.io/v1alpha1',
        kind: 'AgentWorkload',
        name: result.workload!.metadata.name,
      };
      const deadline = Date.now() + 5000;
      let status: { phase?: string; lastRunResult?: string } | undefined;
      while (Date.now() < deadline) {
        const workload = await runtime.controlStore!.get(workloadRef);
        status = workload?.status as typeof status;
        if (status?.phase === 'Failed') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(status).toMatchObject({
        phase: 'Failed',
        lastRunResult: 'no suitable node found',
      });
      expect(
        await runtime.controlStore!.get({
          apiVersion: 'run.memeloop.io/v1alpha1',
          kind: 'AgentRun',
          name: `${result.workload!.metadata.name}-run`,
        }),
      ).toBeNull();
    } finally {
      await runtime.stop();
      await runtime.controlStore?.close();
      (runtime.storage as SQLiteAgentStorage).close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
