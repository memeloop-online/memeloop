import { describe, expect, it, vi } from 'vitest';

import type { BuiltinToolContext } from '../../tools/builtins/types.js';
import type { IToolRegistry } from '../../types.js';
import { createInProcessToolExecutionDriver, type ToolOperationApprovalDecision } from '../drivers/toolExecutionDriver.js';
import { createToolOperationManifest, type ToolOperationResource, type ToolOperationSpec } from '../resources.js';

function createToolOperationResource(name: string, spec: ToolOperationSpec): ToolOperationResource {
  const manifest = createToolOperationManifest(name, spec);
  return {
    ...manifest,
    metadata: {
      name,
      namespace: 'default',
      uid: `uid-${name}`,
      generation: 1,
      resourceVersion: '1',
      creationTimestamp: '2026-07-26T08:00:00.000Z',
    },
  };
}

describe('createInProcessToolExecutionDriver', () => {
  function createMinimalBuiltinContext(): BuiltinToolContext {
    return {
      storage: {} as unknown as BuiltinToolContext['storage'],
      llmProvider: { name: 'mock', chat: vi.fn().mockResolvedValue([]) },
      tools: { registerTool: vi.fn(), getTool: vi.fn(), listTools: vi.fn().mockReturnValue([]) },
      syncAdapters: [],
      network: { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) },
    };
  }

  it('executes a registered tool and returns a Completed ToolOperation', async () => {
    const echo = vi.fn().mockResolvedValue({ summary: 'echoed' });
    const registry = {
      getTool: vi.fn().mockReturnValue(echo),
      listTools: vi.fn().mockReturnValue(['echo']),
      registerTool: vi.fn(),
    } as unknown as IToolRegistry;
    const driver = createInProcessToolExecutionDriver(registry, { context: createMinimalBuiltinContext() });
    const operation = createToolOperationResource('op-1', {
      toolRef: { kind: 'BuiltinTool', name: 'echo' },
      effect: 'execute',
      arguments: { message: 'hello' },
      idempotencyKey: 'idem-1',
    });

    const result = await driver.execute(operation);

    expect(result.status?.phase).toBe('Completed');
    expect(result.status?.result?.value).toEqual({ summary: 'echoed' });
    expect(echo).toHaveBeenCalledWith({ message: 'hello' }, expect.any(Object));
  });

  it('returns Failed when the tool is not found', async () => {
    const registry = {
      getTool: vi.fn().mockReturnValue(undefined),
      listTools: vi.fn().mockReturnValue([]),
      registerTool: vi.fn(),
    } as unknown as IToolRegistry;
    const driver = createInProcessToolExecutionDriver(registry, { context: createMinimalBuiltinContext() });
    const operation = createToolOperationResource('op-2', {
      toolRef: { kind: 'BuiltinTool', name: 'missing' },
      effect: 'execute',
    });

    const result = await driver.execute(operation);

    expect(result.status?.phase).toBe('Failed');
    expect(result.status?.result?.error?.code).toBe('UNSUPPORTED');
  });

  it('returns Failed when approval is required', async () => {
    const registry = {
      getTool: vi.fn().mockReturnValue(vi.fn()),
      listTools: vi.fn().mockReturnValue(['tool']),
      registerTool: vi.fn(),
    } as unknown as IToolRegistry;
    const driver = createInProcessToolExecutionDriver(registry, { context: createMinimalBuiltinContext() });
    const operation = createToolOperationResource('op-3', {
      toolRef: { kind: 'BuiltinTool', name: 'tool' },
      effect: 'execute',
      policy: { requireApproval: true },
    });

    const result = await driver.execute(operation);

    expect(result.status?.phase).toBe('Failed');
    expect(result.status?.result?.error?.code).toBe('FORBIDDEN');
  });

  it('executes only after a trusted approval and persists auditable evidence', async () => {
    const tool = vi.fn().mockResolvedValue('approved');
    const registry = {
      getTool: vi.fn().mockReturnValue(tool),
      listTools: vi.fn().mockReturnValue(['tool']),
      registerTool: vi.fn(),
    } as unknown as IToolRegistry;
    const auditor = vi.fn();
    const approvalBroker = {
      requestApproval: vi.fn().mockResolvedValue({
        approvalId: 'approval-1',
        decision: 'allow' as const,
        actor: 'user:alice',
        decidedAt: '2026-07-26T08:00:00.000Z',
        reason: 'reviewed',
      }),
    };
    const driver = createInProcessToolExecutionDriver(registry, {
      context: createMinimalBuiltinContext(),
      approvalBroker,
      auditor,
    });
    const operation = createToolOperationResource('op-approved', {
      toolRef: { kind: 'BuiltinTool', name: 'tool' },
      effect: 'execute',
      policy: { requireApproval: true },
    });

    const result = await driver.execute(operation);

    expect(approvalBroker.requestApproval).toHaveBeenCalledWith({
      operation: expect.objectContaining({
        metadata: expect.objectContaining({ name: 'op-approved' }),
        status: expect.objectContaining({ phase: 'Running', attempts: 1 }),
      }),
      reason: 'ToolOperation policy requires approval',
      signal: undefined,
    });
    expect(tool).toHaveBeenCalledOnce();
    expect(result.status).toMatchObject({
      phase: 'Completed',
      approval: {
        approvalId: 'approval-1',
        decision: 'allow',
        actor: 'user:alice',
        decidedAt: '2026-07-26T08:00:00.000Z',
        reason: 'reviewed',
      },
    });
    expect(auditor).toHaveBeenCalledWith(
      expect.objectContaining({
        status: expect.objectContaining({
          approval: expect.objectContaining({ approvalId: 'approval-1', decision: 'allow' }),
        }),
      }),
      expect.objectContaining({ value: 'approved' }),
    );
  });

  it('does not execute after denial and persists the denial evidence', async () => {
    const tool = vi.fn();
    const registry = {
      getTool: vi.fn().mockReturnValue(tool),
      listTools: vi.fn().mockReturnValue(['tool']),
      registerTool: vi.fn(),
    } as unknown as IToolRegistry;
    const driver = createInProcessToolExecutionDriver(registry, {
      context: createMinimalBuiltinContext(),
      approvalBroker: {
        requestApproval: vi.fn().mockResolvedValue({
          approvalId: 'approval-denied',
          decision: 'deny',
          actor: 'user:bob',
          decidedAt: '2026-07-26T08:01:00.000Z',
          reason: 'unsafe arguments',
        }),
      },
    });
    const operation = createToolOperationResource('op-denied', {
      toolRef: { kind: 'BuiltinTool', name: 'tool' },
      effect: 'execute',
      policy: { requireApproval: true },
    });

    const result = await driver.execute(operation);

    expect(tool).not.toHaveBeenCalled();
    expect(result.status).toMatchObject({
      phase: 'Failed',
      approval: {
        approvalId: 'approval-denied',
        decision: 'deny',
        actor: 'user:bob',
      },
      result: { error: { code: 'FORBIDDEN', message: 'unsafe arguments' } },
    });
  });

  it('fails closed when the approval broker returns invalid evidence', async () => {
    const tool = vi.fn();
    const registry = {
      getTool: vi.fn().mockReturnValue(tool),
      listTools: vi.fn().mockReturnValue(['tool']),
      registerTool: vi.fn(),
    } as unknown as IToolRegistry;
    const driver = createInProcessToolExecutionDriver(registry, {
      context: createMinimalBuiltinContext(),
      approvalBroker: {
        requestApproval: vi.fn().mockResolvedValue({
          approvalId: '',
          decision: 'allow',
          actor: '',
          decidedAt: 'not-a-date',
        }),
      },
    });
    const operation = createToolOperationResource('op-invalid-approval', {
      toolRef: { kind: 'BuiltinTool', name: 'tool' },
      effect: 'execute',
      policy: { requireApproval: true },
    });

    const result = await driver.execute(operation);

    expect(tool).not.toHaveBeenCalled();
    expect(result.status?.result?.error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Trusted approval broker returned invalid evidence',
    });
  });

  it('fails closed when the approval broker throws', async () => {
    const tool = vi.fn();
    const registry = {
      getTool: vi.fn().mockReturnValue(tool),
      listTools: vi.fn().mockReturnValue(['tool']),
      registerTool: vi.fn(),
    } as unknown as IToolRegistry;
    const driver = createInProcessToolExecutionDriver(registry, {
      context: createMinimalBuiltinContext(),
      approvalBroker: {
        requestApproval: vi.fn().mockRejectedValue(new Error('broker offline')),
      },
    });
    const operation = createToolOperationResource('op-broker-error', {
      toolRef: { kind: 'BuiltinTool', name: 'tool' },
      effect: 'execute',
      policy: { requireApproval: true },
    });

    const result = await driver.execute(operation);

    expect(tool).not.toHaveBeenCalled();
    expect(result.status?.result?.error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Trusted approval broker failed closed',
    });
  });

  it('does not execute when cancellation happens while approval is pending', async () => {
    const tool = vi.fn();
    const registry = {
      getTool: vi.fn().mockReturnValue(tool),
      listTools: vi.fn().mockReturnValue(['tool']),
      registerTool: vi.fn(),
    } as unknown as IToolRegistry;
    let resolveApproval!: (decision: ToolOperationApprovalDecision) => void;
    const requestApproval = vi.fn().mockReturnValue(
      new Promise<ToolOperationApprovalDecision>((resolve) => {
        resolveApproval = resolve;
      }),
    );
    const driver = createInProcessToolExecutionDriver(registry, {
      context: createMinimalBuiltinContext(),
      approvalBroker: { requestApproval },
    });
    const operation = createToolOperationResource('op-cancelled-approval', {
      toolRef: { kind: 'BuiltinTool', name: 'tool' },
      effect: 'execute',
      policy: { requireApproval: true },
    });
    const abortController = new AbortController();

    const pending = driver.execute(operation, { signal: abortController.signal });
    await vi.waitFor(() => {
      expect(requestApproval).toHaveBeenCalledOnce();
    });
    abortController.abort();
    resolveApproval({
      approvalId: 'late-approval',
      decision: 'allow',
      actor: 'user:alice',
      decidedAt: '2026-07-26T08:03:00.000Z',
    });
    const result = await pending;

    expect(tool).not.toHaveBeenCalled();
    expect(registry.getTool).not.toHaveBeenCalled();
    expect(result.status).toMatchObject({
      phase: 'Failed',
      approval: { approvalId: 'late-approval', decision: 'allow' },
      result: { error: { code: 'CANCELLED' } },
    });
  });

  it('calls the auditor with the running operation and result', async () => {
    const echo = vi.fn().mockResolvedValue('ok');
    const registry = {
      getTool: vi.fn().mockReturnValue(echo),
      listTools: vi.fn().mockReturnValue(['echo']),
      registerTool: vi.fn(),
    } as unknown as IToolRegistry;
    const auditor = vi.fn();
    const driver = createInProcessToolExecutionDriver(registry, {
      context: createMinimalBuiltinContext(),
      auditor,
    });
    const operation = createToolOperationResource('op-4', {
      toolRef: { kind: 'BuiltinTool', name: 'echo' },
      effect: 'execute',
    });

    await driver.execute(operation);

    expect(auditor).toHaveBeenCalledOnce();
    expect(auditor).toHaveBeenCalledWith(
      expect.objectContaining({ spec: expect.objectContaining({ effect: 'execute' }) }),
      expect.objectContaining({ value: 'ok' }),
    );
  });

  it('truncates long string outputs', async () => {
    const longText = 'x'.repeat(3000);
    const echo = vi.fn().mockResolvedValue(longText);
    const registry = {
      getTool: vi.fn().mockReturnValue(echo),
      listTools: vi.fn().mockReturnValue(['echo']),
      registerTool: vi.fn(),
    } as unknown as IToolRegistry;
    const driver = createInProcessToolExecutionDriver(registry, {
      context: createMinimalBuiltinContext(),
      maxOutputLength: 100,
    });
    const operation = createToolOperationResource('op-5', {
      toolRef: { kind: 'BuiltinTool', name: 'echo' },
      effect: 'execute',
    });

    const result = await driver.execute(operation);

    const value = result.status?.result?.value as string;
    expect(value.length).toBe(103);
    expect(value.endsWith('...')).toBe(true);
  });

  it('propagates cooperative cancellation through BuiltinToolContext', async () => {
    const observedSignal = vi.fn();
    const tool = vi.fn(async (_arguments, context: BuiltinToolContext) =>
      await new Promise((_resolve, reject) => {
        observedSignal(context.operationSignal);
        context.operationSignal?.addEventListener(
          'abort',
          () => {
            reject(new DOMException('cancelled', 'AbortError'));
          },
          { once: true },
        );
      })
    );
    const registry = {
      getTool: vi.fn().mockReturnValue(tool),
      listTools: vi.fn().mockReturnValue(['slow-read']),
      registerTool: vi.fn(),
    } as unknown as IToolRegistry;
    const driver = createInProcessToolExecutionDriver(registry, {
      context: createMinimalBuiltinContext(),
    });
    const operation = createToolOperationResource('op-cancel', {
      toolRef: { kind: 'BuiltinTool', name: 'slow-read' },
      effect: 'read',
    });
    const abortController = new AbortController();

    const pending = driver.execute(operation, { signal: abortController.signal });
    await vi.waitFor(() => {
      expect(observedSignal).toHaveBeenCalledWith(abortController.signal);
    });
    abortController.abort();
    const result = await pending;

    expect(result.status?.phase).toBe('Failed');
    expect(result.status?.result?.error?.code).toBe('CANCELLED');
  });
});
