import { describe, expect, it, vi } from 'vitest';

import { ToolApprovalBroker, ToolApprovalCollisionError } from '../approval.js';
import type { ToolApprovalRequestInput } from '../types.js';

function request(
  runtimeId: string,
  overrides: Partial<ToolApprovalRequestInput> = {},
): ToolApprovalRequestInput {
  return {
    approvalId: 'approval-1',
    runtimeId,
    runId: 'run-1',
    conversationId: 'conversation-1',
    agentId: 'agent-1',
    toolName: 'tool-1',
    parameters: {},
    created: new Date(1),
    ...overrides,
  };
}

function resolvePending(
  broker: ToolApprovalBroker,
  approvalId: string,
  decision: 'allow' | 'deny',
): boolean {
  const pending = broker.getPendingApprovals().find(request => request.approvalId === approvalId);
  return pending ? broker.resolveApproval({ ...pending, decision }) : false;
}

describe('ToolApprovalBroker', () => {
  it('isolates identical approval IDs between runtimes', async () => {
    const first = new ToolApprovalBroker({ runtimeId: 'runtime-1' });
    const second = new ToolApprovalBroker({ runtimeId: 'runtime-2' });
    const firstDecision = first.requestApproval(request('runtime-1'), { timeoutMs: 0 });
    const secondDecision = second.requestApproval(request('runtime-2'), { timeoutMs: 0 });

    expect(first.getPendingApprovals()[0]?.parameterDigest).toBe(
      'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
    expect(resolvePending(first, 'approval-1', 'allow')).toBe(true);
    await expect(firstDecision).resolves.toBe('allow');
    expect(second.getPendingApprovals()).toHaveLength(1);
    second.dispose();
    await expect(secondDecision).resolves.toBe('deny');
  });

  it('rejects collisions without orphaning the first promise', async () => {
    const broker = new ToolApprovalBroker({ runtimeId: 'runtime-1' });
    const first = broker.requestApproval(request('runtime-1'), { timeoutMs: 0 });
    expect(() => broker.requestApproval(request('runtime-1'), { timeoutMs: 0 }))
      .toThrow(ToolApprovalCollisionError);
    expect(resolvePending(broker, 'approval-1', 'allow')).toBe(true);
    await expect(first).resolves.toBe('allow');
  });

  it('binds resolution to every runtime/run/conversation/agent/tool principal', async () => {
    const broker = new ToolApprovalBroker({ runtimeId: 'runtime-1' });
    const decision = broker.requestApproval(request('runtime-1'), { timeoutMs: 0 });
    const pending = broker.getPendingApprovals()[0];
    expect(broker.resolveApproval({
      ...pending,
      runId: 'other-run',
      decision: 'allow',
    })).toBe(false);
    expect(broker.getPendingApprovals()).toHaveLength(1);
    broker.cancelPendingApprovals({ runId: 'run-1' });
    await expect(decision).resolves.toBe('deny');
  });

  it('settles exactly once on abort, timeout, and late resolution', async () => {
    vi.useFakeTimers();
    try {
      const broker = new ToolApprovalBroker({ runtimeId: 'runtime-1' });
      const controller = new AbortController();
      const aborted = broker.requestApproval(request('runtime-1'), {
        signal: controller.signal,
        timeoutMs: 10,
      });
      controller.abort();
      await expect(aborted).resolves.toBe('deny');
      expect(resolvePending(broker, 'approval-1', 'allow')).toBe(false);

      const timedOut = broker.requestApproval(
        request('runtime-1', { approvalId: 'approval-2' }),
        { timeoutMs: 10 },
      );
      await vi.advanceTimersByTimeAsync(10);
      await expect(timedOut).resolves.toBe('deny');
      expect(resolvePending(broker, 'approval-2', 'allow')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('contains listener exceptions and reports them without leaking pending state', async () => {
    const onListenerError = vi.fn();
    const broker = new ToolApprovalBroker({ runtimeId: 'runtime-1', onListenerError });
    broker.onApprovalRequest(() => {
      throw new Error('broken listener');
    });
    const decision = broker.requestApproval(request('runtime-1'), { timeoutMs: 0 });
    expect(onListenerError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'broken listener' }),
      expect.objectContaining({ approvalId: 'approval-1' }),
    );
    expect(resolvePending(broker, 'approval-1', 'allow')).toBe(true);
    await expect(decision).resolves.toBe('allow');
    expect(broker.getPendingApprovals()).toEqual([]);
  });

  it('isolates a throwing listener-error observer without leaking pending state', async () => {
    const broker = new ToolApprovalBroker({
      runtimeId: 'runtime-1',
      onListenerError: () => {
        throw new Error('observer failed');
      },
    });
    broker.onApprovalRequest(() => {
      throw new Error('listener failed');
    });
    const decision = broker.requestApproval(request('runtime-1'), { timeoutMs: 0 });
    expect(broker.getPendingApprovals()).toHaveLength(1);
    expect(resolvePending(broker, 'approval-1', 'allow')).toBe(true);
    await expect(decision).resolves.toBe('allow');
  });

  it('binds a detached deep-frozen parameter snapshot and digest', async () => {
    const broker = new ToolApprovalBroker({ runtimeId: 'runtime-1' });
    const parameters = { nested: { path: '/safe' }, values: [1, 2] };
    let observed = broker.getPendingApprovals()[0];
    broker.onApprovalRequest(request => {
      observed = request;
    });
    const decision = broker.requestApproval(
      request('runtime-1', { parameters }),
      { timeoutMs: 0 },
    );
    parameters.nested.path = '/mutated';
    parameters.values.push(3);

    expect(observed?.parameters).toEqual({ nested: { path: '/safe' }, values: [1, 2] });
    expect(observed?.parameterDigest).toMatch(/^sha256:[\da-f]{64}$/u);
    expect(Object.isFrozen(observed?.parameters)).toBe(true);
    expect(Object.isFrozen(observed?.parameters.nested as object)).toBe(true);
    expect(broker.resolveApproval({
      ...observed,
      parameterDigest: `sha256:${'0'.repeat(64)}`,
      decision: 'allow',
    })).toBe(false);
    expect(broker.resolveApproval({ ...observed, decision: 'allow' })).toBe(true);
    await expect(decision).resolves.toBe('allow');
  });

  it('rejects cyclic, accessor, and oversized parameters before insertion', () => {
    const broker = new ToolApprovalBroker({ runtimeId: 'runtime-1' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let getterRuns = 0;
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        getterRuns += 1;
        return 'secret';
      },
    });

    expect(() => broker.requestApproval(request('runtime-1', { parameters: cyclic })))
      .toThrow('canonical_json_cycle');
    expect(() => broker.requestApproval(request('runtime-1', { parameters: accessor })))
      .toThrow('canonical_json_accessor_property');
    expect(getterRuns).toBe(0);
    expect(() =>
      broker.requestApproval(request('runtime-1', {
        parameters: { huge: 'x'.repeat(65 * 1024) },
      }))
    ).toThrow(/canonical_json_max_/u);
    expect(broker.getPendingApprovals()).toEqual([]);
  });
});
