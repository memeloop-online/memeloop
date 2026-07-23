import { BUILTIN_RUNTIME_CLASSES, createScriptDeploymentClient } from 'memeloop';
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
      await runtime.workloadExecutionController?.stop();
      await runtime.bindingControllerRunner?.stop();
      await runtime.modelEndpointRegistrar?.stop();
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
      await runtime.workloadExecutionController?.stop();
      await runtime.bindingControllerRunner?.stop();
      await runtime.modelEndpointRegistrar?.stop();
      await runtime.controlStore?.close();
      (runtime.storage as SQLiteAgentStorage).close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

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
      await runtime.workloadExecutionController?.stop();
      await runtime.bindingControllerRunner?.stop();
      await runtime.modelEndpointRegistrar?.stop();
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
      await runtime.workloadExecutionController?.stop();
      await runtime.bindingControllerRunner?.stop();
      await runtime.modelEndpointRegistrar?.stop();
      await runtime.controlStore?.close();
      (runtime.storage as SQLiteAgentStorage).close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
