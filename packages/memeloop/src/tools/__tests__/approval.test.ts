import { describe, expect, it, vi } from 'vitest';

import { evaluateApproval, ToolApprovalBroker } from '../approval.js';
import type { ToolApprovalRequestInput } from '../types.js';

function request(overrides: Partial<ToolApprovalRequestInput> = {}): ToolApprovalRequestInput {
  return {
    approvalId: 'approval-1',
    runtimeId: 'runtime-1',
    runId: 'run-1',
    conversationId: 'conversation-1',
    agentId: 'agent-1',
    toolName: 'tool-1',
    parameters: {},
    created: new Date(1),
    ...overrides,
  };
}

function resolvePending(broker: ToolApprovalBroker, decision: 'allow' | 'deny'): boolean {
  const pending = broker.getPendingApprovals()[0];
  if (!pending) return false;
  return broker.resolveApproval({ ...pending, decision });
}

describe('approval', () => {
  it('evaluateApproval returns allow for missing/auto config', () => {
    expect(evaluateApproval(undefined, 't', {})).toBe('allow');
    expect(evaluateApproval({ mode: 'auto' } as any, 't', {})).toBe('allow');
  });

  it('evaluateApproval matches denyPatterns/allowPatterns and ignores invalid regex', () => {
    const cfg = {
      mode: 'manual',
      denyPatterns: ['\\bdelete\\b', '('], // second invalid
      allowPatterns: ['\\bread\\b'],
    } as any;

    expect(evaluateApproval(cfg, 'fs.delete', { path: '/a' })).toBe('deny');
    expect(evaluateApproval(cfg, 'fs.read', { path: '/a' })).toBe('allow');
    expect(evaluateApproval(cfg, 'other', { x: 1 })).toBe('pending');
  });

  it('requestApproval notifies listeners and resolveApproval completes', async () => {
    const listener = vi.fn();
    const broker = new ToolApprovalBroker({ runtimeId: 'runtime-1' });
    const off = broker.onApprovalRequest(listener);
    try {
      const p = broker.requestApproval(
        request({ approvalId: 'a1', agentId: 'ag1', toolName: 't', parameters: { a: 1 } }),
        { timeoutMs: 0 },
      );
      expect(listener).toHaveBeenCalledTimes(1);
      expect(broker.getPendingApprovals()).toHaveLength(1);

      expect(resolvePending(broker, 'allow')).toBe(true);
      await expect(p).resolves.toBe('allow');
      expect(broker.getPendingApprovals()).toHaveLength(0);
    } finally {
      off();
    }
  });

  it('requestApproval ignores listener errors', async () => {
    const broker = new ToolApprovalBroker({ runtimeId: 'runtime-1' });
    const off = broker.onApprovalRequest(() => {
      throw new Error('boom');
    });
    try {
      const p = broker.requestApproval(request({ approvalId: 'a2', agentId: 'ag1', toolName: 't' }), { timeoutMs: 0 });
      expect(resolvePending(broker, 'deny')).toBe(true);
      await expect(p).resolves.toBe('deny');
    } finally {
      off();
    }
  });

  it('requestApproval times out to deny when still pending', async () => {
    vi.useFakeTimers();
    try {
      const broker = new ToolApprovalBroker({ runtimeId: 'runtime-1' });
      const p = broker.requestApproval(request({ approvalId: 'a3', agentId: 'ag1', toolName: 't' }), { timeoutMs: 10 });
      expect(broker.getPendingApprovals()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(11);
      await expect(p).resolves.toBe('deny');
      expect(broker.getPendingApprovals()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancelPendingApprovals denies only matching agent', async () => {
    const broker = new ToolApprovalBroker({ runtimeId: 'runtime-1' });
    const p1 = broker.requestApproval(request({ approvalId: 'b1', agentId: 'ag1', toolName: 't' }), { timeoutMs: 0 });
    const p2 = broker.requestApproval(request({ approvalId: 'b2', agentId: 'ag2', toolName: 't' }), { timeoutMs: 0 });

    expect(broker.cancelPendingApprovals({ agentId: 'ag1' })).toBe(1);
    await expect(p1).resolves.toBe('deny');
    expect(resolvePending(broker, 'allow')).toBe(true);
    await expect(p2).resolves.toBe('allow');
  });

  it('fails closed without executing accessors or toJSON for hostile parameters', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let getterRuns = 0;
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        getterRuns += 1;
        return 'delete';
      },
    });
    let toJsonRuns = 0;
    const withToJson = {
      value: 'read',
      toJSON: () => {
        toJsonRuns += 1;
        return { value: 'read' };
      },
    };
    const auto = { mode: 'auto' } as const;

    expect(evaluateApproval(auto, 'tool', cyclic)).toBe('deny');
    expect(evaluateApproval(auto, 'tool', accessor)).toBe('deny');
    expect(evaluateApproval(auto, 'tool', { value: 1n })).toBe('deny');
    expect(evaluateApproval(auto, 'tool', withToJson)).toBe('deny');
    expect(evaluateApproval(auto, 'tool', { huge: 'x'.repeat(65 * 1024) })).toBe('deny');
    expect(getterRuns).toBe(0);
    expect(toJsonRuns).toBe(0);
  });
});
