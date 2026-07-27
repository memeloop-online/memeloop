import {
  AUDIT_RECORD_API_VERSION,
  AUDIT_RECORD_KIND,
  type AuditRecordResource,
  type BuiltinToolContext,
  createToolOperationManifest,
  POLICY_DECISION_API_VERSION,
  POLICY_DECISION_KIND,
  type PolicyDecisionResource,
  type ToolOperationStatus,
} from 'memeloop';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

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
  it('publishes and executes a default host tool through the managed route', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-default-tool-'));
    const fileBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-default-files-'));
    fs.writeFileSync(path.join(fileBaseDir, 'visible.txt'), 'managed default tool');
    const runtime = await createNodeRuntime({
      dataDir,
      fileBaseDir,
      llmProvider: llmProvider() as never,
      includeVscodeCli: false,
      localNodeId: 'node-default',
      config: { providers: [] },
    });
    try {
      const executors = await runtime.controlStore!.list({
        apiVersion: 'tool.memeloop.io/v1alpha1',
        kind: 'ToolExecutor',
      });
      const capabilities = (
        executors.items[0]?.spec as {
          capabilities?: Array<{
            toolClassRef?: { name?: string };
            schemaDigest?: string;
          }>;
        }
      ).capabilities;
      expect(capabilities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            toolClassRef: expect.objectContaining({ name: 'file.list' }),
            schemaDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          }),
        ]),
      );

      await runtime.context.orchestration!.apply(
        createToolOperationManifest('default-file-list', {
          toolRef: { kind: 'BuiltinTool', name: 'file.list' },
          arguments: { path: '.' },
          effect: 'read',
        }),
        { idempotencyKey: 'default-file-list' },
      );
      const status = await waitForTerminal(runtime, 'default-file-list');

      expect(status).toMatchObject({
        phase: 'Completed',
        assignedNode: 'node-default',
        result: { value: expect.anything() },
      });
      expect(JSON.stringify(status.result?.value)).toContain('visible.txt');
    } finally {
      await closeRuntime(runtime, dataDir);
      fs.rmSync(fileBaseDir, { recursive: true, force: true });
    }
  });

  it('registers a ToolExecutor, binds independently, and executes through durable status', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-tool-controller-'));
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: llmProvider() as never,
      includeVscodeCli: false,
      localNodeId: 'node-a',
      config: { providers: [] },
      configureTools(registry) {
        registry.registerTool(
          'test.echo',
          async (arguments_: Record<string, unknown>) => ({
            echoed: arguments_.value,
          }),
          z.object({ value: z.string() }).strict(),
        );
      },
    });
    try {
      const executorList = await runtime.controlStore!.list({
        apiVersion: 'tool.memeloop.io/v1alpha1',
        kind: 'ToolExecutor',
      });
      expect(executorList.items).toHaveLength(1);
      expect(executorList.items[0]?.status).toMatchObject({ healthy: true });
      expect(
        (executorList.items[0]?.spec as {
          capabilities?: Array<{ schemaDigest?: string }>;
        }).capabilities?.every((capability) => /^sha256:[a-f0-9]{64}$/.test(capability.schemaDigest ?? '')),
      ).toBe(true);
      expect(JSON.stringify(executorList.items[0]?.spec)).not.toContain('builtin:');
      await expect(runtime.managedToolDriver?.getCapabilities()).resolves.toMatchObject({
        persistence: 'process',
        supportsStreaming: true,
        supportsCancellation: true,
      });
      await expect(runtime.managedPolicyDriver?.getCapabilities()).resolves
        .toMatchObject({
          decisions: expect.arrayContaining(['placement', 'tool-operation', 'approval']),
          defaultOutcome: 'deny',
          supportsDurableApproval: true,
          persistence: 'host',
        });

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
      expect(status.result?.evidenceRef).toMatch(/^sha256:[a-f0-9]{64}$/);
      const auditRecords = await runtime.controlStore!.list({
        apiVersion: AUDIT_RECORD_API_VERSION,
        kind: AUDIT_RECORD_KIND,
      });
      expect(auditRecords.items as AuditRecordResource[]).toHaveLength(1);
      expect(auditRecords.items[0]?.spec).toMatchObject({
        recordKind: 'audit',
        effect: 'read',
        data: {
          kind: 'audit',
          action: 'tool.execute',
          outcome: 'success',
        },
        attributes: {
          toolName: 'test.echo',
          operationEffect: 'read',
          resultDigest: expect.stringMatching(/^sha256:/),
        },
      });
      expect(JSON.stringify(auditRecords.items)).not.toContain('hello');
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
        registry.registerTool(
          'dangerous.write',
          async () => 'should not execute',
          z.object({}).strict(),
        );
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

  it('injects a trusted approval broker and stores approval evidence', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-tool-approval-'));
    const execute = vi.fn().mockResolvedValue('approved execution');
    const requestApproval = vi.fn().mockResolvedValue({
      approvalId: 'runtime-approval-1',
      decision: 'allow' as const,
      actor: 'desktop:user-1',
      decidedAt: '2026-07-26T08:02:00.000Z',
    });
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: llmProvider() as never,
      includeVscodeCli: false,
      localNodeId: 'node-a',
      config: { providers: [] },
      toolExecution: {
        approvalBroker: { requestApproval },
      },
      configureTools(registry) {
        registry.registerTool('dangerous.write', execute, z.object({}).strict());
      },
    });
    try {
      await runtime.context.orchestration!.apply(
        createToolOperationManifest('approved-write', {
          toolRef: { kind: 'BuiltinTool', name: 'dangerous.write' },
          effect: 'update',
          policy: { requireApproval: true },
        }),
        { idempotencyKey: 'approved-write' },
      );
      const status = await waitForTerminal(runtime, 'approved-write');

      expect(requestApproval).toHaveBeenCalledWith({
        operation: expect.objectContaining({
          metadata: expect.objectContaining({ name: 'approved-write' }),
          status: expect.objectContaining({ phase: 'Running' }),
        }),
        reason: 'ToolOperation policy requires approval',
        signal: expect.any(AbortSignal),
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(status).toMatchObject({
        phase: 'Completed',
        approval: {
          approvalId: expect.stringMatching(/^policy-decision:/),
          decision: 'allow',
          actor: 'desktop:user-1',
        },
      });
      const decisions = await runtime.controlStore!.list({
        apiVersion: POLICY_DECISION_API_VERSION,
        kind: POLICY_DECISION_KIND,
      });
      expect(decisions.items as PolicyDecisionResource[]).toHaveLength(2);
      expect(decisions.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          spec: expect.objectContaining({
            decisionKind: 'approval',
            initialOutcome: 'pending',
            inputDigest: expect.stringMatching(/^sha256:/),
          }),
          status: expect.objectContaining({
            outcome: 'allow',
            decidedBy: 'desktop:user-1',
          }),
        }),
        expect.objectContaining({
          spec: expect.objectContaining({
            decisionKind: 'tool-operation',
            initialOutcome: 'allow',
            inputDigest: expect.stringMatching(/^sha256:/),
          }),
        }),
      ]));
    } finally {
      await closeRuntime(runtime, dataDir);
    }
  });

  it('enforces timeout and aborts an active operation when its resource is deleted', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-tool-cancel-'));
    let calls = 0;
    let aborts = 0;
    let observedSignal: AbortSignal | undefined;
    const runtime = await createNodeRuntime({
      dataDir,
      llmProvider: llmProvider() as never,
      includeVscodeCli: false,
      localNodeId: 'node-a',
      config: { providers: [] },
      configureTools(registry) {
        registry.registerTool(
          'slow.read',
          async (_arguments, context: BuiltinToolContext) => {
            calls += 1;
            observedSignal = context.operationSignal;
            return await new Promise((_resolve, reject) => {
              context.operationSignal?.addEventListener('abort', () => {
                aborts += 1;
                reject(new DOMException('cancelled', 'AbortError'));
              }, { once: true });
            });
          },
          z.object({}).strict(),
        );
      },
    });
    try {
      await runtime.context.orchestration!.apply(
        createToolOperationManifest('timeout-read', {
          toolRef: { kind: 'BuiltinTool', name: 'slow.read' },
          effect: 'read',
          timeoutMs: 250,
        }),
        { idempotencyKey: 'timeout-read' },
      );
      expect(await waitForTerminal(runtime, 'timeout-read')).toMatchObject({
        phase: 'Failed',
        result: { error: { code: 'TIMEOUT' } },
      });

      await runtime.context.orchestration!.apply(
        createToolOperationManifest('deleted-read', {
          toolRef: { kind: 'BuiltinTool', name: 'slow.read' },
          effect: 'read',
          timeoutMs: 5000,
        }),
        { idempotencyKey: 'deleted-read' },
      );
      await vi.waitFor(() => {
        expect(calls).toBe(2);
        expect(observedSignal).toBeDefined();
      });
      await runtime.context.orchestration!.delete({
        apiVersion: 'execution.memeloop.io/v1alpha1',
        kind: 'ToolOperation',
        name: 'deleted-read',
      });
      await vi.waitFor(() => {
        expect(aborts).toBe(2);
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(calls).toBe(2);
      expect(
        await runtime.controlStore!.get({
          apiVersion: 'execution.memeloop.io/v1alpha1',
          kind: 'ToolOperation',
          name: 'deleted-read',
        }),
      ).toBeNull();
    } finally {
      await closeRuntime(runtime, dataDir);
    }
  });
});
