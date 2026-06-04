import { describe, expect, it, vi } from 'vitest';

import { cancelPendingApprovals, evaluateApproval, getPendingApprovals, onApprovalRequest, requestApproval, resolveApproval } from '../approval.js';

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
    const off = onApprovalRequest(listener);
    try {
      const p = requestApproval(
        { approvalId: 'a1', agentId: 'ag1', toolName: 't', parameters: { a: 1 } } as any,
        0,
      );
      expect(listener).toHaveBeenCalledTimes(1);
      expect(getPendingApprovals()).toHaveLength(1);

      resolveApproval('a1', 'allow');
      await expect(p).resolves.toBe('allow');
      expect(getPendingApprovals()).toHaveLength(0);
    } finally {
      off();
    }
  });

  it('requestApproval ignores listener errors', async () => {
    const off = onApprovalRequest(() => {
      throw new Error('boom');
    });
    try {
      const p = requestApproval({ approvalId: 'a2', agentId: 'ag1', toolName: 't', parameters: {} } as any, 0);
      resolveApproval('a2', 'deny');
      await expect(p).resolves.toBe('deny');
    } finally {
      off();
    }
  });

  it('requestApproval times out to deny when still pending', async () => {
    vi.useFakeTimers();
    try {
      const p = requestApproval({ approvalId: 'a3', agentId: 'ag1', toolName: 't', parameters: {} } as any, 10);
      expect(getPendingApprovals()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(11);
      await expect(p).resolves.toBe('deny');
      expect(getPendingApprovals()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancelPendingApprovals denies only matching agent', async () => {
    const p1 = requestApproval({ approvalId: 'b1', agentId: 'ag1', toolName: 't', parameters: {} } as any, 0);
    const p2 = requestApproval({ approvalId: 'b2', agentId: 'ag2', toolName: 't', parameters: {} } as any, 0);

    cancelPendingApprovals('ag1');
    await expect(p1).resolves.toBe('deny');
    resolveApproval('b2', 'allow');
    await expect(p2).resolves.toBe('allow');
  });
});
