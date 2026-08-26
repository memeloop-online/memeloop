import {
  BUILTIN_RUNTIME_CLASSES,
  createAgentWorkloadManifest,
  createNetworkClassManifest,
  createScriptDeploymentClient,
  createStorageClassManifest,
  createVolumeClaimManifest,
  type OrchestrationResource,
  POLICY_DECISION_API_VERSION,
  POLICY_DECISION_KIND,
} from 'memeloop';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { prepareLinuxProcessSandbox } from '../../sandbox/linuxProcessSandbox.js';
import { SQLiteAgentStorage } from '../../storage/sqliteStorage.js';
import { createNodeRuntime } from '../nodeRuntime.js';

const OK_SCRIPT = 'export default async function* s(ctx) { yield { type: "message", data: "ok:" + ctx.input.message }; }';
const PID_SCRIPT = 'export default async function* s() { yield { type: "message", data: "pid:" + process.pid }; }';
const processSandboxAvailable = process.platform === 'linux'
  ? prepareLinuxProcessSandbox().then(Boolean)
  : Promise.resolve(false);

async function requireProcessSandbox(skip: () => void): Promise<void> {
  if (!(await processSandboxAvailable)) skip();
}

function mkLLMProvider() {
  return {
    name: 'embed-test',
    modelId: 'embed-model',
    chat: async function*() {
      yield { type: 'text-delta' as const, content: 'ok', id: '1' };
    },
  };
}

