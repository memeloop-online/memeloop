import { describe, expect, it, vi } from 'vitest';

import type { BuiltinToolContext } from '../../tools/builtins/types.js';
import type { IToolRegistry } from '../../types.js';
import { createToolOperationManifest } from '../resources.js';
import { createInProcessToolExecutionDriver } from '../toolExecutionDriver.js';

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
    const operation = createToolOperationManifest('op-1', {
      toolRef: { kind: 'BuiltinTool', name: 'echo' },
      effect: 'execute',
      arguments: { message: 'hello' },
      idempotencyKey: 'idem-1',
    }) as {
      apiVersion: string;
      kind: string;
      metadata: { name: string };
      spec: ReturnType<typeof createToolOperationManifest>['spec'];
      status?: { phase?: string; result?: { value?: unknown }; completedAt?: string };
    };

    const result = await driver.execute(operation as Parameters<typeof driver.execute>[0]);

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
    const operation = createToolOperationManifest('op-2', {
      toolRef: { kind: 'BuiltinTool', name: 'missing' },
      effect: 'execute',
    });

    const result = await driver.execute(operation as Parameters<typeof driver.execute>[0]);

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
    const operation = createToolOperationManifest('op-3', {
      toolRef: { kind: 'BuiltinTool', name: 'tool' },
      effect: 'execute',
      policy: { requireApproval: true },
    });

    const result = await driver.execute(operation as Parameters<typeof driver.execute>[0]);

    expect(result.status?.phase).toBe('Failed');
    expect(result.status?.result?.error?.code).toBe('FORBIDDEN');
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
    const operation = createToolOperationManifest('op-4', {
      toolRef: { kind: 'BuiltinTool', name: 'echo' },
      effect: 'execute',
    });

    await driver.execute(operation as Parameters<typeof driver.execute>[0]);

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
    const operation = createToolOperationManifest('op-5', {
      toolRef: { kind: 'BuiltinTool', name: 'echo' },
      effect: 'execute',
    });

    const result = await driver.execute(operation as Parameters<typeof driver.execute>[0]);

    const value = result.status?.result?.value as string;
    expect(value.length).toBe(103);
    expect(value.endsWith('...')).toBe(true);
  });
});
