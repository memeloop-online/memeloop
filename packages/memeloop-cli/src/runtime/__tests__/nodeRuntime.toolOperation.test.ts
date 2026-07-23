import { createToolOperationManifest, type ToolOperationStatus } from 'memeloop';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { SQLiteAgentStorage } from '../../storage/sqliteStorage.js';
import { createNodeRuntime, type NodeRuntimeResult } from '../nodeRuntime.js';

function llmProvider() {
  return {
    name: 'tool-controller-test',
    model: 'test-model',
    chat: async function*() {
      yield { type: 'text-delta' as const, content: 'unused', id: '1' };
    },
  };
}

async function waitForTerminal(
  runtime: NodeRuntimeResult,
  name: string,
): Promise<ToolOperationStatus> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const resource = await runtime.controlStore!.get({
      apiVersion: 'execution.memeloop.io/v1alpha1',
      kind: 'ToolOperation',
      name,
    });
    const status = resource?.status as ToolOperationStatus | undefined;
    if (status?.phase === 'Completed' || status?.phase === 'Failed') return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`ToolOperation ${name} did not reach a terminal phase`);
}

async function closeRuntime(runtime: NodeRuntimeResult, dataDir: string): Promise<void> {
  await runtime.stop();
  await runtime.controlStore?.close();
  (runtime.storage as SQLiteAgentStorage).close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

describe('createNodeRuntime ToolOperation control path', () => {
  it('registers a ToolExecutor, binds independently, and executes through durable status', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-tool-controller-'));
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: llmProvider() as never,
      includeVscodeCli: false,
      localNodeId: 'node-a',
      config: { providers: [] },
      configureTools(registry) {
        registry.registerTool('test.echo', async (arguments_: Record<string, unknown>) => ({
          echoed: arguments_.value,
        }));
      },
    });
    try {
      const executorList = await runtime.controlStore!.list({
        apiVersion: 'tool.memeloop.io/v1alpha1',
        kind: 'ToolExecutor',
      });
      expect(executorList.items).toHaveLength(1);
      expect(executorList.items[0]?.status).toMatchObject({ healthy: true });

      await runtime.context.orchestration!.apply(
        createToolOperationManifest('echo-1', {
          toolRef: { kind: 'BuiltinTool', name: 'test.echo' },
          arguments: { value: 'hello' },
          effect: 'read',
        }),
        { idempotencyKey: 'echo-1' },
      );
      const status = await waitForTerminal(runtime, 'echo-1');

      expect(status).toMatchObject({
        phase: 'Completed',
        assignedNode: 'node-a',
        assignedDriver: 'node-a-builtin-tools',
        assignedExecutor: {
          kind: 'ToolExecutor',
          name: 'node-a-builtin-tools',
        },
        executionClaim: { leaseEpoch: expect.any(String) },
        result: { value: { echoed: 'hello' } },
        attempts: 1,
      });
    } finally {
      await closeRuntime(runtime, dataDir);
    }
  });

  it('uses restricted-node deny-by-default trusted admission', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-tool-admission-'));
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: llmProvider() as never,
      includeVscodeCli: false,
      localNodeId: 'restricted-a',
      trustClass: 'restricted',
      config: { providers: [] },
      configureTools(registry) {
        registry.registerTool('dangerous.write', async () => 'should not execute');
      },
    });
    try {
      await runtime.context.orchestration!.apply(
        createToolOperationManifest('denied-1', {
          toolRef: { kind: 'BuiltinTool', name: 'dangerous.write' },
          effect: 'update',
        }),
        { idempotencyKey: 'denied-1' },
      );
      const status = await waitForTerminal(runtime, 'denied-1');

      expect(status).toMatchObject({
        phase: 'Failed',
        result: {
          error: {
            code: 'FORBIDDEN',
            retryable: false,
          },
        },
      });
    } finally {
      await closeRuntime(runtime, dataDir);
    }
  });
});
