import { describe, expect, it, vi } from 'vitest';

import { buildLayeredPermissions } from '../../loopAPI/agent-tool-loop/toolUseGate.js';
import { checkPermission } from '../../permission/index.js';
import type { BuiltinToolContext } from '../../tools/builtins/types.js';
import type { IToolRegistry } from '../../types.js';
import { createInProcessToolExecutionDriver } from '../drivers/toolExecutionDriver.js';
import { createSecurityProfileManifest, createToolOperationManifest, type ToolOperationResource } from '../resources.js';
import {
  defaultAdmissionPolicyForTrustClass,
  defaultPermissionActionForTrustClass,
  evaluateToolAdmission,
  resolveAdmissionPolicy,
  type ToolAdmissionPolicy,
} from '../security/admission.js';

function operationOf(toolName: string, effect: 'read' | 'execute' | 'delete' = 'execute'): ToolOperationResource {
  return createToolOperationManifest(`op-${toolName}`, {
    toolRef: { kind: 'BuiltinTool', name: toolName },
    effect,
  }) as ToolOperationResource;
}

describe('tool admission policy', () => {
  it('maps trust classes to default admission postures', () => {
    expect(defaultAdmissionPolicyForTrustClass('trusted').defaultAction).toBe('allow');
    expect(defaultAdmissionPolicyForTrustClass('restricted').defaultAction).toBe('deny');
    expect(defaultAdmissionPolicyForTrustClass('quarantine').defaultAction).toBe('deny');
  });

  it('maps trust classes to model-facing implied permission defaults', () => {
    expect(defaultPermissionActionForTrustClass('trusted')).toBe('allow');
    expect(defaultPermissionActionForTrustClass(undefined)).toBe('allow');
    expect(defaultPermissionActionForTrustClass('restricted')).toBe('deny');
    expect(defaultPermissionActionForTrustClass('quarantine')).toBe('deny');
  });

  it('evaluates rules first-match-wins with effect filtering', () => {
    const policy: ToolAdmissionPolicy = {
      defaultAction: 'deny',
      rules: [
        { toolPattern: 'file.*', effects: ['read'], action: 'allow' },
        { toolPattern: 'file.*', action: 'require-approval', reason: 'writes need approval' },
        { toolPattern: '*', effects: ['read'], action: 'allow' },
      ],
    };

    const readDecision = evaluateToolAdmission(policy, operationOf('file.read', 'read'));
    expect(readDecision.action).toBe('allow');
    expect(readDecision.source).toBe('rule');

    const writeDecision = evaluateToolAdmission(policy, operationOf('file.write', 'execute'));
    expect(writeDecision.action).toBe('require-approval');
    expect(writeDecision.reason).toBe('writes need approval');

    const otherRead = evaluateToolAdmission(policy, operationOf('web.search', 'read'));
    expect(otherRead.action).toBe('allow');

    const denied = evaluateToolAdmission(policy, operationOf('terminal.exec', 'execute'));
    expect(denied.action).toBe('deny');
    expect(denied.source).toBe('default');
  });

  it('driver denies operations rejected by trusted admission and audits the denial', async () => {
    const echo = vi.fn().mockResolvedValue({ summary: 'should-not-run' });
    const registry = {
      getTool: vi.fn().mockReturnValue(echo),
      listTools: vi.fn().mockReturnValue(['echo']),
      registerTool: vi.fn(),
    } as unknown as IToolRegistry;
    const auditor = vi.fn();
    const driver = createInProcessToolExecutionDriver(registry, {
      context: {
        storage: {} as unknown as BuiltinToolContext['storage'],
        llmProvider: { name: 'mock', chat: vi.fn() },
        tools: registry,
        syncAdapters: [],
        network: { start: vi.fn(), stop: vi.fn() },
      },
      admission: { defaultAction: 'deny', rules: [] },
      auditor,
    });

    const result = await driver.execute(operationOf('echo'));

    expect(result.status?.phase).toBe('Failed');
    expect(result.status?.result?.error?.code).toBe('FORBIDDEN');
    expect(echo).not.toHaveBeenCalled();
    expect(auditor).toHaveBeenCalledTimes(1);
    expect(auditor.mock.calls[0][1].error?.code).toBe('FORBIDDEN');
  });

  it('driver executes operations allowed by an admission rule', async () => {
    const echo = vi.fn().mockResolvedValue({ summary: 'echoed' });
    const registry = {
      getTool: vi.fn().mockReturnValue(echo),
      listTools: vi.fn().mockReturnValue(['echo']),
      registerTool: vi.fn(),
    } as unknown as IToolRegistry;
    const driver = createInProcessToolExecutionDriver(registry, {
      context: {
        storage: {} as unknown as BuiltinToolContext['storage'],
        llmProvider: { name: 'mock', chat: vi.fn() },
        tools: registry,
        syncAdapters: [],
        network: { start: vi.fn(), stop: vi.fn() },
      },
      admission: {
        defaultAction: 'deny',
        rules: [{ toolPattern: 'echo', action: 'allow' }],
      },
    });

    const result = await driver.execute(operationOf('echo'));

    expect(result.status?.phase).toBe('Completed');
    expect(echo).toHaveBeenCalledTimes(1);
  });

  it('driver fails require-approval admission decisions when no approval broker exists', async () => {
    const echo = vi.fn().mockResolvedValue({ summary: 'should-not-run' });
    const registry = {
      getTool: vi.fn().mockReturnValue(echo),
      listTools: vi.fn().mockReturnValue(['echo']),
      registerTool: vi.fn(),
    } as unknown as IToolRegistry;
    const driver = createInProcessToolExecutionDriver(registry, {
      context: {
        storage: {} as unknown as BuiltinToolContext['storage'],
        llmProvider: { name: 'mock', chat: vi.fn() },
        tools: registry,
        syncAdapters: [],
        network: { start: vi.fn(), stop: vi.fn() },
      },
      admission: {
        defaultAction: 'allow',
        rules: [{ toolPattern: 'terminal.*', action: 'require-approval', reason: 'terminal needs approval' }],
      },
    });

    const result = await driver.execute(operationOf('terminal.exec'));

    expect(result.status?.phase).toBe('Failed');
    expect(result.status?.result?.error?.code).toBe('FORBIDDEN');
    expect(result.status?.result?.error?.message).toBe(
      'terminal needs approval; no trusted approval broker is configured',
    );
    expect(echo).not.toHaveBeenCalled();
  });
});