describe('createNodeRuntime workload execution end to end (Phase 4.2)', () => {
  it('deploys a script, schedules it onto this node, and executes it to Completed', async ({ skip }) => {
    await requireProcessSandbox(skip);
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
      expect(await runtime.managedLoopRuntimeDriver?.getCapabilities())
        .toMatchObject({
          persistence: 'process',
          supportsAdoption: false,
          isolation: expect.arrayContaining(['none', 'process']),
        });

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
      let finalWorkload: OrchestrationResource | null = null;
      while (Date.now() < deadline) {
        finalWorkload = await runtime.controlStore!.get(workloadRef);
        phase = (finalWorkload?.status as { phase?: string } | undefined)?.phase;
        if (phase === 'Completed' || phase === 'Failed') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(phase).toBe('Completed');
      expect(finalWorkload?.status).toMatchObject({
        placementDecisionRef: expect.stringMatching(/^policy-decision:/),
        placementPolicyDigest: expect.stringMatching(/^sha256:/),
      });
      const placementDecisions = await runtime.controlStore!.list({
        apiVersion: POLICY_DECISION_API_VERSION,
        kind: POLICY_DECISION_KIND,
      });
      expect(placementDecisions.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          spec: expect.objectContaining({
            subjectRef: expect.objectContaining({
              uid: finalWorkload?.metadata.uid,
            }),
            decisionKind: 'placement',
            initialOutcome: 'allow',
          }),
        }),
      ]));

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

  it('honors RuntimeClass process isolation: the script runs in a child process (24.18/Phase 4.2)', async ({ skip }) => {
    await requireProcessSandbox(skip);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-workload-isolation-'));
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: mkLLMProvider() as never,
      includeVscodeCli: false,
      localNodeId: 'node-a',
      config: { providers: [] },
      logger: { warn() {} },
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
    });
    try {
      expect(runtime.modelEndpointBindingControllerRunner).toBeDefined();
      await runtime.controlStore!.create(
        { id: 'test/model-workload', kind: 'controller' },
        createAgentWorkloadManifest('model-workload', {
          profileId: 'memeloop:general-assistant',
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
        if ((run?.status as { phase?: string } | undefined)?.phase === 'Completed') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(run?.status).toMatchObject({
        phase: 'Completed',
        assignedModelEndpoint: {
          kind: 'ModelEndpoint',
          name: 'embed-test-embed-model-node-a',
        },
        modelBinding: {
          leaseEpoch: expect.any(String),
          endpointResourceVersion: expect.any(String),
        },
      });
      const callRecords = await runtime.controlStore!.list({
        apiVersion: 'models.memeloop.io/v1alpha1',
        kind: 'ModelCallRecord',
      });
      expect(callRecords.items).toHaveLength(1);
      expect(callRecords.items[0]).toMatchObject({
        spec: {
          runRef: {
            apiVersion: 'run.memeloop.io/v1alpha1',
            kind: 'AgentRun',
            name: 'model-workload-run',
            uid: run?.metadata.uid,
          },
          policyDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          runAttempt: 1,
        },
        status: { phase: 'Completed' },
      });
    } finally {
      await runtime.stop();
      await runtime.controlStore?.close();
      (runtime.storage as SQLiteAgentStorage).close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('binds and consumes a NetworkAttachment before launching an isolated script', async ({ skip }) => {
    await requireProcessSandbox(skip);
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
      expect(attachment?.spec).toMatchObject({
        runRef: {
          apiVersion: 'run.memeloop.io/v1alpha1',
          kind: 'AgentRun',
          uid: run?.metadata.uid,
          controller: true,
        },
      });
    } finally {
      await runtime.stop();
      await runtime.controlStore?.close();
      (runtime.storage as SQLiteAgentStorage).close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('provisions, publishes, consumes, and unpublishes a local volume claim', async ({ skip }) => {
    await requireProcessSandbox(skip);
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
      await expect(runtime.managedStorageDriver?.getCapabilities()).resolves.toMatchObject({
        name: 'local-directory',
        persistence: 'host',
        supportsSnapshots: false,
      });
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
          stageHandle: expect.any(String),
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

  it('wires the host replication transport and fences the primary before transfer', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-volume-replication-'));
    const contentHash = `sha256:${'a'.repeat(64)}`;
    const replicaHashes = new Map([['node-a', contentHash]]);
    const events: string[] = [];
    let committedEpoch = 0;
    let committedNode: string | undefined;
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: mkLLMProvider() as never,
      includeVscodeCli: false,
      localNodeId: 'node-a',
      config: { providers: [] },
      logger: { warn() {} },
      workloadExecution: {
        storageReplication: {
          async listNodes() {
            return [
              { nodeId: 'node-a', trust: 'trusted', faultDomain: 'rack-a' },
              { nodeId: 'node-b', trust: 'trusted', faultDomain: 'rack-b' },
            ];
          },
          transport: {
            async readReplicaHash(_volume, nodeId) {
              events.push(`read:${nodeId}`);
              return replicaHashes.get(nodeId) ?? null;
            },
            async commitPrimaryFence(_volume, previous, next) {
              if (committedEpoch === next.epoch && committedNode === next.nodeId) return;
              if (previous.epoch !== committedEpoch) throw new Error('stale primary fence');
              committedEpoch = next.epoch;
              committedNode = next.nodeId;
              events.push(`fence:${next.epoch}`);
            },
            async capturePrimarySnapshot(_volume, nodeId, epoch) {
              if (epoch !== committedEpoch || nodeId !== committedNode) {
                throw new Error('uncommitted primary epoch');
              }
              const snapshotHash = replicaHashes.get(nodeId);
              if (!snapshotHash) throw new Error('primary is unreadable');
              events.push(`snapshot:${epoch}`);
              return {
                snapshotHandle: `snapshot:${nodeId}:${epoch}:${snapshotHash}`,
                contentHash: snapshotHash,
              };
            },
            async transferReplica(_volume, snapshot, _fromNodeId, toNodeId, epoch) {
              if (epoch !== committedEpoch) throw new Error('uncommitted primary epoch');
              events.push(`transfer:${epoch}`);
              replicaHashes.set(toNodeId, snapshot.contentHash);
            },
            async releaseSnapshot(_volume, snapshot) {
              events.push(`release:${snapshot.snapshotHandle}`);
            },
          },
        },
      },
    });
    try {
      expect(runtime.volumeControllers?.replication).toBeDefined();
      const actor = { id: 'test/replicated-storage', kind: 'controller' as const };
      await runtime.controlStore!.create(
        actor,
        createStorageClassManifest('replicated-data', {
          driver: 'local-directory',
          allowedAccessModes: ['ReadWriteOnce'],
          replication: { factor: 2, faultDomains: ['node'], autoRebuild: true },
        }),
      );
      await runtime.controlStore!.create(
        actor,
        createVolumeClaimManifest('replicated-claim', {
          storageClassRef: {
            apiVersion: 'storage.memeloop.io/v1alpha1',
            kind: 'StorageClass',
            name: 'replicated-data',
          },
          accessMode: 'ReadWriteOnce',
          sizeBytes: 1024,
        }),
      );

      const deadline = Date.now() + 10_000;
      let volume: OrchestrationResource | null = null;
      while (Date.now() < deadline) {
        volume = await runtime.controlStore!.get({
          apiVersion: 'storage.memeloop.io/v1alpha1',
          kind: 'AgentVolume',
          name: 'replicated-claim-volume',
        });
        const status = volume?.status as {
          health?: string;
          replicas?: unknown[];
        } | undefined;
        if (status?.health === 'healthy' && status.replicas?.length === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(events).not.toHaveLength(0);
      expect(volume?.status).toMatchObject({
        health: 'healthy',
        contentHash,
        primaryNodeId: 'node-a',
        primaryEpoch: 1,
        replicas: [
          { nodeId: 'node-a', state: 'healthy', contentHash },
          { nodeId: 'node-b', state: 'healthy', contentHash },
        ],
      });
      expect(events).toContain('fence:1');
      expect(events).toContain('snapshot:1');
      expect(events).toContain('transfer:1');
      expect(events.indexOf('fence:1')).toBeLessThan(events.indexOf('transfer:1'));
      expect(events.indexOf('snapshot:1')).toBeLessThan(events.indexOf('transfer:1'));
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
          driverConformancePassed: true,
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
