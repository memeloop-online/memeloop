import { describe, expect, it } from 'vitest';

import { applyUnknownEffectDecision, reconcileUnknownEffect, TOOL_OPERATION_CONDITION_EFFECT_UNKNOWN } from '../drivers/unknownEffect.js';
import { createToolOperationManifest, type ToolOperationResource } from '../resources.js';

function operation(options: {
  effect?: 'read' | 'create' | 'update' | 'delete' | 'execute';
  idempotencyKey?: string;
  nonRetryable?: boolean;
  maxAttempts?: number;
  attempts?: number;
}): ToolOperationResource {
  const manifest = createToolOperationManifest('op-x', {
    toolRef: { kind: 'BuiltinTool', name: 'file.write' },
    effect: options.effect ?? 'execute',
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    ...(options.nonRetryable || options.maxAttempts
      ? {
        retry: {
          ...(options.nonRetryable ? { nonRetryable: true } : {}),
          ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
        },
      }
      : {}),
  });
  return {
    ...manifest,
    metadata: {
      name: 'op-x',
      uid: 'uid-op-x',
      generation: 1,
      resourceVersion: '3',
      creationTimestamp: new Date().toISOString(),
    },
    status: options.attempts ? { phase: 'Running', attempts: options.attempts } : { phase: 'Running' },
  } as ToolOperationResource;
}

describe('reconcileUnknownEffect', () => {
  it('marks operations with an observed result as succeeded', () => {
    const decision = reconcileUnknownEffect(operation({}), { resultObserved: true });
    expect(decision.action).toBe('succeeded');
  });

  it('retries read effects within the attempt budget', () => {
    const decision = reconcileUnknownEffect(operation({ effect: 'read', attempts: 1 }), {});
    expect(decision.action).toBe('retry');
  });

  it('requires verification when the read retry budget is exhausted', () => {
    const decision = reconcileUnknownEffect(operation({ effect: 'read', attempts: 3, maxAttempts: 3 }), {});
    expect(decision.action).toBe('verification-required');
  });

  it('never repeats nonRetryable operations', () => {
    const decision = reconcileUnknownEffect(
      operation({ nonRetryable: true, idempotencyKey: 'k-1' }),
      {},
    );
    expect(decision.action).toBe('manual-intervention');
  });

  it('retries idempotent destructive operations within the attempt budget', () => {
    const decision = reconcileUnknownEffect(operation({ effect: 'delete', idempotencyKey: 'k-1', attempts: 1 }), {});
    expect(decision.action).toBe('retry');
    expect(decision.reason).toContain('idempotencyKey');
  });

  it('requires verification for destructive operations without idempotency', () => {
    const decision = reconcileUnknownEffect(operation({ effect: 'delete' }), {});
    expect(decision.action).toBe('verification-required');
  });
});

describe('applyUnknownEffectDecision', () => {
  it('requeues retries as Pending with the EffectUnknown condition', () => {
    const op = operation({ effect: 'read', attempts: 1 });
    const decision = reconcileUnknownEffect(op, {});
    const next = applyUnknownEffectDecision(op, decision, '2026-07-16T00:00:00.000Z');

    expect(next.status?.phase).toBe('Pending');
    const condition = next.status?.conditions?.find((c) => c.type === TOOL_OPERATION_CONDITION_EFFECT_UNKNOWN);
    expect(condition).toMatchObject({ status: 'True', reason: 'retry', lastTransitionTime: '2026-07-16T00:00:00.000Z' });
  });

  it('completes succeeded operations', () => {
    const op = operation({});
    const next = applyUnknownEffectDecision(
      op,
      { action: 'succeeded', reason: 'observed' },
      '2026-07-16T00:00:00.000Z',
    );
    expect(next.status?.phase).toBe('Completed');
    expect(next.status?.completedAt).toBe('2026-07-16T00:00:00.000Z');
  });

  it('keeps verification-required operations Running without repeating them', () => {
    const op = operation({ effect: 'delete' });
    const decision = reconcileUnknownEffect(op, {});
    const next = applyUnknownEffectDecision(op, decision);

    expect(next.status?.phase).toBe('Running');
    const condition = next.status?.conditions?.find((c) => c.type === TOOL_OPERATION_CONDITION_EFFECT_UNKNOWN);
    expect(condition?.reason).toBe('verification-required');
  });

  it('replaces a previous EffectUnknown condition instead of accumulating duplicates', () => {
    const op = operation({ effect: 'read', attempts: 1 });
    const first = applyUnknownEffectDecision(op, { action: 'retry', reason: 'first' });
    const second = applyUnknownEffectDecision(first, { action: 'verification-required', reason: 'second' });

    const conditions = second.status?.conditions?.filter((c) => c.type === TOOL_OPERATION_CONDITION_EFFECT_UNKNOWN);
    expect(conditions).toHaveLength(1);
    expect(conditions?.[0].reason).toBe('verification-required');
  });
});