describe('resolveAdmissionPolicy from SecurityProfile', () => {
  it('falls back to the trust-class default when no profile is given', () => {
    expect(resolveAdmissionPolicy(undefined, 'restricted').defaultAction).toBe('deny');
    expect(resolveAdmissionPolicy(undefined, 'trusted').defaultAction).toBe('allow');
  });

  it('forces deny default for restricted/quarantine even when the profile says allow', () => {
    const profile = {
      spec: {
        trustClass: 'quarantine' as const,
        toolAdmission: { defaultAction: 'allow' as const, rules: [] },
      },
    };
    expect(resolveAdmissionPolicy(profile, 'quarantine').defaultAction).toBe('deny');
    expect(resolveAdmissionPolicy(profile, 'restricted').defaultAction).toBe('deny');
  });

  it('lets profile rules allow specific tools on quarantine nodes', () => {
    const profile = {
      spec: {
        trustClass: 'quarantine' as const,
        toolAdmission: {
          defaultAction: 'deny' as const,
          rules: [{ toolPattern: 'asset.scan', action: 'allow' as const, reason: 'read-only inventory' }],
        },
      },
    };
    const policy = resolveAdmissionPolicy(profile, 'quarantine');
    expect(evaluateToolAdmission(policy, operationOf('asset.scan')).action).toBe('allow');
    expect(evaluateToolAdmission(policy, operationOf('terminal.exec')).action).toBe('deny');
  });

  it('honors the profile default for trusted nodes', () => {
    const profile = {
      spec: {
        trustClass: 'trusted' as const,
        toolAdmission: { defaultAction: 'require-approval' as const, rules: [] },
      },
    };
    expect(resolveAdmissionPolicy(profile, 'trusted').defaultAction).toBe('require-approval');
  });

  it('builds SecurityProfile manifests with the canonical apiVersion and kind', () => {
    const manifest = createSecurityProfileManifest('quarantine-remediate', {
      trustClass: 'quarantine',
      toolAdmission: { defaultAction: 'deny', rules: [] },
      modelPolicy: { allowedModelClasses: ['local-qwen'], maxInputClassification: 'internal' },
    });
    expect(manifest.apiVersion).toBe('security.memeloop.io/v1alpha1');
    expect(manifest.kind).toBe('SecurityProfile');
    expect(manifest.spec.modelPolicy?.maxInputClassification).toBe('internal');
  });
});

describe('model-facing permission layer defaults by trust class', () => {
  it('quarantine workers default to deny when no wildcard rule exists', () => {
    const merged = buildLayeredPermissions({ trustClass: 'quarantine' }, 'agent-1');
    expect(checkPermission('any-tool', merged)).toBe('deny');
  });

  it('restricted workers default to deny when no wildcard rule exists', () => {
    const merged = buildLayeredPermissions({ trustClass: 'restricted' }, 'agent-1');
    expect(checkPermission('any-tool', merged)).toBe('deny');
  });

  it('trusted workers keep the historical allow default', () => {
    const merged = buildLayeredPermissions({ trustClass: 'trusted' }, 'agent-1');
    expect(checkPermission('any-tool', merged)).toBe('allow');
  });

  it('explicit wildcard rules override the trust-class implied default', () => {
    const merged = buildLayeredPermissions(
      { trustClass: 'quarantine', toolPermissions: { default: 'allow' } },
      'agent-1',
    );
    expect(checkPermission('any-tool', merged)).toBe('allow');
  });
});
